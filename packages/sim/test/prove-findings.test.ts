// SPDX-License-Identifier: BUSL-1.1
// What differential validation against PLCSIM Advanced (tools/prove) found: constructs TIA Portal compiles that the
// simulator refused.
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile } from "../src/index.js";

const fb = (decl: string, body: string) => `FUNCTION_BLOCK "FB_T"\n${decl}\nBEGIN\n${body}\nEND_FUNCTION_BLOCK\n`;
async function run(decl: string, body: string, set: string) {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/plc/P/blocks/FB_T.scl", fb(decl, body), 0);
  const r = await runTestFile(idx, "t.yaml", `block: FB_T\ncases:\n  - name: one\n    steps:\n      - set: ${set}\n        cycle: 1\n`, undefined, { observe: true });
  return { error: r.error ?? r.cases[0]?.error, values: r.cases[0]?.observed?.[0]?.values };
}

describe("found by differential validation", () => {
  it("NOT before a parenthesis is the operator, not a call", async () => {
    const r = await run("VAR_INPUT\n  a : Int;\nEND_VAR\nVAR_OUTPUT\n  c : Bool;\nEND_VAR", "  #c := NOT (#a > 0) AND (#a < 10) OR NOT(#a = 3);", "{ a: 5 }");
    expect(r.error).toBeUndefined();
    expect(r.values).toEqual({ c: true }); // (NOT (5 > 0) AND (5 < 10)) OR NOT (5 = 3): NOT before AND before OR
  });

  it("a test writes a Word as TIA Portal does: 16#00F3, 2#0000_0101, WORD#16#FF", async () => {
    const r = await run("VAR_INPUT\n  w : Word;\n  b : Byte;\n  i : Int;\nEND_VAR\nVAR_OUTPUT\n  o : Word;\n  s : Int;\nEND_VAR", "  #o := #w OR #b;\n  #s := #i;", "{ w: 16#00F0, b: 2#0000_0101, i: INT#16#7F }");
    expect(r.error).toBeUndefined();
    expect(r.values).toEqual({ o: 0xf5, s: 127 });
  });

  it("a real converted out of an integer's range is no number a CPU gives: the case stops and says so", async () => {
    const r = await run("VAR_INPUT\n  r : Real;\nEND_VAR\nVAR_OUTPUT\n  i : Int;\nEND_VAR", "  #i := REAL_TO_INT(#r);", "{ r: 32767.6 }");
    expect(r.error).toMatch(/REAL_TO_INT\(32767\.6\): out of the range of INT; a CPU leaves the result undefined/);
    expect((await run("VAR_INPUT\n  r : Real;\nEND_VAR\nVAR_OUTPUT\n  i : Int;\nEND_VAR", "  #i := REAL_TO_INT(#r);", "{ r: 32767.4 }")).values).toEqual({ i: 32767 });
  });

  it("FRAC is the fractional part, also when a variable is called frac", async () => {
    const r = await run("VAR_INPUT\n  x : Real;\nEND_VAR\nVAR_OUTPUT\n  frac : Real;\nEND_VAR", "  #frac := FRAC(#x);", "{ x: 2.25 }");
    expect(r.error).toBeUndefined();
    expect(r.values).toEqual({ frac: 0.25 });
  });

  it("numbers become text as an S7 CPU writes them: a sign always, a REAL in exponent form", async () => {
    const decl = "VAR_INPUT\n  i : Int;\n  d : DInt;\n  r : Real;\nEND_VAR\nVAR_OUTPUT\n  si : String;\n  sd : String;\n  sr : String;\nEND_VAR";
    const body = "  #si := INT_TO_STRING(#i);\n  #sd := DINT_TO_STRING(#d);\n  #sr := REAL_TO_STRING(#r);";
    expect((await run(decl, body, "{ i: 13824, d: -70000, r: 2.25 }")).values).toEqual({ si: "+13824", sd: "-70000", sr: "+2.250000E+0" });
    expect((await run(decl, body, "{ i: 0, d: 0, r: -0.5 }")).values).toEqual({ si: "+0", sd: "+0", sr: "-5.000000E-1" });
  });

  it("an integer divided by zero is 0 on an S7 CPU, and so is its MOD; DELETE past the end deletes to the end", async () => {
    const decl = "VAR_INPUT\n  a : Int;\n  b : Int;\n  d : DInt;\n  s : String;\nEND_VAR\nVAR_OUTPUT\n  q : Int;\n  m : Int;\n  dq : DInt;\n  del : String;\nEND_VAR";
    const body = "  #q := #a / #b;\n  #m := #a MOD #b;\n  #dq := #d / INT_TO_DINT(#b);\n  #del := DELETE(IN := #s, L := 2, P := 2);";
    const r = await run(decl, body, "{ a: 7, b: 0, d: 50, s: xy }");
    expect(r.error).toBeUndefined();
    expect(r.values).toEqual({ q: 0, m: 0, dq: 0, del: "x" });
  });

  it("an LReal becomes text with 13 decimals, as the CPU writes it", async () => {
    const decl = "VAR_INPUT\n  x : LReal;\nEND_VAR\nVAR_OUTPUT\n  t : String;\nEND_VAR";
    expect((await run(decl, "  #t := LREAL_TO_STRING(#x);", "{ x: -123456.789 }")).values).toEqual({ t: "-1.2345678900000E+5" });
    expect((await run(decl, "  #t := LREAL_TO_STRING(#x);", "{ x: 0.0 }")).values).toEqual({ t: "+0.0000000000000E+0" });
  });

  it("the members of structures in an array keep their names when observed (pts[0].x)", async () => {
    const r = await run("VAR_INPUT\n  a : Int;\nEND_VAR\nVAR_OUTPUT\n  pts : Array[0..1] of Struct\n    x : Int;\n    onOff : Bool;\n  END_STRUCT;\nEND_VAR", "  #pts[1].x := #a;\n  #pts[1].onOff := TRUE;", "{ a: 4 }");
    expect(r.values).toEqual({ "pts[0].x": 0, "pts[0].onOff": false, "pts[1].x": 4, "pts[1].onOff": true });
  });

  it("a Char converts to its code and back", async () => {
    const r = await run("VAR_INPUT\n  c : Char;\nEND_VAR\nVAR_OUTPUT\n  code : Int;\n  up : Char;\nEND_VAR", "  #code := CHAR_TO_INT(#c);\n  #up := INT_TO_CHAR(CHAR_TO_INT(#c) - 32);", "{ c: q }");
    expect(r.values).toEqual({ code: 113, up: "Q" });
  });

  it("a DATE and a TIME_OF_DAY from a test are dates and times, with their arithmetic", async () => {
    const decl = "VAR_INPUT\n  day : Date;\n  tod : Time_Of_Day;\nEND_VAR\nVAR_OUTPUT\n  next : Date;\n  later : Time_Of_Day;\n  diff : Time;\n  ms : DInt;\n  back : Date;\nEND_VAR";
    const body = "  #next := #day + T#1D;\n  #later := #tod + T#1H30M;\n  #diff := #next - #day;\n  #ms := TOD_TO_DINT(#later);\n  #back := #day - T#2D;";
    const r = await run(decl, body, "{ day: D#2024-02-28, tod: TOD#23:15:00 }");
    expect(r.error).toBeUndefined();
    expect(r.values).toEqual({ next: "D#2024-02-29", later: "TOD#24:45:00", diff: "T#86400000ms", ms: 89100000, back: "D#2024-02-26" });
  });

  it("a two-dimensional array is observed as TIA Portal and tests name its elements: grid[0,1]", async () => {
    const r = await run("VAR_INPUT\n  a : Int;\nEND_VAR\nVAR_OUTPUT\n  grid : Array[0..1, 0..1] of Int;\nEND_VAR", "  #grid[1, 0] := #a;", "{ a: 3 }");
    expect(r.values).toEqual({ "grid[0,0]": 0, "grid[0,1]": 0, "grid[1,0]": 3, "grid[1,1]": 0 });
  });

  it("the members of a PLC data type keep their names when observed (pt.x)", async () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/P/types/T_Pt.udt", 'TYPE "T_Pt"\nSTRUCT\n  x : Int;\n  label : String[4];\nEND_STRUCT;\nEND_TYPE\n', 0);
    idx.set("file:///w/plc/P/blocks/FB_T.scl", fb("VAR_INPUT\n  a : Int;\nEND_VAR\nVAR_OUTPUT\n  pt : \"T_Pt\";\nEND_VAR", "  #pt.x := #a;"), 0);
    const r = await runTestFile(idx, "t.yaml", "block: FB_T\ncases:\n  - name: one\n    steps:\n      - set: { a: 2 }\n        cycle: 1\n", undefined, { observe: true });
    expect(r.cases[0]?.observed?.[0]?.values).toEqual({ "pt.x": 2, "pt.label": "" });
  });

  it("TONR keeps its elapsed time while IN is off and R resets it", async () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/P/blocks/FB_T.scl", fb("VAR_INPUT\n  run : Bool;\n  reset : Bool;\nEND_VAR\nVAR_OUTPUT\n  q : Bool;\n  et : Time;\nEND_VAR\nVAR\n  acc {InstructionName := 'TONR_TIME'; LibVersion := '1.0'} : TONR_TIME;\nEND_VAR", "  #acc(IN := #run, R := #reset, PT := T#100MS, Q => #q, ET => #et);"), 0);
    const yaml = "block: FB_T\ncases:\n  - name: one\n    steps:\n      - set: { run: true }\n        advance: 60ms\n      - set: { run: false }\n        advance: 50ms\n      - set: { run: true }\n        advance: 60ms\n      - set: { reset: true }\n        cycle: 1\n";
    const r = await runTestFile(idx, "t.yaml", yaml, undefined, { observe: true });
    expect(r.error ?? r.cases[0]?.error).toBeUndefined();
    expect(r.cases[0]!.observed!.map((o) => `${o.values.q} ${o.values.et}`)).toEqual(["false T#50ms", "false T#60ms", "true T#100ms", "false T#0ms"]);
  });

  it("an LTIME is nanoseconds as a number: LTIME_TO_LINT(LT#3s) = 3000000000", async () => {
    const r = await run("VAR_INPUT\n  lt : LTime;\n  n : LInt;\nEND_VAR\nVAR_OUTPUT\n  ns : LInt;\n  back : LTime;\nEND_VAR", "  #ns := LTIME_TO_LINT(#lt);\n  #back := LINT_TO_LTIME(#n);", "{ lt: LT#3s, n: 250000000 }");
    expect(r.values).toEqual({ ns: 3000000000, back: "T#250ms" });
  });

  it("an instruction called by its name is the instruction, even when a variable has that name", async () => {
    const r = await run("VAR_INPUT\n  w : Word;\nEND_VAR\nVAR_OUTPUT\n  shl : Word;\n  min : Int;\nEND_VAR", "  #shl := SHL(IN := #w, N := 3);\n  #min := MIN(IN1 := 4, IN2 := 2);", "{ w: 1 }");
    expect(r.error).toBeUndefined();
    expect(r.values).toEqual({ shl: 8, min: 2 });
  });
});
