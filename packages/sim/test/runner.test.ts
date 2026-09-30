// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile, runTests, toJUnit } from "../src/index.js";

const fx = (f: string) => readFileSync(fileURLToPath(new URL(`../../../tools/fixtures/scl/${f}`, import.meta.url)), "utf8");
function index() {
  const idx = new WorkspaceIndex();
  for (const f of ["Fx_Motor.scl", "Fx_Valve.scl", "Fx_Counter.scl", "Fx_Global.db", "Fx_Types.udt"]) idx.set(`file:///w/plc/P/blocks/${f}`, fx(f), 0);
  return idx;
}

const MOTOR = `
block: Fx_Motor
cases:
  - name: starts, latches and stops
    steps:
      - set: { Start: true, SpeedSetpoint: 1500 }
      - cycle: 1
      - expect: { Running: true, SpeedOut: 1500 }
      - set: { Start: false }
      - cycle: 1
      - expect: { Running: true }
      - set: { Stop: true }
      - cycle: 1
      - expect: { Running: false, SpeedOut: 0 }
  - name: clamps the setpoint
    steps:
      - set: { Start: true, SpeedSetpoint: 9999 }
      - cycle: 1
      - expect: { SpeedOut: 3000 }
  - name: a wrong expectation fails with details
    steps:
      - set: { Start: true }
      - cycle: 1
      - expect: { Running: false, Latch: true }
`;

