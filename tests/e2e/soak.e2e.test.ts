// SPDX-License-Identifier: BUSL-1.1
// Randomized two-way soak against the fixture project in a real TIA Portal. One person edits files, another
// edits the same blocks in TIA Portal (a second Openness client), rung sync runs after every step and is
// killed at random moments (Ctrl+C, a crash). Nothing typed on either side may get lost, no conflict may
// appear (the two people never touch the same line), and the workspace ends quiet and equal to TIA Portal.
//   RUNG_E2E_SOAK=1 [RUNG_SOAK_MINUTES=30] [RUNG_SOAK_SEED=1] pnpm vitest run tests/e2e/soak.e2e.test.ts
import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BridgeClient, BridgeError } from "../../packages/bridge-client/src/index.js";

const enabled = process.env.RUNG_E2E_SOAK === "1";
const minutes = Number(process.env.RUNG_SOAK_MINUTES ?? 30);
const seed = Number(process.env.RUNG_SOAK_SEED ?? 1);
const project = process.env.RUNG_PROJECT ?? join(homedir(), "rung-fixtures", "RungFixture", "RungFixture.ap20");
const repo = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(repo, "packages", "cli", "dist", "index.js");
const bridgeExe = join(repo, "bridge", "src", "Rung.Bridge.V20", "bin", "Release", "net48", "rung-bridge-v20.exe");

const NAMES = ["A", "B", "C", "D", "E", "F"];
const addr = (n: string) => `plc:PLC_1/blocks/90_Soak/Fx_Soak_${n}`;
const rel = (n: string) => `plc/PLC_1/blocks/90_Soak/Fx_Soak_${n}.scl`;
const source = (n: string, l1: number) =>
  `FUNCTION "Fx_Soak_${n}" : Void\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\n   VAR_TEMP \n      l1 : Int;\n      l2 : Int;\n      l3 : Int;\n      l4 : Int;\n   END_VAR\n\n\nBEGIN\n\t#l1 := ${l1};\n\t#l2 := 2;\n\t#l3 := 3;\n\t#l4 := 0;\nEND_FUNCTION\n`;
// #l2 and #l3 keep the two people's lines apart: a line merge, like git's, joins changes on neighbouring lines
const counts = (out: string) => {
  const m = /exported (\d+)\s+imported (\d+)\s+created (\d+)\s+merged (\d+)\s+conflicts (\d+)/.exec(out);
  return m ? { exported: +m[1]!, imported: +m[2]!, created: +m[3]!, merged: +m[4]!, conflicts: +m[5]! } : undefined;
};

