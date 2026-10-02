// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { Simulator, type Struct } from "../src/runtime.js";

function setup(iec: boolean, vars: string, body: string) {
  const index = new WorkspaceIndex();
  index.set(`file:///w/Probe.${iec ? "st" : "scl"}`, `FUNCTION_BLOCK Probe\n${vars}\n${iec ? "" : "BEGIN\n"}${body.replace(/@/g, iec ? "" : "#")}\nEND_FUNCTION_BLOCK`, 0);
  const sim = new Simulator(index);
  const inst = sim.newInstance("Probe");
  return { index, sim, inst, run: (inputs: Struct = {}) => (sim.callBlock(inst, inputs), inst.mem) };
}

describe.each([false, true])("numeric and bit semantics (IEC = %s)", (iec) => {
  it("rounds REAL intermediates and storage, while LREAL stays double", () => {
    const { run } = setup(iec, `VAR_INPUT
  inputReal : REAL;
  inputDouble : LREAL;
END_VAR
VAR
  initialReal : REAL := LREAL#0.1;
  initialDouble : LREAL := LREAL#0.1;
  stored : REAL;
  cancel : LREAL;
  doubleCancel : LREAL;
  converted : LREAL;
  rootReal : LREAL;
  rootDouble : LREAL;
  quotient : LREAL;
  a : ARRAY[0..0] OF REAL;
  point : STRUCT x : REAL; END_STRUCT;
END_VAR`, `
  @stored := LREAL#16777217.0;
  @a[0] := LREAL#16777217.0;
  @point.x := LREAL#16777217.0;
  @cancel := (DINT_TO_REAL(16777217) + REAL#1.0) - DINT_TO_REAL(16777217);
  @doubleCancel := (LREAL#16777216.0 + LREAL#1.0) - LREAL#16777216.0;
  @converted := REAL_TO_LREAL(DINT_TO_REAL(16777217));
  @rootReal := SQRT(REAL#2.0);
  @rootDouble := SQRT(LREAL#2.0);
  @quotient := REAL#1.0 / REAL#3.0;
`);
    const mem = run({ inputReal: 0.1, inputDouble: 0.1 });
    expect(mem).toMatchObject({ INPUTREAL: Math.fround(0.1), INPUTDOUBLE: 0.1, INITIALREAL: Math.fround(0.1), INITIALDOUBLE: 0.1,
      STORED: 16777216, CANCEL: 0, DOUBLECANCEL: 1, CONVERTED: 16777216, ROOTREAL: Math.fround(Math.sqrt(2)), ROOTDOUBLE: Math.sqrt(2), QUOTIENT: Math.fround(1 / 3) });
    expect(mem.A).toMatchObject({ items: [16777216] });
    expect(mem.POINT).toEqual({ X: 16777216 });
  });

  it("keeps precision through signed literals, mixed expressions and function results", () => {
    const { index, run } = setup(iec, "VAR\n  realCancel : LREAL;\n  mixed : LREAL;\n  negative : LREAL;\n  fromCall : LREAL;\n  promoted : LREAL;\n  equal : BOOL;\nEND_VAR", `
  @realCancel := (REAL#16777216.0 * REAL#1.00000001) - REAL#16777216.0;
  @mixed := REAL#16777216.0 + LREAL#1.0;
  @negative := -REAL#16777217.0;
  @fromCall := Echo(LREAL#16777217.0);
  @promoted := DINT#16777217 - REAL#16777216.0;
  @equal := DINT#16777217 = REAL#16777216.0;
`);
    index.set(`file:///w/Echo.${iec ? "st" : "scl"}`, `FUNCTION Echo : LREAL\nVAR_INPUT\n x : REAL;\nEND_VAR\n${iec ? "Echo := x;" : "BEGIN\n #Echo := #x;"}\nEND_FUNCTION`, 0);
    expect(run()).toMatchObject({ REALCANCEL: 0, MIXED: 16777217, NEGATIVE: -16777216, FROMCALL: 16777216, PROMOTED: 0, EQUAL: true });
  });

  it("rounds conversions and ROUND using the source dialect, including negative halves", () => {
    const { run } = setup(iec, "VAR_INPUT\n x : LREAL;\nEND_VAR\nVAR\n i : INT;\n d : DINT;\n rounded : DINT;\n truncated : DINT;\nEND_VAR", `
  @i := REAL_TO_INT(LREAL_TO_REAL(@x));
  @d := LREAL_TO_DINT(@x);
  @rounded := ROUND(@x);
  @truncated := TRUNC(@x);
`);
    for (const [value, even, away] of [[0.5, 0, 1], [1.5, 2, 2], [2.5, 2, 3], [-0.5, 0, -1], [-1.5, -2, -2], [-2.5, -2, -3], [2.49, 2, 2]]) {
      const want = iec ? away : even;
      expect(run({ x: value })).toMatchObject({ I: want, D: want, ROUNDED: want, TRUNCATED: Math.trunc(value) || 0 });
    }
  });

  it("converts radix-prefixed integer strings exactly", () => {
    const { run } = setup(iec, "VAR\n h : UINT;\n o : INT;\n b : BYTE;\n signed : INT;\n typed : UINT;\n decimal : DINT;\nEND_VAR", `
  @h := STRING_TO_UINT('16#F_F');
  @o := STRING_TO_INT('8#3_77');
  @b := STRING_TO_BYTE('2#1111_1111');
  @signed := STRING_TO_INT('-16#FF');
  @typed := STRING_TO_UINT('WORD#16#F_F');
  @decimal := STRING_TO_DINT('-1_234');
`);
    expect(run()).toMatchObject({ H: 255, O: 255, B: 255, SIGNED: -255, TYPED: 255, DECIMAL: -1234 });
    const unsafe = setup(iec, "VAR\n x : ULINT;\nEND_VAR", "@x := STRING_TO_ULINT('16#FFFF_FFFF_FFFF_FFFF');");
    expect(() => unsafe.run()).toThrow(/cannot be held exactly/);
  });

  it("rotates at the input width, for zero, full-width and larger counts", () => {
    const { run } = setup(iec, "VAR\n b : BYTE;\n w : WORD;\n d : DWORD;\n l : LWORD;\n same : BYTE;\n full : BYTE;\n nested : BOOL;\n literal : DWORD;\n literalNot : BOOL;\nEND_VAR", `
  @b := ROL(BYTE#16#81, 9);
  @w := ROL(N := 17, IN := WORD#16#8001);
  @d := ROR(DWORD#16#80000001, 33);
  @l := ROR(LWORD#1, 65);
  @same := ROR(BYTE#16#81, 0);
  @full := ROL(BYTE#16#81, 8);
  @nested := NOT ROL(BYTE#16#81, 1) = BYTE#16#FC;
  @literal := ROR(16#81, 1);
  @literalNot := NOT ROR(16#81, 1) = BYTE#16#3F;
`);
    expect(run()).toMatchObject({ B: 3, W: 3, D: 3221225472, L: 2 ** 63, SAME: 129, FULL: 129, NESTED: true, LITERAL: 192, LITERALNOT: true });
    const unsafe = setup(iec, "VAR\n x : LWORD;\nEND_VAR", "@x := ROR(LWORD#3, 1);");
    expect(() => unsafe.run()).toThrow(/cannot be held exactly/);
    const bad = setup(iec, "VAR\n x : BYTE;\nEND_VAR", "@x := ROL(BYTE#1, -1);");
    expect(() => bad.run()).toThrow(/N at least 0/);
  });

  it("keeps the recorded IEC DWORD shift behavior separate from Siemens", () => {
    const { run } = setup(iec, "VAR\n b : BYTE;\n w : WORD;\n d : DWORD;\n e : DWORD;\nEND_VAR", `
  @b := SHL(BYTE#1, 8);
  @w := SHR(WORD#16#FFFF, 17);
  @d := SHL(DWORD#16#80000001, 32);
  @e := SHR(DWORD#16#80000001, 33);
`);
    expect(run()).toMatchObject({ B: 0, W: 0, D: iec ? 2147483649 : 0, E: iec ? 1073741824 : 0 });
  });

  it("reads and writes bits of variables, array elements and structure members", () => {
    const bit = iec ? ".3" : ".%X3";
    const top = iec ? ".15" : ".%X15";
    const { run } = setup(iec, "VAR\n w : WORD := WORD#8;\n a : ARRAY[0..0] OF WORD;\n s : STRUCT w : WORD; END_STRUCT;\n readBit : BOOL;\nEND_VAR", `
  @readBit := @w${bit};
  @w${bit} := FALSE;
  @w${top} := TRUE;
  @a[0]${bit} := TRUE;
  @s.w${top} := TRUE;
`);
    expect(run()).toMatchObject({ READBIT: true, W: 32768, A: { items: [8] }, S: { W: 32768 } });
  });

  it("returns floating point from EXPT and handles powers by exponent type", () => {
    const { run } = setup(iec, "VAR\n fractional : LREAL;\n double : LREAL;\n zero : LREAL;\n negative : LREAL;\n realExponent : LREAL;\n fractionalExponent : LREAL;\nEND_VAR", `
  @fractional := EXPT(INT#2, INT#-1);
  @double := EXPT(IN2 := LREAL#3.0, IN1 := LREAL#2.0);
  @zero := EXPT(INT#0, INT#0);
  @negative := EXPT(REAL#-2.0, INT#3);
  @realExponent := EXPT(REAL#-2.0, REAL#3.0);
  @fractionalExponent := EXPT(REAL#-2.0, REAL#0.5);
`);
    expect(run()).toMatchObject({ FRACTIONAL: 0.5, DOUBLE: 8, ZERO: 1, NEGATIVE: -8, REALEXPONENT: iec ? -8 : NaN, FRACTIONALEXPONENT: NaN });
    const undefinedPower = setup(iec, "VAR\n x : LREAL;\nEND_VAR", "@x := EXPT(0, -1);");
    expect(() => undefinedPower.run()).toThrow(/platform dependent/);
  });
});

