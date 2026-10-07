// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkspaceIndex } from "@rung/lsp";
import { Coverage, runTestFile } from "../src/index.js";

const fx = (f: string) => readFileSync(fileURLToPath(new URL(`../../../tools/fixtures/scl/${f}`, import.meta.url)), "utf8");

describe("statement coverage", () => {
  it("counts the lines a case ran, lists the ones it never reached, and writes lcov", async () => {
    const root = resolve("/w");
    const uri = (f: string) => pathToFileURL(join(root, "plc", "P", "blocks", f)).href;
    const idx = new WorkspaceIndex();
    idx.set(uri("Fx_Motor.scl"), fx("Fx_Motor.scl"), 0);
    idx.set(uri("Fx_Valve.scl"), fx("Fx_Valve.scl"), 0);
    const cov = new Coverage();
    // running only: the ELSE branch (line 27) never runs
    const r = await runTestFile(idx, "t.yaml", "block: Fx_Motor\ncases:\n  - name: runs\n    steps:\n      - set: { Start: true }\n      - cycle: 2\n", undefined, { simulator: (s) => cov.attach(s) });
    expect(r.cases[0]?.passed).toBe(true);
    const files = cov.files(idx);
    const motor = files.find((f) => f.uri.endsWith("Fx_Motor.scl"))!;
    expect([...motor.lines]).toEqual([[22, 2], [23, 2], [24, 2], [25, 2], [27, 0]]);
    // a block no test calls counts with nothing run
    const valve = files.find((f) => f.uri.endsWith("Fx_Valve.scl"))!;
    expect([...valve.lines.values()].every((n) => n === 0)).toBe(true);
    expect(Coverage.total([motor])).toEqual({ hit: 4, all: 5 });
    const lcov = Coverage.lcov([motor], root);
    expect(lcov).toBe("SF:plc/P/blocks/Fx_Motor.scl\nDA:22,2\nDA:23,2\nDA:24,2\nDA:25,2\nDA:27,0\nLH:4\nLF:5\nend_of_record\n");
  });
});

describe("observing a case (record to test)", () => {
  it("keeps the block's outputs and statics after each step that ran cycles, as a test writes them", async () => {
    const idx = new WorkspaceIndex();
    idx.set(pathToFileURL(join(resolve("/w"), "plc", "P", "blocks", "Fx_Motor.scl")).href, fx("Fx_Motor.scl"), 0);
    const yaml = "block: Fx_Motor\ncases:\n  - name: runs\n    steps:\n      - set: { Start: true, SpeedSetpoint: 1200 }\n      - cycle: 1\n      - set: { Stop: true }\n      - { cycle: 1, expect: { Running: false } }\n";
    const r = await runTestFile(idx, "t.yaml", yaml, undefined, { observe: true });
    expect(r.cases[0]?.observed).toEqual([
      { step: 2, values: { Running: true, SpeedOut: 1200, Latch: true }, statics: ["Latch"] },
      { step: 4, values: { Running: false, SpeedOut: 0, Latch: false }, statics: ["Latch"] },
    ]);
    expect((await runTestFile(idx, "t.yaml", yaml)).cases[0]?.observed).toBeUndefined();
    // arrays and structures by their paths; REAL without float32 noise
    idx.set(pathToFileURL(join(resolve("/w"), "plc", "P", "blocks", "Fc_Arr.scl")).href, 'FUNCTION_BLOCK "Fb_Arr"\nVAR_OUTPUT\n  a : Array[0..1] of Int;\n  r : Real;\n  s : Struct\n    x : Bool;\n  END_STRUCT;\nEND_VAR\nBEGIN\n  #a[1] := 5;\n  #r := 0.1;\n  #s.x := TRUE;\nEND_FUNCTION_BLOCK\n', 0);
    const arr = await runTestFile(idx, "a.yaml", "block: Fb_Arr\ncases:\n  - name: a\n    steps:\n      - cycle: 1\n", undefined, { observe: true });
    expect(arr.cases[0]?.observed?.[0]?.values).toEqual({ "a[0]": 0, "a[1]": 5, r: 0.1, "s.x": true });
  });
});
