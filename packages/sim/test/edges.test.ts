// SPDX-License-Identifier: BUSL-1.1
// Edge cases of SCL arithmetic and standard functions where the simulator must answer like an S7-1500.
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { Simulator, type Struct } from "../src/runtime.js";

function run(decl: string, body: string, inputs: Record<string, unknown> = {}): Struct {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/plc/P/blocks/T.scl", `FUNCTION_BLOCK "T"\n${decl}\nBEGIN\n${body}\nEND_FUNCTION_BLOCK\n`, 0);
  const s = new Simulator(idx);
  const i = s.newInstance("T");
  s.callBlock(i, inputs as never);
  return i.mem;
}
const errorOf = (f: () => unknown) => {
  try {
    f();
    return "no error";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("bit strings are unsigned, whatever their width", () => {
  it("masks a DWORD with its top bit set and compares the result with a literal", () => {
    const m = run(
      "VAR\n  dw : DWord := 16#FFFF1234;\n  hi : Bool;\n  any : Bool;\n  x : Bool;\n  lw : LWord := 16#1_0000_0001;\n  lo : Bool;\nEND_VAR",
      "  #hi := (#dw AND 16#FFFF0000) = 16#FFFF0000;\n  #any := (#dw OR 16#80000000) = 16#FFFF1234;\n  #x := (#dw XOR 16#FFFF0000) = 16#1234;\n  #lo := (#lw AND 16#1_0000_0000) = 16#1_0000_0000;",
    );
    expect([m.HI, m.ANY, m.X, m.LO]).toEqual([true, true, true, true]);
  });

  it("typed literals and conversions have their type's width too", () => {
    const m = run(
      "VAR\n  a : Bool;\n  b : Bool;\n  c : Bool;\n  d : Bool;\n  e : Bool;\nEND_VAR",
      "  #a := SHL(IN := BYTE#16#80, N := 1) = 0;\n  #b := NOT WORD#16#00FF = WORD#16#FF00;\n  #c := NOT W#16#0F0F = 16#F0F0;\n  #d := SHL(IN := INT_TO_WORD(1), N := 16) = 0;\n  #e := (NOT BYTE#16#0F AND BYTE#16#FF) = 16#F0;",
    );
    expect([m.A, m.B, m.C, m.D, m.E]).toEqual([true, true, true, true, true]);
    const n = run("VAR\n  f : Bool;\nEND_VAR", "  #f := NOT SHL(IN := BYTE#16#01, N := 1) = BYTE#16#FD;");
    expect(n.F).toBe(true);
  });

  it("inverts a WORD in its own width", () => {
    const m = run("VAR\n  w : Word := 16#00FF;\n  same : Bool;\nEND_VAR", "  #same := NOT #w = 16#FF00;");
    expect(m.SAME).toBe(true);
  });

  it("shifts by the whole width or more to 0, and keeps the bits of an LWORD", () => {
    const m = run(
      "VAR\n  dw : DWord := 16#8000_0001;\n  a : DWord;\n  b : DWord;\n  lw : LWord;\n  c : Bool;\nEND_VAR",
      "  #a := SHR(IN := #dw, N := 32);\n  #b := SHL(IN := #dw, N := 40);\n  #lw := SHL(IN := LWORD#1, N := 40);\n  #c := SHR(IN := #dw, N := 31) = 1;",
    );
    expect([m.A, m.B, m.LW, m.C]).toEqual([0, 0, 2 ** 40, true]);
  });

  it("converts to a signed type inside an expression like the assignment would", () => {
    const m = run("VAR\n  w : Word := 16#FFFF;\n  neg : Bool;\n  i : Int := -1;\n  back : Bool;\nEND_VAR", "  #neg := WORD_TO_INT(#w) < 0;\n  #back := INT_TO_WORD(#i) = 16#FFFF;");
    expect([m.NEG, m.BACK]).toEqual([true, true]);
  });
});

describe("standard functions", () => {
  it("MUX picks the input K names, in any order, and INELSE when there is none", () => {
    const m = run(
      "VAR\n  a : Int;\n  b : Int;\n  c : Int;\n  d : Int;\nEND_VAR",
      "  #a := MUX(K := 1, IN0 := 10, IN1 := 11, IN2 := 12);\n  #b := MUX(IN0 := 10, IN1 := 11, K := 0);\n  #c := MUX(K := 7, IN0 := 10, IN1 := 11, INELSE := 99);\n  #d := MUX(2, 10, 11, 12);",
    );
    expect([m.A, m.B, m.C, m.D]).toEqual([11, 10, 99, 12]);
    expect(errorOf(() => run("VAR\n  a : Int;\nEND_VAR", "  #a := MUX(K := 5, IN0 := 10, IN1 := 11);"))).toMatch(/^MUX: K = 5 selects no input \(IN0\.\.IN1\) and there is no INELSE/);
  });

  it("RIGHT and LEFT of no characters are empty", () => {
    const m = run("VAR\n  r : String;\n  l : String;\nEND_VAR", "  #r := RIGHT(IN := 'abc', L := 0);\n  #l := LEFT(IN := 'abc', L := 0);");
    expect([m.R, m.L]).toEqual(["", ""]);
  });

  it("keeps as many characters as the string's declared length, like the PLC", () => {
    const m = run(
      "VAR\n  s : String[5];\n  n : Int;\n  w : WString[3];\n  c : Char;\nEND_VAR",
      "  #s := 'abcdefgh';\n  #n := LEN(#s);\n  #w := WSTRING#'wxyz';\n  #s := CONCAT(IN1 := #s, IN2 := 'zz');\n  #c := 'pq';",
    );
    expect([m.S, m.N, m.W, m.C]).toEqual(["abcde", 5, "wxy", "p"]);
  });

  it("reads $ escapes in strings in either case, and $hh character codes", () => {
    const m = run("VAR\n  s : String;\n  n : Int;\nEND_VAR", "  #s := 'a$nb$Rc$td$41$$$'';\n  #n := LEN(#s);");
    expect(m.S).toBe("a\nb\rc\tdA$'");
  });
});

describe("values are copied, slices have their width, a DTL starts in 1970", () => {
  it("an assigned structure or array is a copy; an FB input too, an IN_OUT is the caller's variable", () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/P/types/Pt.udt", 'TYPE "Pt"\nSTRUCT\n  x : Int;\nEND_STRUCT;\nEND_TYPE\n', 0);
    idx.set("file:///w/plc/P/blocks/Keep.scl", 'FUNCTION_BLOCK "Keep"\nVAR_INPUT\n  p : "Pt";\nEND_VAR\nVAR_IN_OUT\n  q : "Pt";\nEND_VAR\nVAR\n  seen : Int;\nEND_VAR\nBEGIN\n  #seen := #p.x;\n  #q.x := 7;\nEND_FUNCTION_BLOCK\n', 0);
    idx.set(
      "file:///w/plc/P/blocks/T.scl",
      'FUNCTION_BLOCK "T"\nVAR\n  a : "Pt";\n  b : "Pt";\n  arr : Array[0..1] of Int;\n  brr : Array[0..1] of Int;\n  k : "Keep";\n  r : "Pt";\nEND_VAR\nBEGIN\n  #a.x := 1;\n  #b := #a;\n  #a.x := 5;\n  #arr[0] := 1;\n  #brr := #arr;\n  #arr[0] := 9;\n  #k(p := #a, q := #r);\n  #a.x := 6;\nEND_FUNCTION_BLOCK\n',
      0,
    );
    const s = new Simulator(idx);
    const i = s.newInstance("T");
    s.callBlock(i, {} as never);
    const m = i.mem as Record<string, any>;
    expect([m.B.X, m.BRR.items[0], m.K.mem.P.X, m.K.mem.SEEN, m.R.X]).toEqual([1, 1, 5, 5, 7]);
  });

  it("a %B slice is a Byte and a %W slice a Word for NOT", () => {
    const m = run("VAR\n  d : DWord := 16#0000_00F0;\n  b : Bool;\n  w : Bool;\nEND_VAR", "  #b := NOT #d.%B0 = 16#0F;\n  #w := NOT #d.%W0 = 16#FF0F;");
    expect([m.B, m.W]).toEqual([true, true]);
  });

  it("a DTL nobody set is 1970-01-01, a Thursday", () => {
    const m = run("VAR\n  t : DTL;\n  y : Int;\n  wd : USInt;\nEND_VAR", "  #y := #t.YEAR;\n  #wd := #t.WEEKDAY;");
    expect([m.Y, m.WD]).toEqual([1970, 5]);
  });
});