describe("IEC string and state conventions", () => {
  it("spells BOOL strings in uppercase in IEC sources", () => {
    const { run } = setup(true, "VAR\n yes : STRING;\n no : STRING;\nEND_VAR", "@yes := BOOL_TO_STRING(TRUE); @no := BOOL_TO_STRING(FALSE);");
    expect(run()).toMatchObject({ YES: "TRUE", NO: "FALSE" });
  });

  it("handles the recorded string edge positions", () => {
    const { run } = setup(true, "VAR\n first : STRING;\n last : STRING;\n empty : STRING;\n removed : STRING;\n past : STRING;\n replaced : STRING;\n zero : STRING;\n found : INT;\nEND_VAR", `
  @first := INSERT('ABCDE', 'xy', 0);
  @last := INSERT('ABCDE', 'xy', 5);
  @empty := INSERT('', 'xy', 0);
  @removed := DELETE('ABCDE', 1, 5);
  @past := DELETE('ABCDE', 2, 6);
  @replaced := REPLACE('ABCDE', 'xy', 1, 5);
  @zero := REPLACE('ABCDE', 'xy', 1, 0);
  @found := FIND('ABCDE', '');
`);
    expect(run()).toMatchObject({ FIRST: "xyABCDE", LAST: "ABCDExy", EMPTY: "xy", REMOVED: "ABCD", PAST: "ABCDE", REPLACED: "ABCDxy", ZERO: "xyABCDE", FOUND: 0 });
  });

  it("preserves Siemens refusal of string positions it does not simulate", () => {
    for (const expression of ["INSERT('ABCDE', 'xy', 0)", "DELETE('ABCDE', 2, 6)", "REPLACE('ABCDE', 'xy', 1, 0)"]) {
      expect(() => setup(false, "VAR\n s : STRING;\nEND_VAR", `@s := ${expression};`).run()).toThrow(/not a character|not within/);
    }
  });

  it.each([false, true])("accepts native counter/latch names, CTU past PV and CTD boundaries (IEC = %s)", (iec) => {
    const reset = iec ? "RESET" : "R";
    const load = iec ? "LOAD" : "LD";
    const { inst, run } = setup(iec, "VAR_INPUT\n pulse : BOOL;\n reset : BOOL;\n load : BOOL;\nEND_VAR\nVAR\n up : CTU;\n down : CTD;\n both : CTUD;\n setLatch : SR;\n resetLatch : RS;\nEND_VAR", `
  @up(CU := @pulse, ${reset} := @reset, PV := 2);
  @down(CD := @pulse, ${load} := @load, PV := 2);
  @both(CU := @pulse, CD := @pulse, ${reset} := @reset, ${load} := @load, PV := 2);
  @setLatch(${iec ? "SET1" : "S1"} := TRUE, ${reset} := TRUE);
  @resetLatch(${iec ? "SET" : "S"} := TRUE, ${iec ? "RESET1" : "R1"} := TRUE);
`);
    run({ reset: true, load: true });
    run({ reset: false, load: false, pulse: true });
    run({ pulse: false });
    run({ pulse: true });
    run({ pulse: false });
    run({ pulse: true });
    expect(inst.mem.UP).toMatchObject({ mem: { CV: 3, Q: true } });
    expect(inst.mem.DOWN).toMatchObject({ mem: { CV: iec ? 0 : -1, Q: true } });
    expect(inst.mem.BOTH).toMatchObject({ mem: { CV: 0, QD: true } });
    expect(inst.mem.SETLATCH).toMatchObject({ mem: { Q1: true } });
    expect(inst.mem.RESETLATCH).toMatchObject({ mem: { Q1: false } });
    run({ reset: true, load: true });
    expect(inst.mem.BOTH).toMatchObject({ mem: { CV: 0 } });
  });

  it("does not accept IEC RESET on a Siemens counter call", () => {
    expect(() => setup(false, "VAR\n c : CTU;\nEND_VAR", "@c(CU := FALSE, RESET := TRUE, PV := 2);").run()).toThrow(/RESET is not an input/);
  });

  it("selects rounding by the called block's form in a mixed workspace", () => {
    const index = new WorkspaceIndex();
    index.set("file:///w/Siemens.scl", "FUNCTION Siemens : INT\nBEGIN\n #Siemens := REAL_TO_INT(REAL#2.5);\nEND_FUNCTION", 0);
    index.set("file:///w/IEC.TcPOU", `<TcPlcObject><POU Name="IEC"><Declaration><![CDATA[FUNCTION IEC : INT]]></Declaration><Implementation><ST><![CDATA[IEC := REAL_TO_INT(REAL#2.5);]]></ST></Implementation></POU></TcPlcObject>`, 0);
    index.set("file:///w/Probe.st", "FUNCTION_BLOCK Probe\nVAR\n even : INT;\n away : INT;\nEND_VAR\neven := Siemens();\naway := IEC();\nEND_FUNCTION_BLOCK", 0);
    const sim = new Simulator(index);
    const inst = sim.newInstance("Probe");
    sim.callBlock(inst);
    expect(inst.mem).toMatchObject({ EVEN: 2, AWAY: 3 });
  });
});
