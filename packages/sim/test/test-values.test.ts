// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile, runTests, toJUnit } from "../src/index.js";

function index() {
  const idx = new WorkspaceIndex();
  const set = (file: string, text: string) => idx.set(`file:///w/plc/P/${file}`, text, 0);
  set("types/Data.udt", 'TYPE "Data"\nSTRUCT\n  Cmd : Struct\n    Raw : Int;\n  END_STRUCT;\n  Names : Array[1..2] of String[8];\nEND_STRUCT;\nEND_TYPE');
  set("blocks/Plant_DB.db", 'DATA_BLOCK "Plant_DB"\nVAR\n  Raw : Int;\n  Data : "Data";\nEND_VAR\nBEGIN\nEND_DATA_BLOCK');
  set("blocks/Child.scl", 'FUNCTION_BLOCK "Child"\nVAR_INPUT\n  Run : Bool;\n  Raw : Int;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK');
  set("blocks/Unit.scl", 'FUNCTION_BLOCK "Unit"\nVAR\n  Raw : Int;\n  Data : "Data";\n  child : "Child";\n  timer : TON_TIME;\n  rd : RDREC;\nEND_VAR\nVAR CONSTANT\n  Limit : Int := 5;\nEND_VAR\nVAR_TEMP\n  Work : Int;\nEND_VAR\nBEGIN\n  #timer(IN := TRUE, PT := T#2s);\nEND_FUNCTION_BLOCK');
  set("blocks/Scale.scl", 'FUNCTION "Scale" : Int\nVAR_INPUT\n  Raw : Int;\nEND_VAR\nVAR_OUTPUT\n  Run : Bool;\nEND_VAR\nBEGIN\n  #Scale := #Raw;\nEND_FUNCTION');
  set("blocks/Reader.scl", 'FUNCTION_BLOCK "Reader"\nVAR\n  flt : "Lib_Filter";\nEND_VAR\nBEGIN\n  #flt();\n  "Fx_Log"();\nEND_FUNCTION_BLOCK');
  return idx;
}
const yaml = (steps: string, block = "Unit", head = "") => `block: ${block}\n${head}cases:\n  - name: one\n    steps:\n${steps}\n`;
const run = (steps: string, block = "Unit", head = "") => runTestFile(index(), "tests/unit.test.yaml", yaml(steps, block, head));