describe("rung test runner", () => {
  it("runs FB cases and reports failures per step", async () => {
    const r = await runTestFile(index(), "tests/motor.test.yaml", MOTOR);
    expect(r.cases.map((c) => [c.name, c.passed])).toEqual([
      ["starts, latches and stops", true],
      ["clamps the setpoint", true],
      ["a wrong expectation fails with details", false],
    ]);
    expect(r.cases[2]!.failures).toEqual([{ step: 3, name: "Running", expected: false, actual: true }]);
  });

  it("uses virtual time for timers (advance) and TIME literals in expectations", async () => {
    const r = await runTestFile(
      index(),
      "t.yaml",
      `block: Fx_Counter\ncycle: 5ms\ncases:\n  - name: debounced count\n    steps:\n      - set: { Pulse: true }\n      - advance: 15ms\n      - expect: { Count: 0 }\n      - advance: 10ms\n      - expect: { Count: 1, Elapsed: "T#20ms", Debounce.Q: true }\n`,
    );
    expect(r.cases[0]).toMatchObject({ passed: true });
  });

  it("tests FCs and global DB members", async () => {
    const r = await runTestFile(index(), "v.yaml", `block: Fx_Valve\ncases:\n  - steps:\n      - set: { Enable: true, Mode: 1 }\n      - cycle: 1\n      - expect: { Open: true }\n      - set: { Mode: 2 }\n      - cycle: 1\n      - expect: { Open: false }\n`);
    expect(r.cases[0]!.passed).toBe(true);
    const g = await runTestFile(index(), "g.yaml", `block: Fx_Motor\ncases:\n  - steps:\n      - set: { '"Fx_Global".Station.Mode': 3 }\n      - expect: { '"Fx_Global".Station.Mode': 3, '"Fx_Global".Count': 0 }\n`);
    expect(g.cases[0]!.passed).toBe(true);
  });

  it("reports unknown blocks, bad YAML and unknown steps clearly", async () => {
    expect((await runTestFile(index(), "a.yaml", "block: Nope\ncases: []\n")).error).toMatch(/not found/);
    expect((await runTestFile(index(), "b.yaml", "block: [unclosed")).error).toMatch(/invalid YAML/);
    const r = await runTestFile(index(), "c.yaml", "block: Fx_Motor\ncases:\n  - steps:\n      - jump: 1\n");
    expect(r.cases[0]!.error).toMatch(/unknown step "jump"/);
  });

  it("runs every key of a multi-key step in the order set, cycle, advance, expect", async () => {
    const r = await runTestFile(index(), "m.yaml", "block: Fx_Motor\ncases:\n  - steps:\n      - expect: { Running: true }\n        cycle: 1\n        set: { Start: true }\n  - steps:\n      - cycle: 1\n        expect: { Running: true }\n");
    expect(r.cases.map((c) => [c.passed, c.error])).toEqual([
      [true, undefined],
      [false, undefined],
    ]);
    expect(r.cases[1]!.failures).toEqual([{ step: 1, name: "Running", expected: true, actual: false }]);
    const bad = await runTestFile(index(), "m.yaml", "block: Fx_Motor\ncases:\n  - steps:\n      - cycle: 1\n        expct: { Running: true }\n");
    expect(bad.cases[0]!.error).toMatch(/unknown step "expct"/);
  });

  it("addresses array elements in set/expect and keeps FC IN_OUT values between cycles", async () => {
    const idx = index();
    idx.set("file:///w/plc/P/blocks/Arr.scl", 'FUNCTION_BLOCK "Arr"\nVAR\n  pts : Array[1..3] of "Fx_Types";\n  grid : Array[0..1, 0..2] of Int;\n  sum : Int;\nEND_VAR\nBEGIN\n  #sum := #pts[2].Mode + #grid[1, 2];\nEND_FUNCTION_BLOCK\n', 0);
    idx.set("file:///w/plc/P/blocks/Inc.scl", 'FUNCTION "Inc" : Void\nVAR_IN_OUT\n  acc : Int;\nEND_VAR\nBEGIN\n  #acc := #acc + 1;\nEND_FUNCTION\n', 0);
    const a = await runTestFile(idx, "a.yaml", "block: Arr\ncases:\n  - steps:\n      - set: { 'pts[2].Mode': 3, 'grid[1,2]': 4 }\n      - cycle: 1\n      - expect: { sum: 7, 'pts[2].Mode': 3, pts.2.Mode: 3 }\n");
    expect(a.cases.map((c) => [c.passed, c.error, c.failures])).toEqual([[true, undefined, []]]);
    const f = await runTestFile(idx, "f.yaml", "block: Inc\ncases:\n  - steps:\n      - set: { acc: 0 }\n      - cycle: 3\n      - expect: { acc: 3 }\n");
    expect(f.cases.map((c) => [c.passed, c.error, c.failures])).toEqual([[true, undefined, []]]);
  });

  it("rejects set values of the wrong kind", async () => {
    const r = await runTestFile(index(), "t.yaml", "block: Fx_Motor\ncases:\n  - steps:\n      - set: { Start: 1 }\n");
    expect(r.cases[0]!.error).toMatch(/Start expects a BOOL \(true\/false\), got 1/);
  });

  it("rejects values the declared type cannot hold, also for an FC's inputs before the first cycle", async () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/Fx_Add.scl", 'FUNCTION "Fx_Add" : Int\nVAR_INPUT\n  a : Int;\n  on : Bool;\nEND_VAR\nBEGIN\n  #Fx_Add := #a + 1;\nEND_FUNCTION\n', 0);
    const run = async (set: string) => (await runTestFile(idx, "t.yaml", `block: Fx_Add\ncases:\n  - steps:\n      - set: ${set}\n`)).cases[0]!.error;
    expect(await run("{ a: 40000 }")).toMatch(/a is Int: 40000 is outside -32768\.\.32767/);
    expect(await run("{ a: 1.5 }")).toMatch(/a is Int: expects a whole number, got 1\.5/);
    expect(await run("{ on: 1 }")).toMatch(/on expects a BOOL \(true\/false\), got 1/);
    expect(await run("{ a: 32767, on: true }")).toBeUndefined();
  });

  it("with two PLCs, the test says which PLC's block (plc: or tests/<PLC>/), never a guess", async () => {
    const idx = new WorkspaceIndex();
    for (const [plc, add] of [["PLC_A", 1], ["PLC_B", 2]] as const)
      idx.set(`file:///w/plc/${plc}/blocks/Fx_Add.scl`, `FUNCTION "Fx_Add" : Int\nVAR_INPUT\n  a : Int;\nEND_VAR\nBEGIN\n  #Fx_Add := #a + ${add};\nEND_FUNCTION\n`, 0);
    const test = (extra: string) => `block: Fx_Add\n${extra}cases:\n  - steps:\n      - { set: { a: 1 }, cycle: 1, expect: { Fx_Add: 3 } }\n`;
    expect((await runTestFile(idx, "tests/add.test.yaml", test(""))).error).toMatch(/Fx_Add is in several PLCs \(PLC_A, PLC_B\): add `plc: PLC_A`/);
    expect((await runTestFile(idx, "tests/add.test.yaml", test("plc: PLC_B\n"))).cases[0]!.passed).toBe(true);
    expect((await runTestFile(idx, "tests/PLC_B/add.test.yaml", test(""))).cases[0]!.passed).toBe(true);
    expect((await runTestFile(idx, "tests/PLC_A/add.test.yaml", test(""))).cases[0]!.passed).toBe(false);
  });

  it("discovers tests/**/*.test.yaml and renders JUnit XML", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-tests-"));
    mkdirSync(join(root, "tests", "drives"), { recursive: true });
    writeFileSync(join(root, "tests", "drives", "motor.test.yaml"), MOTOR);
    const results = await runTests(root, index());
    expect(results.map((r) => r.file)).toEqual(["tests/drives/motor.test.yaml"]);
    const xml = toJUnit(results);
    expect(xml).toContain('tests="3" failures="1"');
    expect(xml).toContain("step 3: Running expected false got true");
  });

  it("--filter matches the block under test as well as the file path", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-tests-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "motor.test.yaml"), MOTOR); // block: Fx_Motor
    expect((await runTests(root, index(), "Fx_Motor")).map((r) => r.file)).toEqual(["tests/motor.test.yaml"]);
    expect((await runTests(root, index(), "motor")).map((r) => r.file)).toEqual(["tests/motor.test.yaml"]);
    expect(await runTests(root, index(), "Fx_Valve")).toEqual([]);
  });
});
