// SPDX-License-Identifier: BUSL-1.1
// Randomized two-way soak against an in-memory TIA: no lost edits, no import/export loops.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig } from "@rung/core";
import { BridgeError, type CompileMessage, type ExportResult } from "@rung/bridge-client";
import { syncOnce, resolveConflict } from "../src/index.js";
import { FakeBridge } from "./fake-bridge.js";

class Tia extends FakeBridge {
  async importObject(address: string, form: string, path: string, expected: string): Promise<ExportResult> {
    const text = readFileSync(path, "utf8").replace(/\bbegin\b/g, "BEGIN"); // canonicalization
    const o = this.objects.get(address);
    if (expected === "absent") {
      if (o) throw new BridgeError("STALE_REVISION", "exists");
      this.add(address, { form, content: text });
    } else {
      if (!o) throw new BridgeError("NOT_FOUND", address);
      if (o.entry.fingerprint !== expected) throw new BridgeError("STALE_REVISION", "changed");
      this.edit(address, { ["." + form]: text });
    }
    return this.exportObject(address, "auto", mkdtempSync(join(tmpdir(), "soak-out-")));
  }
  async compile(): Promise<CompileMessage[]> {
    return [];
  }
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("soak", () => {
  it.each([1, 2, 3])("seed %i: 150 random steps stay consistent and quiesce", async (seed) => {
    const rand = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const root = mkdtempSync(join(tmpdir(), "rung-soak-"));
    const tia = new Tia();
    const names = ["A", "B", "C", "D", "E", "F"];
    const addr = (n: string) => `plc:PLC_1/blocks/G${n.charCodeAt(0) % 2}/Fx_${n}`;
    const file = (n: string) => join(root, "plc", "PLC_1", "blocks", `G${n.charCodeAt(0) % 2}`, `Fx_${n}.scl`);
    const body = (n: string, v: string) => `FUNCTION "Fx_${n}" : Void\nbegin\n  #l1 := ${v};\n  #l2 := 0;\n  #l3 := 0;\n  #l4 := ${v};\nEND_FUNCTION\n`;
    for (const n of names.slice(0, 3)) tia.add(addr(n), { content: body(n, "0") });
    const config = defaultConfig(tia.info.path, "V20", "fake");
    const state = await StateStore.open(root, { projectPath: tia.info.path, tiaVersion: "V20", devices: [] });
    let clock = 1000;
    const totals = { merged: 0, conflicts: 0, imported: 0, exported: 0, created: 0 };
    const pass = async () => {
      const r = await syncOnce(root, tia, state, { config, now: () => (clock += 10) });
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k];
      return r;
    };
    await pass();
    let counter = 0;
    try {
      for (let step = 0; step < 150; step++) {
        const n = pick(names);
        const a = addr(n);
        const action = pick(["fileEdit", "tiaEdit", "both", "fileEditLine1", "tiaEditLine4", "create", "tiaCreate", "none"]);
        const v = String(++counter);
        const hasFile = existsSync(file(n));
        const inTia = tia.objects.has(a);
        const st = state.get(a);
        if (st?.status === "conflicted") {
          // a human resolves by taking TIA's version half the time, own merged edit otherwise
          if (rand() < 0.5) await resolveConflict(root, state, st.path, "theirs");
          else {
            writeFileSync(file(n), body(n, "r" + v));
            await resolveConflict(root, state, st.path, "merged");
          }
        } else if (action === "fileEdit" && hasFile) writeFileSync(file(n), body(n, v));
        else if (action === "fileEditLine1" && hasFile) writeFileSync(file(n), readFileSync(file(n), "utf8").replace(/#l1 := [^;]*;/, `#l1 := ${v};`));
        else if (action === "tiaEdit" && inTia) tia.edit(a, { ".scl": body(n, "t" + v).replace("begin", "BEGIN") });
        else if (action === "tiaEditLine4" && inTia) tia.edit(a, { ".scl": tia.objects.get(a)!.files[".scl"]!.replace(/#l4 := [^;]*;/, `#l4 := t${v};`) });
        else if (action === "both" && hasFile && inTia) {
          writeFileSync(file(n), readFileSync(file(n), "utf8").replace(/#l1 := [^;]*;/, `#l1 := f${v};`));
          tia.edit(a, { ".scl": tia.objects.get(a)!.files[".scl"]!.replace(/#l4 := [^;]*;/, `#l4 := t${v};`) });
        } else if (action === "create" && !hasFile && !inTia) {
          mkdirSync(join(file(n), ".."), { recursive: true });
          writeFileSync(file(n), body(n, v));
        } else if (action === "tiaCreate" && !inTia && !hasFile) tia.add(a, { content: body(n, "t" + v).replace("begin", "BEGIN") });
        await pass();
      }
      // quiescence: two idle passes, the second must do nothing at all
      await pass();
      tia.exportCalls = [];
      const idle = await pass();
      expect(idle.imported + idle.exported + idle.created + idle.merged).toBe(0);
      // the run actually exercised every path
      expect(totals.imported * totals.exported * totals.created).toBeGreaterThan(0);
      expect(totals.merged + totals.conflicts).toBeGreaterThan(0);
      // consistency: every non-conflicted object has identical text on both sides
      for (const n of names) {
        const a = addr(n);
        const st = state.get(a);
        if (!st || st.status !== "synced") continue;
        expect(readFileSync(file(n), "utf8"), a).toBe(tia.objects.get(a)!.files[".scl"]);
      }
    } finally {
      await state.close();
    }
  }, 120_000);
});
