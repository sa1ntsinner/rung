// SPDX-License-Identifier: BUSL-1.1
// rung test stubs: a test file stands in for what the simulator does not model (communication, diagnostics, a
// block the workspace does not have), or for a block it runs, to test one unit alone.
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile } from "../src/index.js";

const fb = (name: string, decl: string, body: string) => `FUNCTION_BLOCK "${name}"\n${decl}\nBEGIN\n${body}\nEND_FUNCTION_BLOCK\n`;
const AXIS = '<?xml version="1.0" encoding="utf-8"?>\n<Document>\n  <Engineering version="V20" />\n  <SW.TechnologicalObjects.TechnologicalInstanceDB ID="0">\n    <AttributeList>\n      <Name>Fx_Axis</Name>\n      <Number>2</Number>\n    </AttributeList>\n  </SW.TechnologicalObjects.TechnologicalInstanceDB>\n</Document>\n';

function workspace() {
  const idx = new WorkspaceIndex();
  const set = (file: string, text: string) => idx.set(`file:///w/plc/P/${file}`, text, 0);
  set(
    "blocks/Fx_Reader.scl",
    fb(
      "Fx_Reader",
      "VAR_INPUT\n  start : Bool;\nEND_VAR\nVAR_OUTPUT\n  value : Int;\n  failed : Bool;\nEND_VAR\nVAR\n  rd : RDREC;\n  buffer : Array[0..3] of Byte;\nEND_VAR",
      "  #rd(REQ := #start, ID := 256, INDEX := 1, MLEN := 4, RECORD := #buffer);\n  IF #rd.VALID THEN\n    #value := #rd.LEN;\n  END_IF;\n  #failed := #rd.ERROR;",
    ),
  );
  set(
    "blocks/Fx_Modbus.scl",
    fb("Fx_Modbus", "VAR_INPUT\n  go : Bool;\nEND_VAR\nVAR_OUTPUT\n  done : Bool;\nEND_VAR\nVAR\n  mb : MB_CLIENT;\n  regs : Array[0..1] of Word;\nEND_VAR", "  #mb(REQ := #go, DISCONNECT := FALSE, MB_MODE := 0, MB_DATA_ADDR := 40001, MB_DATA_LEN := 2, MB_DATA_PTR := #regs);\n  #done := #mb.DONE;"),
  );
  set("blocks/Fx_Inner.scl", fb("Fx_Inner", "VAR_INPUT\n  x : Int;\nEND_VAR\nVAR_OUTPUT\n  y : Int;\nEND_VAR", "  #y := #x * 10;"));
  set(
    "blocks/Fx_Outer.scl",
    fb(
      "Fx_Outer",
      'VAR_INPUT\n  raw : Real;\nEND_VAR\nVAR_OUTPUT\n  out : Int;\n  smooth : Real;\n  logged : Int;\n  code : Int;\nEND_VAR\nVAR\n  inner : "Fx_Inner";\n  f : "Lib_Filter";\nEND_VAR',
      '  #inner(x := 1, y => #out);\n  #f(In := #raw, Out => #smooth);\n  #logged := "Fx_Log"(msg := \'started\', code => #code);',
    ),
  );
  set("blocks/Fx_Log.scl", 'FUNCTION "Fx_Log" : Int\nVAR_INPUT\n  msg : String;\nEND_VAR\nVAR_OUTPUT\n  code : Int;\nEND_VAR\nBEGIN\n  #code := 1;\n  #Fx_Log := 1;\nEND_FUNCTION\n');
  set("blocks/Fx_Drive.scl", fb("Fx_Drive", "VAR_OUTPUT\n  ready : Bool;\n  status : Word;\nEND_VAR\nVAR\n  pw : MC_POWER;\nEND_VAR", '  #pw(Axis := "Fx_Axis", Enable := TRUE);\n  #ready := #pw.Status;\n  #status := "Fx_Axis".StatusWord;'));
  set("techobjects/Fx_Axis.xml", AXIS);
  set("blocks/Fx_Record.scl", fb("Fx_Record", "VAR_OUTPUT\n  ok : Bool;\nEND_VAR\nVAR\n  rd : RDREC;\nEND_VAR", '  #rd(REQ := TRUE, ID := "Rack_1~Valve_Module", INDEX := 1);\n  #ok := #rd.VALID;'));
  return idx;
}
const test = (block: string, stubs: string, steps: string) => `block: ${block}\nstubs:\n${stubs}\ncases:\n  - name: one\n    steps:\n${steps}`;

