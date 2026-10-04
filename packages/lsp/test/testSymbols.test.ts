// SPDX-License-Identifier: BUSL-1.1
// What a test of a block may set and expect (the table's picker), and the keys of a test that name nothing.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { declarationModel } from "../src/declarations.js";
import { testModel } from "../src/testModel.js";
import { keyProblems, testSymbols } from "../src/testSymbols.js";

const FB = [
  'FUNCTION_BLOCK "Fx_Motor"',
  "   VAR_INPUT",
  "      Start : Bool;",
  "   END_VAR",
  "   VAR_OUTPUT",
  "      Running : Bool;",
  "   END_VAR",
  "   VAR",
  "      Cfg : Struct",
  "         Speed : Real;",
  "      END_STRUCT;",
  "      Timer {InstructionName := 'TON_TIME'; LibVersion := '1.0'} : TON_TIME;",
  "   END_VAR",
  "   VAR_TEMP",
  "      t : Int;",
  "   END_VAR",
  "BEGIN",
  "END_FUNCTION_BLOCK",
  "",
].join("\n");
const model = declarationModel("u", 1, FB, parse(FB));

describe("testSymbols", () => {
  it("lists inputs, outputs and statics with struct members, never temporaries", () => {
    expect(testSymbols(model).map((s) => `${s.section}:${s.name}:${s.type}`)).toEqual(["Input:Start:Bool", "Output:Running:Bool", "Static:Cfg.Speed:Real", "Static:Timer:TON_TIME"]);
  });
  it("an FC's return value is a symbol under the block's name", () => {
    const fc = 'FUNCTION "Calc" : Int\n   VAR_INPUT\n      a : Int;\n   END_VAR\nBEGIN\nEND_FUNCTION\n';
    expect(testSymbols(declarationModel("u", 1, fc, parse(fc))).map((s) => s.name)).toEqual(["Calc", "a"]);
  });
});

describe("keyProblems", () => {
  it("says which key names nothing, with the closest name; members, instances and globals pass", () => {
    const t = testModel(["block: Fx_Motor", "cases:", "  - name: a", "    steps:", "      - set: { Strat: true, Cfg.Speed: 1.0, Timer.PT: T#1s, '\"DB\".x': 1, t: 1 }", "      - expect: { Runing: true }", ""].join("\n"));
    expect(keyProblems(t, testSymbols(model), ["t"])).toEqual([
      { case: 0, step: 0, part: "set", key: "Strat", message: "Fx_Motor has no Strat (did you mean Start?)" },
      { case: 0, step: 0, part: "set", key: "t", message: "Fx_Motor has no t (a temporary is not kept between cycles)" },
      { case: 0, step: 1, part: "expect", key: "Runing", message: "Fx_Motor has no Runing (did you mean Running?)" },
    ]);
  });
});
