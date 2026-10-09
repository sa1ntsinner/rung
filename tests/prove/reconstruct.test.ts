// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceIndex } from "../../packages/lsp/src/index.js";
import { reconstructCycle, reconstructionRevision } from "../../packages/sim/src/index.js";

it("replays complete native begin/end fixture samples and preserves an untaken quotient", async () => {
  const root = mkdtempSync(join(tmpdir(), "rung-native-capture-"));
  const blocks = join(root, "plc", "PLC_1", "blocks"); mkdirSync(blocks, { recursive: true });
  try {
    const file = join(blocks, "FB_ProveOps.scl");
    cpSync(resolve("tools/prove/corpus/FB_ProveOps.scl"), file);
    writeFileSync(join(blocks, "ProveOps_DB.db"), 'DATA_BLOCK "ProveOps_DB"\n"FB_ProveOps"\nBEGIN\nEND_DATA_BLOCK');
    const index = new WorkspaceIndex(); await index.load(root);
    const uri = pathToFileURL(file).href, scope = { plc: "PLC_1", instance: '"ProveOps_DB"', epoch: 1 };
    const states = JSON.parse(readFileSync(resolve("tools/prove/captures/tis-prepost.json"), "utf8")).observations;
    expect(states).toHaveLength(3);
    for (const sample of states) {
      const capture = { scope, sourceRevision: reconstructionRevision(index, uri), time: 0, clockStart: 0,
        coherence: "subscription-sample" as const, before: { mem: sample.before, globals: {} }, observed: sample.after };
      expect(Object.keys(sample.before)).toHaveLength(35);
      const replay = reconstructCycle(index, uri, capture, scope);
      expect(replay.divergences).toEqual([]);
      expect(replay).toMatchObject({ exact: false, coherence: "subscription-sample" });
      if (sample.before.A === 5 && sample.before.B === 0) {
        expect(sample.before.QUOT).toBe(2);
        expect(replay.after.QUOT).toBe(2);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("replays real captured array/struct/multi-instance cycles and reports an altered observation", () => {
  const root = mkdtempSync(join(tmpdir(), "rung-captured-cycles-"));
  const blocks = join(root, "plc", "PLC_1", "blocks"); mkdirSync(blocks, { recursive: true });
  try {
    for (const name of ["Data", "More", "Math", "Inner"]) cpSync(resolve(`tools/prove/corpus/FB_Prove${name}.scl`), join(blocks, `FB_Prove${name}.scl`));
    cpSync(resolve("tools/prove/corpus/FC_ProveAdd.scl"), join(blocks, "FC_ProveAdd.scl"));
    for (const name of ["Data", "More", "Math"]) {
      writeFileSync(join(blocks, `Prove${name}_DB.db`), `DATA_BLOCK "Prove${name}_DB"\n"FB_Prove${name}"\nBEGIN\nEND_DATA_BLOCK`);
      const r = spawnSync(process.execPath, [resolve("tools/prove/reconstruct.mjs"), root, `plc/PLC_1/blocks/FB_Prove${name}.scl`, `Prove${name}_DB`, resolve(`tools/prove/captures/${name.toLowerCase()}.json`), join(root, name)], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const cycle = JSON.parse(readFileSync(join(root, name, "cycle-1.json"), "utf8"));
      expect(cycle.coherence).toBe("controlled-cycle");
      expect(cycle.scope.instance).toBe(`"Prove${name}_DB"`);
      expect(cycle.before.mem).not.toEqual(cycle.observed);
      expect(cycle.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(r.stdout.trim().split("\n").map(s => JSON.parse(s).divergences)).toEqual(name === "Math" ? [[], [], []] : [[], []]);
    }
    const raw = JSON.parse(readFileSync(resolve("tools/prove/captures/math.json"), "utf8"));
    raw.cases[0].steps[0].values.COUNTED++;
    const capture = join(root, "divergent.json"); writeFileSync(capture, JSON.stringify(raw));
    const r = spawnSync(process.execPath, [resolve("tools/prove/reconstruct.mjs"), root, "plc/PLC_1/blocks/FB_ProveMath.scl", "ProveMath_DB", capture], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(2);
    expect(JSON.parse(r.stdout.split("\n")[0]!).divergences).toEqual([{ path: "COUNTED", reconstructed: 2, observed: 3 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