describe("rung test stubs", () => {
  it("an RDREC stub takes the call's inputs and gives the outputs the test sets, step by step", async () => {
    const r = await runTestFile(
      workspace(),
      "t.yaml",
      test(
        "Fx_Reader",
        "  RDREC: { VALID: false, BUSY: false, ERROR: false, STATUS: 0, LEN: 4 }",
        "      - set: { start: true }\n      - cycle: 1\n      - expect: { rd.REQ: true, rd.INDEX: 1, value: 0, failed: false }\n      - set: { rd.VALID: true }\n      - cycle: 1\n      - expect: { value: 4 }\n      - set: { rd.ERROR: true }\n      - cycle: 1\n      - expect: { failed: true }\n",
      ),
    );
    expect(r.cases.map((c) => [c.passed, c.error, c.failures])).toEqual([[true, undefined, []]]);
    expect([r.stubbed, r.warnings]).toEqual([[{ name: "RDREC", calls: 3 }], undefined]);
  });

  it("MB_CLIENT: the test expects what the block passed to it; an output the code reads must be named", async () => {
    const run = (stubs: string) => runTestFile(workspace(), "t.yaml", test("Fx_Modbus", stubs, "      - set: { go: true }\n      - cycle: 1\n      - expect: { mb.REQ: true, mb.MB_DATA_ADDR: 40001, mb.MB_DATA_LEN: 2, done: false }\n"));
    expect((await run("  MB_CLIENT: { DONE: false }")).cases[0]).toMatchObject({ passed: true });
    expect((await run("  MB_CLIENT: {}")).cases[0]!.error).toBe("DONE is not a member of the stub of MB_CLIENT: give it a start value in the test (stubs: { MB_CLIENT: { DONE: … } }) (in Fx_Modbus, line 14)");
  });

  it("stubs a user FB, a block the workspace does not have and an FC; says which of them the simulator could run", async () => {
    const r = await runTestFile(
      workspace(),
      "t.yaml",
      test(
        "Fx_Outer",
        "  Fx_Inner: { y: 99 }\n  Lib_Filter: { Out: 1.5 }\n  Fx_Log: { RET_VAL: 7, code: 3 }",
        "      - set: { raw: 20.0 }\n      - cycle: 1\n      - expect: { out: 99, inner.x: 1, smooth: 1.5, f.In: 20.0, logged: 7, code: 3 }\n      - set: { f.Out: 2.5 }\n      - cycle: 1\n      - expect: { smooth: 2.5 }\n",
      ),
    );
    expect(r.cases.map((c) => [c.passed, c.error, c.failures])).toEqual([[true, undefined, []]]);
    expect(r.stubbed).toEqual([
      { name: "Fx_Inner", calls: 2, runs: true },
      { name: "Lib_Filter", calls: 2 },
      { name: "Fx_Log", calls: 2, runs: true },
    ]);
  });

  it("stubs a technology object: its members are readable and settable, and a call can pass it on", async () => {
    const r = await runTestFile(workspace(), "t.yaml", test("Fx_Drive", "  '\"Fx_Axis\"': { StatusWord: 33 }\n  MC_POWER: { Status: true }", "      - cycle: 1\n      - expect: { ready: true, status: 33, pw.Enable: true }\n      - set: { '\"Fx_Axis\".StatusWord': 1 }\n      - cycle: 1\n      - expect: { status: 1 }\n"));
    expect(r.cases.map((c) => [c.passed, c.error, c.failures])).toEqual([[true, undefined, []]]);
    expect(r.stubbed).toEqual([
      { name: '"Fx_Axis"', calls: 1 },
      { name: "MC_POWER", calls: 2 },
    ]);
  });

  it("gives a hardware identifier the number the device configuration would, where a stub needs one", async () => {
    const run = (stubs: string) => runTestFile(workspace(), "t.yaml", test("Fx_Record", stubs, "      - cycle: 1\n      - expect: { ok: true, rd.ID: 257 }\n"));
    const r = await run("  RDREC: { VALID: true }\n  '\"Rack_1~Valve_Module\"': 257");
    expect([r.cases[0]!.passed, r.stubbed]).toEqual([true, [{ name: "RDREC", calls: 1 }, { name: '"Rack_1~Valve_Module"', calls: 1 }]]);
    expect((await run("  RDREC: { VALID: true }")).error).toBe(`stubs needed (Rack_1~Valve_Module has no value offline): write stubs: { '"Rack_1~Valve_Module"': 257 }`);
    expect((await run("  '\"Rack_1~Valve_Module\"': { ID: 1 }")).error).toBe('stubs."Rack_1~Valve_Module": a hardware identifier stands for a number (its HW_IO value), such as 257');
  });

  it("warns about a stub the cases never called: most likely a typo or code they do not reach", async () => {
    const r = await runTestFile(workspace(), "t.yaml", test("Fx_Reader", "  RDREC: { VALID: true, ERROR: false, LEN: 1 }\n  MB_CLIENT: {}", "      - cycle: 1\n      - expect: { value: 1 }\n"));
    expect([r.cases[0]!.passed, r.warnings]).toEqual([true, ["stub MB_CLIENT was never called: a typo, or code these cases do not reach"]]);
  });

  it("refuses stubs the way it refuses the rest of a test file", async () => {
    const error = async (stubs: string, block = "Fx_Outer") => (await runTestFile(workspace(), "t.yaml", test(block, stubs, "      - cycle: 1\n"))).error;
    expect(await error("  Lib_Filtr: {}")).toBe("stubs.Lib_Filtr: nothing in the workspace calls or declares Lib_Filtr (did you mean Lib_Filter?)");
    expect(await error("  Fx_Inner: { z: 1 }")).toBe("stubs.Fx_Inner.z: Fx_Inner has no z (did you mean x?)");
    expect(await error("  Fx_Inner: { y: true }")).toBe("stubs.Fx_Inner.y is Int: expects a whole number, got true");
    expect(await error("  Fx_Log: { RET_VAL: 1.5 }")).toBe("stubs.Fx_Log.RET_VAL is Int: expects a whole number, got 1.5");
    expect(await error("  Fx_Outer: {}")).toBe("stubs.Fx_Outer: Fx_Outer is the block under test; stub what it calls");
    expect(await error("  RDREC: [1, 2]")).toBe("stubs.RDREC is a map of output values, such as { STATUS: 0 } (or {} for none)");
    expect(await error("  RDREC: { VALID: [true] }")).toBe("stubs.RDREC.VALID: a value is true/false, a number or a string, not [true]");
    expect((await runTestFile(workspace(), "t.yaml", "block: Fx_Outer\nstubs: [RDREC]\ncases:\n  - name: case 1\n    steps:\n      - cycle: 1\n")).error).toBe(
      "stubs is a map: a block, instruction or technology object, then the values its outputs start with (RDREC: { VALID: true })",
    );
  });

  it("without a stub, what the simulator does not model still stops the test, and says how a test can stand in for it", async () => {
    const r = await runTestFile(workspace(), "t.yaml", "block: Fx_Reader\ncases:\n  - name: case 2\n    steps:\n      - cycle: 1\n");
    expect(r.error).toBe("stubs needed (RDREC is not simulated): write stubs: { RDREC: {} }");
  });
});
