// SPDX-License-Identifier: BUSL-1.1
// The first test of a block, written for the engineer: its inputs set, one cycle, its outputs to expect.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { declarationModel } from "../src/declarations.js";
import { testSkeleton } from "../src/testSkeleton.js";

const FB = [
  'FUNCTION_BLOCK "Fx_Motor"',
  "   VAR_INPUT",
  "      Start : Bool;",
  "      Setpoint : Real := 1500.0;",
  "      Delay : Time := T#2s;",
  '      "30ms" : Bool := TRUE;',
  "      Cfg : \"T_Cfg\";",
  "   END_VAR",
  "   VAR_OUTPUT",
  "      Running : Bool;",
  "      Count : Int;",
  "   END_VAR",
  "   VAR_IN_OUT",
  "      Buffer : Word;",
  "   END_VAR",
  "BEGIN",
  "END_FUNCTION_BLOCK",
  "",
].join("\n");

const model = (src: string) => declarationModel("file:///w/plc/PLC_1/blocks/Fx_Motor.scl", 1, src, parse(src));

describe("testSkeleton", () => {
  it("sets the inputs (their start values), runs a cycle and expects the outputs", () => {
    const s = testSkeleton(model(FB), { plc: "PLC_1", severalPlcs: false });
    expect(s.path).toBe("tests/Fx_Motor.test.yaml");
    expect(s.text).toBe(
      [
        "block: Fx_Motor",
        "cases:",
        "  - name: first case",
        "    steps:",
        "      - set: { Start: false, Setpoint: 1500.0, Delay: T#2s, '30ms': true, Buffer: 0 }",
        "      - cycle: 1",
        "      # what Fx_Motor should give: change these values",
        "      - expect: { Running: false, Count: 0, Buffer: 0 }",
        "",
      ].join("\n"),
    );
  });

  it("an FC's return value is expected under its name; several PLCs put the test in the PLC's folder", () => {
    const fc = 'FUNCTION "Calc" : Int\n   VAR_INPUT\n      a : DInt;\n   END_VAR\nBEGIN\nEND_FUNCTION\n';
    const s = testSkeleton(declarationModel("file:///w/plc/PLC_2/blocks/Calc.scl", 1, fc, parse(fc)), { plc: "PLC_2", severalPlcs: true });
    expect(s.path).toBe("tests/PLC_2/Calc.test.yaml");
    expect(s.text).toContain("      - set: { a: 0 }\n");
    expect(s.text).toContain("      - expect: { Calc: 0 }\n");
  });

  it("the file name holds any block name", () => {
    const odd = 'FUNCTION_BLOCK "Fx/Motor:1"\nBEGIN\nEND_FUNCTION_BLOCK\n';
    const s = testSkeleton(model(odd), { severalPlcs: false });
    expect(s.path).toBe("tests/Fx%2FMotor%3A1.test.yaml");
    expect(s.text).toMatch(/^block: 'Fx\/Motor:1'\n/);
  });

  it("a block without inputs or outputs still gets a case to fill", () => {
    const empty = 'FUNCTION_BLOCK "E"\nBEGIN\nEND_FUNCTION_BLOCK\n';
    expect(testSkeleton(model(empty), { severalPlcs: false }).text).toBe("block: E\ncases:\n  - name: first case\n    steps:\n      - cycle: 1\n");
  });
});