describe("test values and diagnostics", () => {
  it("B1 checks DBs, nested UDTs, arrays and instance members by declared type", async () => {
    for (const name of ['"Plant_DB".Raw', '"Plant_DB".Data.Cmd.Raw', 'Data.Cmd.Raw', 'child.Raw']) {
      const r = await run(`      - set: { '${name}': 40000 }`);
      expect(r.cases[0]).toMatchObject({ errorStep: 1, error: `${name} is Int: 40000 is outside -32768..32767` });
    }
    expect((await run("      - set: { 'Data.Names[1]': abcdefghi }")).cases[0]!.error).toBe("Data.Names[1] is String[8]: 9 characters is longer than 8");
    expect((await run('      - set: { \'Data.Names[1]\': "T#500ms" }\n      - expect: { \'Data.Names[1]\': "T#500ms" }')).cases[0]!.passed).toBe(true);
    expect((await run("      - cycle: 1", "Unit", "stubs: { Child: { Raw: 40000 } }\n")).error).toContain("Raw is Int: 40000 is outside");
    const idx = index();
    idx.set("file:///w/plc/P/blocks/Label.scl", 'FUNCTION_BLOCK "Label"\nVAR_OUTPUT\n  Text : String[8];\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK', 0);
    expect((await runTestFile(idx, "t.yaml", yaml("      - cycle: 1", "Unit", "stubs: { Label: { Text: abcdefghi } }\n"))).error).toBe("stubs.Label.Text is String[8]: 9 characters is longer than 8");
  });

  it("B2 refuses whole arrays and structs at set with an element example", async () => {
    expect((await run("      - set: { Data.Cmd: { Raw: 1 } }\n      - cycle: 1")).cases[0]).toMatchObject({ errorStep: 1, error: "Data.Cmd is Struct: set its members, e.g. 'Data.Cmd.Raw'" });
    expect((await run("      - set: { Data.Names: [a, b] }")).cases[0]!.error).toContain("set its elements, e.g. 'Data.Names[1]'");
  });

  it("B3 explains constants, temps and FC values before the first call", async () => {
    for (const op of ["set", "expect"]) {
      expect((await run(`      - ${op}: { Limit: 1 }`)).cases[0]!.error).toContain("is a constant");
      expect((await run(`      - ${op}: { Work: 1 }`)).cases[0]!.error).toBe("Work is VAR_TEMP: it holds nothing between calls");
    }
    expect((await run("      - expect: { Scale: 0 }", "Scale")).cases[0]!.error).toBe("Scale has not run yet: run a cycle before expecting Scale");
  });

  it("B4 stops on misspelt FB/FC expects and FC inputs at the offending step", async () => {
    for (const [block, op, name, near] of [["Unit", "expect", "Rwa", "Raw"], ["Scale", "expect", "Rnu", "Run"], ["Scale", "set", "Rwa", "Raw"]]) {
      const r = await run(`      - ${op}: { ${name}: 1 }`, block);
      expect(r.cases[0]).toMatchObject({ errorStep: 1, error: `${name} does not exist (did you mean ${near}?)`, failures: [] });
    }
    expect((await run("      - set: { Raw: 1 }\n      - cycle: 1\n      - set: { Raw: 2 }\n      - expect: { Raw: 2, Scale: 1 }\n      - cycle: 1\n      - expect: { Scale: 2 }", "Scale")).cases[0]!.passed).toBe(true);
  });

  it("B5 formats TIME mismatches as PLC durations", async () => {
    const r = await run('      - advance: 500ms\n      - expect: { timer.ET: "T#500ms" }');
    expect(r.cases[0]!.failures[0]).toMatchObject({ expected: "T#500ms", actual: "T#490ms" });
  });

  it("B6 shares duration spellings and rounds advance up to at least one cycle", async () => {
    for (const duration of ["500ms", "T#500ms", "0.5s"]) expect((await run(`      - set: { timer.ET: ${duration} }\n      - expect: { timer.ET: ${duration} }`)).cases[0]!.passed).toBe(true);
    expect((await run("      - advance: 200")).cases[0]!.error).toBe("advance: write a unit, such as 200ms");
    expect((await run("      - advance: 15ms\n      - expect: { timer.ET: 10ms }\n      - advance: 0ms\n      - expect: { timer.ET: 20ms }")).cases[0]!.passed).toBe(true);
  });

  it("B8 refuses missing and duplicate names", async () => {
    const idx = index();
    expect((await runTestFile(idx, "t.yaml", "block: Unit\ncases:\n  - steps: [{ cycle: 1 }]\n")).error).toContain("missing name:");
    expect((await runTestFile(idx, "t.yaml", "block: Unit\ncases:\n  - { name: one, steps: [{ cycle: 1 }] }\n  - { name: one, steps: [{ cycle: 1 }] }\n")).error).toBe('case 2 (one): duplicate name "one" (case 1 and case 2)');
  });

  it("B9 counts JUnit failures and errors separately and names broken files", async () => {
    const failed = await run("      - expect: { Raw: 1 }");
    const error = await run("      - set: { Rwa: 1 }");
    const broken = await runTestFile(index(), "tests/broken.test.yaml", "block: [");
    const xml = toJUnit([failed, error, broken]);
    expect(xml).toContain('tests="3" failures="1" errors="2"');
    expect(xml).toContain('name="tests/broken.test.yaml"');
  });

  it("B11 explains an empty steps list without an indentation hint", async () => {
    expect((await runTestFile(index(), "t.yaml", "block: Unit\ncases:\n  - name: empty\n    steps: []\n")).error).toBe("case 1 (empty) has no steps");
  });

  it("B12 gives missing FBs and FCs a workspace message and stub example", async () => {
    expect((await run("      - cycle: 1", "Reader")).error).toBe("stubs needed (Lib_Filter is not in the workspace; Fx_Log is not in the workspace): write stubs: { Lib_Filter: {}, Fx_Log: { RET_VAL: 0 } }");
    expect((await run("      - cycle: 1", "Reader", "stubs: { Lib_Filter: {} }\n")).error).toBe("stubs needed (Fx_Log is not in the workspace): write stubs: { Fx_Log: { RET_VAL: 0 } }");
    const idx = index();
    idx.set("file:///w/plc/P/blocks/Outer.scl", 'FUNCTION_BLOCK "Outer"\nVAR\n  reader : "Reader";\nEND_VAR\nBEGIN\n  #reader();\nEND_FUNCTION_BLOCK', 0);
    const r = await runTestFile(idx, "t.yaml", yaml("      - cycle: 1", "Outer"));
    expect(r.error).toContain("Lib_Filter is not in the workspace; Fx_Log is not in the workspace");
    expect((await runTestFile(idx, "t.yaml", yaml("      - cycle: 1", "Outer", "stubs: { Reader: {} }\n"))).cases[0]!.passed).toBe(true);
  });

  it("B13 suppresses unused-stub warnings after a case stopped with an error", async () => {
    const r = await run("      - set: { Rwa: 1 }", "Unit", "stubs: { Child: { Run: true } }\n");
    expect(r.cases[0]!.error).toBeDefined();
    expect(r.warnings).toBeUndefined();
  });

  it("B14 checks system FB stub names and types, and suggests user FB members", async () => {
    for (const [stub, text] of [["RDREC: { LENGTH: 4 }", "has no LENGTH (did you mean LEN?)"], ["RDREC: { STATUS: 99999999999 }", "outside 0..4294967295"], ["WRREC: { DONE: 1 }", "expects a BOOL"], ["TON_TIME: { ET: false }", "expects a duration"], ["Child: { Rnu: false }", "has no Rnu (did you mean Run?)"]]) {
      expect((await run("      - cycle: 1", "Unit", `stubs: { ${stub} }\n`)).error).toContain(text);
    }
  });

  it("B15 matches path substrings without case sensitivity and accepts backslashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rung-filter-values-"));
    mkdirSync(join(dir, "tests", "drives"), { recursive: true });
    writeFileSync(join(dir, "tests", "drives", "motor.test.yaml"), yaml("      - cycle: 1"));
    for (const filter of ["Motor", "TESTS\\DRIVES", "unit"]) expect((await runTests(dir, index(), filter)).length).toBe(1);
  });

  it("B16 hints at DB quotes only when that DB exists", async () => {
    expect((await run("      - set: { Plant_DB.Raw: 1 }")).cases[0]!.error).toBe('Plant_DB is a data block: write \'"Plant_DB".Raw\'');
  });

  it("B25 carries YAML syntax and case key locations into JSON", async () => {
    const bad = await runTestFile(index(), "t.yaml", "block: Unit\ncases:\n  - name: bad\n    stpes: []\n");
    expect(JSON.parse(JSON.stringify(bad))).toMatchObject({ errorLine: 4, errorColumn: 5 });
    const syntax = await runTestFile(index(), "t.yaml", "block: Unit\ncases:\n  - name: bad\n    steps:\n      - set: { Raw: 1\n");
    expect(syntax.errorLine).toBeGreaterThanOrEqual(5);
    expect(syntax.errorColumn).toBeGreaterThan(0);
  });
});
