// SPDX-License-Identifier: BUSL-1.1
// What `rung test` says about the mistakes people make in a test file, before anything runs.
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile, runTests } from "../src/index.js";

const fx = (f: string) => readFileSync(fileURLToPath(new URL(`../../../tools/fixtures/scl/${f}`, import.meta.url)), "utf8");
function index() {
  const idx = new WorkspaceIndex();
  for (const f of ["Fx_Motor.scl", "Fx_Global.db"]) idx.set(`file:///w/plc/P/blocks/${f}`, fx(f), 0);
  return idx;
}
const errorOf = async (yaml: string) => {
  const r = await runTestFile(index(), "t.test.yaml", yaml);
  return r.error ?? r.cases.map((c) => `${c.name}: ${c.passed ? "passed" : (c.error ?? "failed")}`).join("; ");
};

describe("a test file with a mistake in its shape", () => {
  it("names what is missing or misplaced instead of passing or finding no tests", async () => {
    // steps without a case around them: nothing would run
    expect(await errorOf("block: Fx_Motor\nsteps:\n  - set: { Start: true }\n")).toBe("unknown key steps: a test file has block, plc, cycle, stubs and cases (the steps go in a case under cases:)");
    expect(await errorOf("block: Fx_Motor\n")).toBe("no cases: list them under cases:, each with a name and its steps");
    // a case whose steps slipped out of it by indentation would pass without testing anything
    expect(await errorOf("block: Fx_Motor\ncases:\n  - name: runs\n  - steps:\n      - cycle: 1\n")).toBe("case 1 (runs) has no steps: indent them under the case, below its name");
    expect(await errorOf("block: Fx_Motor\ncases:\n  - name: runs\n    step:\n      - cycle: 1\n")).toBe("case 1 (runs): unknown key step (a case has name and steps)");
    expect(await errorOf("block: Fx_Motor\ncases:\n  - name: runs\n    steps: { cycle: 1 }\n")).toBe("case 1 (runs): steps is a list, one step per line starting with -");
    expect(await errorOf("block: Fx_Motor\ncycle: 0ms\ncases:\n  - steps:\n      - advance: 1s\n")).toBe("cycle is the time of one cycle, such as 10ms; 0ms runs no time");
    expect(await errorOf("block: Fx_Motor\ncycle: fast\ncases:\n  - steps:\n      - cycle: 1\n")).toBe("cycle is the time of one cycle, such as 10ms; not fast");
  });

  it("still runs a correct file", async () => {
    expect(await errorOf("block: Fx_Motor   # the motor\ncycle: 10ms\ncases:\n  - name: starts\n    steps:\n      - set: { Start: true }\n      - cycle: 1\n      - expect: { Running: true }\n")).toBe("starts: passed");
  });
});

describe("rung test --filter", () => {
  it("matches the block a file tests, also after a comment and in other letter case", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-filter-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "drive.test.yaml"), "block: Fx_Motor          # FB: one instance per case\ncases:\n  - steps:\n      - cycle: 1\n");
    expect((await runTests(root, index(), "Fx_Motor")).map((f) => f.file)).toEqual(["tests/drive.test.yaml"]);
    expect((await runTests(root, index(), "fx_motor")).map((f) => f.file)).toEqual(["tests/drive.test.yaml"]);
    expect(await runTests(root, index(), "Fx_Mot")).toEqual([]);
  });
});