function rng(s: number) {
  let x = s >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe.runIf(enabled)("soak: real TIA Portal, two people, killed syncs", () => {
  it(`${minutes} minutes stay consistent and lose nothing`, async () => {
    const rand = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const ws = mkdtempSync(join(tmpdir(), "rung-soak-"));
    const logFile = join(ws, "soak.log");
    const log = (s: string) => appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`);
    console.log(`soak workspace ${ws} (log: ${logFile}), seed ${seed}, ${minutes} min`);

    const run = (args: string[], killAfterMs?: number) =>
      new Promise<{ code: number | null; out: string; killed: boolean }>((done) => {
        const child = spawn(process.execPath, [cli, ...args], { cwd: ws, windowsHide: true, env: { ...process.env, RUNG_DEBUG: "" } });
        let out = "";
        let killed = false;
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        const kill = () => {
          killed = true;
          spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true }); // like closing the terminal
        };
        const killer = killAfterMs !== undefined ? setTimeout(kill, killAfterMs) : undefined;
        const hang = setTimeout(() => {
          out += "\n[soak: no answer after 5 minutes]";
          kill();
        }, 300_000);
        child.on("close", (code) => {
          clearTimeout(killer);
          clearTimeout(hang);
          done({ code, out, killed });
        });
      });

    // the other person, in TIA Portal
    const user = await BridgeClient.spawn({ command: bridgeExe, args: ["--project", project, "--allow-fixture-import"] });
    const problems: string[] = [];
    const exists = new Map<string, boolean>();
    const l1 = new Map<string, number>();
    const l4 = new Map<string, number>();
    let counter = 1;
    try {
      // leftovers of an earlier run
      for (const e of await user.listObjects("PLC_1"))
        if (e.address.startsWith("plc:PLC_1/blocks/90_Soak/")) await user.deleteObject(e.address, e.fingerprint, randomUUID());

      expect((await run(["init", "--project", project])).code).toBe(0);
      expect([0, 2]).toContain((await run(["pull"])).code);

      const tiaEdit = async (n: string, v: number): Promise<boolean> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          // a create that a kill interrupted reaches TIA Portal only with the next sync
          if (!(await user.listObjects("PLC_1")).some((e) => e.address === addr(n))) return false;
          let r;
          try {
            r = await user.exportObject(addr(n), "auto", mkdtempSync(join(tmpdir(), "rung-soak-tia-")));
          } catch (e) {
            // an import replaces the block: for a moment the other Openness client finds none
            if (e instanceof BridgeError && e.code === "NOT_FOUND") continue;
            throw e;
          }
          const p = r.files.find((f) => f.role === "primary")!.path;
          writeFileSync(p, readFileSync(p, "utf8").replace(/#l4 := -?\d+;/, `#l4 := ${v};`));
          try {
            await user.importObject(addr(n), "scl", p, r.fingerprint, randomUUID());
            l4.set(n, v);
            return true;
          } catch (e) {
            if (e instanceof BridgeError && (e.code === "STALE_REVISION" || e.code === "NOT_FOUND")) continue; // rung imported meanwhile
            throw e;
          }
        }
        return false;
      };
      const fileEdit = (n: string, v: number) => {
        const p = join(ws, ...rel(n).split("/"));
        writeFileSync(p, readFileSync(p, "utf8").replace(/#l1 := -?\d+;/, `#l1 := ${v};`));
        l1.set(n, v);
      };
      const sync = async (what: string, killAfterMs?: number) => {
        const r = await run(["sync"], killAfterMs);
        const c = counts(r.out);
        log(`${what}: ${r.killed ? `killed after ${killAfterMs} ms` : `exit ${r.code}`} ${c ? JSON.stringify(c) : ""}`);
        if (!r.killed && (r.code === null || r.code > 2 || !c)) problems.push(`${what}: exit ${r.code}\n${r.out}`);
        if (c?.conflicts) problems.push(`${what}: a conflict although nobody edited the same line\n${r.out}`);
        if (/\bat .+\.(js|ts):\d+/.test(r.out)) problems.push(`${what}: a stack trace\n${r.out}`);
        return r;
      };

      const deadline = Date.now() + minutes * 60_000;
      let step = 0;
      while (Date.now() < deadline && !problems.length) {
        step++;
        const present = NAMES.filter((n) => exists.get(n));
        const absent = NAMES.filter((n) => !exists.get(n));
        const action = present.length === 0 ? "create" : pick(["file", "tia", "both", "concurrent", "kill", "kill", "create", "delete"]);
        const n = action === "create" ? pick(absent.length ? absent : present) : pick(present);
        const v = counter++;
        const label = `#${step} ${action} ${n}`;
        if (action === "create") {
          if (exists.get(n)) continue;
          mkdirSync(join(ws, "plc", "PLC_1", "blocks", "90_Soak"), { recursive: true });
          writeFileSync(join(ws, ...rel(n).split("/")), source(n, v));
          exists.set(n, true);
          l1.set(n, v);
          l4.set(n, 0);
          await sync(label, rand() < 0.5 ? 200 + Math.floor(rand() * 3300) : undefined);
        } else if (action === "file") {
          fileEdit(n, v);
          await sync(label);
        } else if (action === "tia") {
          await tiaEdit(n, v);
          await sync(label);
        } else if (action === "both") {
          fileEdit(n, v);
          await tiaEdit(n, v);
          await sync(label);
        } else if (action === "concurrent") {
          fileEdit(n, v);
          const other = pick(present);
          const [r] = await Promise.all([sync(label), new Promise((w) => setTimeout(w, Math.floor(rand() * 4000))).then(() => tiaEdit(other, counter++))]);
          void r;
        } else if (action === "kill") {
          fileEdit(n, v);
          if (rand() < 0.5) await tiaEdit(pick(present), counter++);
          await sync(label, 200 + Math.floor(rand() * 3300)); // a sync of the fixture takes 1.5–3 s
        } else if (action === "delete") {
          await sync(`${label} (before)`);
          unlinkSync(join(ws, ...rel(n).split("/")));
          await sync(label);
          if (existsSync(join(ws, ...rel(n).split("/")))) {
            log(`${label}: the file came back (TIA changed it meanwhile)`);
            continue;
          }
          const d = await run(["confirm-delete", rel(n)]);
          log(`${label}: confirm-delete exit ${d.code} ${d.out.trim()}`);
          if (d.code !== 0) problems.push(`${label}: confirm-delete failed\n${d.out}`);
          else {
            exists.set(n, false);
            l1.delete(n);
            l4.delete(n);
          }
        }
      }

      expect(problems).toEqual([]); // the first problem ends the run; the log has the steps before it
      // quiet at the end: no more kills; at most a few passes until nothing moves
      let quiet = false;
      for (let i = 0; i < 6 && !quiet; i++) {
        const c = counts((await sync(`settle ${i}`)).out);
        quiet = !!c && c.exported + c.imported + c.created + c.merged === 0;
      }
      if (!quiet) problems.push("the workspace did not settle within 6 passes");

      // equal to TIA Portal, and every last value of both people is there
      const inTia = new Set((await user.listObjects("PLC_1")).map((e) => e.address));
      for (const n of NAMES) {
        const file = join(ws, ...rel(n).split("/"));
        if (!exists.get(n)) {
          if (existsSync(file) || inTia.has(addr(n))) problems.push(`${n} was deleted but is back (file ${existsSync(file)}, TIA ${inTia.has(addr(n))})`);
          continue;
        }
        if (!existsSync(file) || !inTia.has(addr(n))) {
          problems.push(`${n} is missing (file ${existsSync(file)}, TIA ${inTia.has(addr(n))})`);
          continue;
        }
        const r = await user.exportObject(addr(n), "auto", mkdtempSync(join(tmpdir(), "rung-soak-tia-")));
        const tia = readFileSync(r.files.find((f) => f.role === "primary")!.path, "utf8");
        const mine = readFileSync(file, "utf8");
        if (mine !== tia) problems.push(`${n}: the file differs from TIA Portal\n--- file\n${mine}\n--- TIA\n${tia}`);
        if (!mine.includes(`#l1 := ${l1.get(n)};`)) problems.push(`${n}: the file edit #l1 := ${l1.get(n)} got lost\n${mine}`);
        if (!mine.includes(`#l4 := ${l4.get(n)};`)) problems.push(`${n}: the TIA edit #l4 := ${l4.get(n)} got lost\n${mine}`);
      }
      const leftovers: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(d, e.name));
          else if (/\.rung-tmp-|\.conflict$|\.tia$/.test(e.name)) leftovers.push(join(d, e.name));
        }
      };
      walk(join(ws, "plc"));
      if (leftovers.length) problems.push(`left behind: ${leftovers.join(", ")}`);
      const status = await run(["status"]);
      if (status.code !== 0) problems.push(`rung status: exit ${status.code}\n${status.out}`);
      log(`done after ${step} steps; ${problems.length} problems`);
      console.log(`soak: ${step} steps, ${problems.length} problems (log: ${logFile})`);
      expect(problems).toEqual([]);

      // leave the fixture as it was
      for (const e of await user.listObjects("PLC_1"))
        if (e.address.startsWith("plc:PLC_1/blocks/90_Soak/")) await user.deleteObject(e.address, e.fingerprint, randomUUID()).catch(() => {});
    } finally {
      await user.close();
    }
  }, (minutes + 20) * 60_000);
});
