// SPDX-License-Identifier: BUSL-1.1
// System instructions the simulator runs, with the values the TIA Portal help gives for them.
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { Simulator, type Struct } from "../src/runtime.js";
import { runTestFile } from "../src/index.js";

function sim(src: Record<string, string>) {
  const idx = new WorkspaceIndex();
  for (const [k, v] of Object.entries(src)) idx.set(`file:///w/plc/P/blocks/${k}.scl`, v, 0);
  return new Simulator(idx);
}
const fb = (name: string, decl: string, body: string) => `FUNCTION_BLOCK "${name}"\n${decl}\nBEGIN\n${body}\nEND_FUNCTION_BLOCK\n`;
const run = (s: Simulator, name: string, inputs: Record<string, unknown> = {}): Struct => {
  const i = s.newInstance(name);
  s.callBlock(i, inputs as never);
  return i.mem;
};
const errorOf = (f: () => unknown) => {
  try {
    f();
    return "no error";
  } catch (e) {
    return (e as Error).message;
  }
};
const dtl = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => ({ YEAR: y, MONTH: mo, DAY: d, WEEKDAY: 0, HOUR: h, MINUTE: mi, SECOND: s, NANOSECOND: 0 });

describe("system instructions", () => {
  it("SWAP reverses the bytes of a WORD, DWORD or LWORD, a slice or a conversion", () => {
    const s = sim({
      Sw: fb(
        "Sw",
        "VAR\n  w : Word := 16#1234;\n  d : DWord := 16#1234_5678;\n  l : LWord := 16#11;\n  i : Int := 258;\n  n : Int := -2;\n  ow : Word;\n  od : DWord;\n  ol : LWord;\n  os : Word;\n  oc : Word;\n  oi : Word;\n  on : Word;\nEND_VAR",
        "  #ow := SWAP(#w);\n  #od := SWAP(#d);\n  #ol := SWAP(#l);\n  #os := SWAP(#d.%W1);\n  #oc := SWAP(INT_TO_WORD(#i));\n  #oi := SWAP(#i);\n  #on := SWAP(#n);",
      ),
      Bad: fb("Bad", "VAR\n  b : Byte;\n  o : Byte;\nEND_VAR", "  #o := SWAP(#b);"),
    });
    // an Int is taken as the Word of its bits: -2 is 16#FFFE
    expect(run(s, "Sw")).toMatchObject({ OW: 0x3412, OD: 0x78563412, OL: Number(0x1100_0000_0000_0000n), OS: 0x3412, OC: 0x0201, OI: 0x0201, ON: 0xfeff });
    expect(errorOf(() => run(s, "Bad"))).toBe("SWAP: IN must be 16, 32 or 64 bits wide (a WORD, DWORD, LWORD or an integer of that width); it is BYTE");
  });

  it("64-bit values are exact up to 2^53 and beyond where a double holds them; any other result stops the test", () => {
    const s = sim({
      Wide: fb(
        "Wide",
        "VAR\n  sw : LWord;\n  shl64 : LWord;\n  shl63 : LWord;\n  right : LWord;\n  both : LWord;\nEND_VAR",
        "  #sw := SWAP(LWORD#16#FF);\n  #shl64 := SHL(IN := LWORD#1, N := 64);\n  #shl63 := SHL(IN := LWORD#1, N := 63);\n  #right := SHR(IN := LWORD#16#8000_0000_0000_0000, N := 63);\n  #both := LWORD#16#FF00_0000_0000_0000 AND LWORD#16#F000_0000_0000_0000;",
      ),
      Swap7: fb("Swap7", "VAR\n  w : LWord := 16#01_0203_0405_06FF;\n  o : LWord;\nEND_VAR", "  #o := SWAP(#w);"),
      Not0: fb("Not0", "VAR\n  w : LWord;\n  o : LWord;\nEND_VAR", "  #o := NOT #w;"),
      Sum: fb("Sum", "VAR\n  l : LInt := 9007199254740992;\n  o : LInt;\nEND_VAR", "  #o := #l + 1;"),
      Big: fb("Big", "VAR\n  o : LWord;\nEND_VAR", "  #o := LWORD#16#FFFF_FFFF_FFFF_FFFF;"),
      // 2^55 / 5 is 7205759403792793.6: the quotient of two doubles rounds up to ...94 before it is cut
      Div: fb("Div", "VAR\n  l : LInt := 36028797018963968;\n  o : LInt;\nEND_VAR", "  #o := #l / 5;"),
      // a bit or a byte into a 64-bit value: 2^53 + 1 has no double, 2^53 + 2 has one
      Bit0: fb("Bit0", "VAR\n  w : LWord := 9007199254740992;\nEND_VAR", "  #w.%X0 := TRUE;"),
      Bit1: fb("Bit1", "VAR\n  w : LWord := 9007199254740992;\nEND_VAR", "  #w.%X1 := TRUE;"),
      Byte0: fb("Byte0", "VAR\n  w : LWord := 9007199254740992;\nEND_VAR", "  #w.%B0 := 16#03;"),
    });
    expect(run(s, "Wide")).toMatchObject({ SW: Number(0xff00_0000_0000_0000n), SHL64: 0, SHL63: 2 ** 63, RIGHT: 1, BOTH: Number(0xf000_0000_0000_0000n) });
    expect(run(s, "Div")).toMatchObject({ O: 7205759403792793 });
    expect(errorOf(() => run(s, "Swap7"))).toBe("SWAP: the result 16#FF06050403020100 cannot be held exactly: the simulator keeps integers exact up to 2^53, and beyond only where a double holds them");
    expect(errorOf(() => run(s, "Not0"))).toBe("the 64-bit value 16#FFFFFFFFFFFFFFFF cannot be held exactly: the simulator keeps integers exact up to 2^53, and beyond only where a double holds them");
    expect(errorOf(() => run(s, "Sum"))).toMatch(/^the 64-bit value 16#20000000000001 cannot be held exactly/);
    expect(errorOf(() => run(s, "Big"))).toMatch(/LWORD#16#FFFF_FFFF_FFFF_FFFF cannot be held exactly/);
    expect(run(s, "Bit1")).toMatchObject({ W: 2 ** 53 + 2 });
    expect(errorOf(() => run(s, "Bit0"))).toMatch(/^the 64-bit value 16#20000000000001 cannot be held exactly/);
    expect(errorOf(() => run(s, "Byte0"))).toMatch(/^the 64-bit value 16#20000000000003 cannot be held exactly/);
  });

  it("RD_SYS_T and RD_LOC_T read the virtual clock: 2024-01-01 00:00 (a Monday) plus the virtual time", () => {
    const s = sim({
      Clk: fb("Clk", "VAR\n  now : DTL;\n  loc : DTL;\n  dt : Date_And_Time;\n  ret : Int := -1;\nEND_VAR", "  #ret := RD_SYS_T(OUT => #now);\n  RD_LOC_T(#loc);\n  RD_SYS_T(OUT => #dt);"),
      Bad: fb("Bad", "VAR\n  t : Time;\nEND_VAR", "  RD_SYS_T(OUT => #t);"),
    });
    s.time = 90_061_500; // 1 day, 1 hour, 1 minute and 1.5 s after the start
    const m = run(s, "Clk");
    expect(m.NOW).toEqual({ YEAR: 2024, MONTH: 1, DAY: 2, WEEKDAY: 3, HOUR: 1, MINUTE: 1, SECOND: 1, NANOSECOND: 500_000_000 });
    expect(m.LOC).toEqual(m.NOW); // no time zone
    expect([m.RET, m.DT]).toEqual([0, Date.UTC(2024, 0, 2, 1, 1, 1, 500)]);
    expect(errorOf(() => run(s, "Bad"))).toBe("RD_SYS_T: OUT must be a DTL, DT or LDT variable");
  });

  it("RUNTIME measures virtual seconds since the last call with its MEM", () => {
    const s = sim({ Rt: fb("Rt", "VAR\n  mem : LReal;\n  first : LReal;\n  again : LReal;\nEND_VAR", "  #first := RUNTIME(#mem);\n  #again := RUNTIME(#mem);") });
    const i = s.newInstance("Rt");
    s.time = 100;
    s.callBlock(i);
    s.time = 350;
    s.callBlock(i);
    expect([i.mem.FIRST, i.mem.AGAIN, i.mem.MEM]).toEqual([0.25, 0, 0.35]); // code takes no time within a cycle
  });

  it("T_DIFF subtracts points in time of one kind into a TIME", () => {
    const s = sim({
      Td: fb(
        "Td",
        "VAR_INPUT\n  a : DTL;\n  b : DTL;\n  t1 : Time_Of_Day;\n  t2 : Time_Of_Day;\n  d1 : DT;\n  d2 : DT;\nEND_VAR\nVAR\n  dd : Time;\n  dt : Time;\n  dx : Time;\nEND_VAR",
        "  #dd := T_DIFF(IN1 := #a, IN2 := #b);\n  #dt := T_DIFF(IN1 := #t1, IN2 := #t2);\n  #dx := T_DIFF(IN1 := #d1, IN2 := #d2);",
      ),
      Mixed: fb("Mixed", "VAR\n  a : DTL;\n  t : Time_Of_Day;\n  o : Time;\nEND_VAR", "  #o := T_DIFF(IN1 := #a, IN2 := #t);"),
    });
    const m = run(s, "Td", { a: dtl(2024, 3, 1, 12), b: dtl(2024, 2, 28, 12), t1: 50_400_000, t2: 45_000_000, d1: Date.UTC(2024, 0, 2), d2: Date.UTC(2024, 0, 1) });
    expect([m.DD, m.DT, m.DX]).toEqual([172_800_000, 5_400_000, 86_400_000]); // T#2d (2024 is a leap year), T#1h30m, T#1d
    expect(errorOf(() => run(s, "Td", { a: dtl(2024, 3, 1), b: dtl(2024, 1, 1) }))).toBe("T_DIFF: the difference does not fit a TIME (at most T#24d20h31m23s647ms either way)");
    expect(errorOf(() => run(s, "Mixed"))).toBe("T_DIFF: IN1 and IN2 must be variables of one kind (DTL, DT, LDT, TOD or LTOD): they are DTL and TOD");
  });

  it("T_ADD and T_SUB add or subtract a TIME, the result of IN1's type", () => {
    const s = sim({
      Ta: fb(
        "Ta",
        "VAR_INPUT\n  a : DTL;\n  d : DT;\n  t : Time;\n  tod : TOD;\nEND_VAR\nVAR\n  later : DTL;\n  before : DT;\n  sum : Time;\n  lap : TOD;\nEND_VAR",
        "  #later := T_ADD(IN1 := #a, IN2 := T#2h);\n  #before := T_SUB(IN1 := #d, IN2 := T#1s);\n  #sum := T_ADD(IN1 := #t, IN2 := T#30m);\n  #lap := T_ADD(IN1 := #tod, IN2 := T#2h);",
      ),
    });
    const m = run(s, "Ta", { a: dtl(2024, 2, 28, 23), d: Date.UTC(2024, 0, 1), t: 3_600_000, tod: 3_600_000 });
    expect(m.LATER).toEqual({ YEAR: 2024, MONTH: 2, DAY: 29, WEEKDAY: 5, HOUR: 1, MINUTE: 0, SECOND: 0, NANOSECOND: 0 }); // a Thursday
    expect([m.BEFORE, m.SUM, m.LAP]).toEqual([Date.UTC(2023, 11, 31, 23, 59, 59), 5_400_000, 10_800_000]);
    expect(errorOf(() => run(s, "Ta", { a: dtl(2024, 1, 1), d: Date.UTC(2024, 0, 1), t: 0, tod: 82_800_000 }))).toBe("T_ADD: the result leaves the day (TOD past midnight is not simulated)");
  });

  it("IS_ARRAY, LOWER_BOUND and UPPER_BOUND see what a VARIANT or ARRAY[*] was given", () => {
    const s = sim({
      Is: 'FUNCTION "Is" : Bool\nVAR_INPUT\n  v : Variant;\nEND_VAR\nBEGIN\n  #Is := IS_ARRAY(#v);\nEND_FUNCTION\n',
      Lo: 'FUNCTION "Lo" : DInt\nVAR_INPUT\n  dim : UDInt;\nEND_VAR\nVAR_IN_OUT\n  a : Array[*, *] of Int;\nEND_VAR\nBEGIN\n  #Lo := LOWER_BOUND(ARR := #a, DIM := #dim);\nEND_FUNCTION\n',
      Hi: 'FUNCTION "Hi" : DInt\nVAR_IN_OUT\n  a : Array[*] of Int;\nEND_VAR\nBEGIN\n  #Hi := UPPER_BOUND(ARR := #a, DIM := 1);\nEND_FUNCTION\n',
      B: fb(
        "B",
        "VAR\n  one : Array[-2..5] of Int;\n  two : Array[1..3, 0..4] of Int;\n  n : Int;\n  isOne : Bool;\n  isN : Bool;\n  lo1 : DInt;\n  hi1 : DInt;\n  lo2 : DInt;\nEND_VAR",
        '  #isOne := "Is"(#one);\n  #isN := "Is"(#n);\n  #hi1 := "Hi"(#one);\n  #lo1 := "Lo"(dim := 1, a := #two);\n  #lo2 := "Lo"(dim := 2, a := #two);',
      ),
      Three: fb("Three", "VAR\n  two : Array[1..3, 0..4] of Int;\n  x : DInt;\nEND_VAR", "  #x := LOWER_BOUND(ARR := #two, DIM := 3);"),
    });
    expect(run(s, "B")).toMatchObject({ ISONE: true, ISN: false, HI1: 5, LO1: 1, LO2: 0 });
    expect(errorOf(() => run(s, "Three"))).toBe("LOWER_BOUND: DIM 3: the array has 2 dimensions");
  });

  it("CountOfElements counts the elements of every dimension of the array a VARIANT points to", () => {
    const s = sim({
      Cnt: 'FUNCTION "Cnt" : UDInt\nVAR_INPUT\n  v : Variant;\nEND_VAR\nBEGIN\n  #Cnt := CountOfElements(#v);\nEND_FUNCTION\n',
      C: fb("C", "VAR\n  one : Array[-2..5] of Int;\n  two : Array[1..3, 0..4] of Real;\n  n1 : UDInt;\n  n2 : UDInt;\nEND_VAR", '  #n1 := "Cnt"(#one);\n  #n2 := "Cnt"(#two);'),
      Bits: fb("Bits", "VAR\n  b : Array[0..1] of Bool;\n  n : UDInt;\nEND_VAR", '  #n := "Cnt"(#b);'),
    });
    expect(run(s, "C")).toMatchObject({ N1: 8, N2: 15 });
    expect(errorOf(() => run(s, "Bits"))).toBe("COUNTOFELEMENTS: an ARRAY of BOOL is counted with its fill bits on the PLC; that is not simulated");
  });

  it("MOVE_BLK copies COUNT elements, FILL_BLK fills them; structures are copied, not shared", () => {
    const decl = "VAR\n  a : Array[0..9] of Int;\n  b : Array[0..9] of Int;\n  s : Array[1..2] of Struct\n    x : Int;\n  END_STRUCT;\n  t : Array[1..2] of Struct\n    x : Int;\n  END_STRUCT;\n  i : Int;\nEND_VAR";
    const s = sim({
      Mv: fb(
        "Mv",
        decl,
        "  FOR #i := 0 TO 9 DO\n    #a[#i] := #i + 1;\n  END_FOR;\n  MOVE_BLK(IN := #a[2], COUNT := 3, OUT => #b[5]);\n  UMOVE_BLK(IN := #a[0], COUNT := 1, OUT => #b[0]);\n  FILL_BLK(IN := 7, COUNT := 2, OUT => #b[8]);\n  UFILL_BLK(IN := -1, COUNT := 1, OUT => #b[1]);\n  #s[1].x := 4;\n  MOVE_BLK(IN := #s[1], COUNT := 2, OUT => #t[1]);\n  #s[1].x := 9;",
      ),
      Past: fb("Past", decl, "  MOVE_BLK(IN := #a[8], COUNT := 3, OUT => #b[0]);"),
      Overlap: fb("Overlap", decl, "  MOVE_BLK(IN := #a[0], COUNT := 3, OUT => #a[1]);"),
      Whole: fb("Whole", decl, "  FILL_BLK(IN := 0, COUNT := 2, OUT => #i);"),
    });
    const m = run(s, "Mv");
    expect((m.B as { items: number[] }).items).toEqual([1, -1, 0, 0, 0, 3, 4, 5, 7, 7]);
    expect((m.T as { items: Struct[] }).items).toEqual([{ X: 4 }, { X: 0 }]);
    expect(errorOf(() => run(s, "Past"))).toBe("MOVE_BLK: COUNT 3 from IN runs past the end of its array (2 elements from there)");
    expect(errorOf(() => run(s, "Overlap"))).toBe("MOVE_BLK: IN and OUT overlap in one array: an overlapping copy is not simulated");
    expect(errorOf(() => run(s, "Whole"))).toBe("FILL_BLK: OUT must be an element of an array, such as #buffer[0]");
  });

  it("VAL_STRG writes a number right-aligned in SIZE characters, with PREC decimals, as in the TIA Portal help", () => {
    const call = (value: string, type: string, size: number, prec: number, format: string) =>
      run(sim({ V: fb("V", `VAR\n  v : ${type} := ${value};\n  s : String;\nEND_VAR`, `  #s := '';\n  VAL_STRG(IN := #v, SIZE := ${size}, PREC := ${prec}, FORMAT := ${format}, P := 1, OUT => #s);`) }), "V").S;
    expect(call("123", "UInt", 10, 0, "16#0000")).toBe("       123");
    expect(call("0", "UInt", 10, 2, "16#0000")).toBe("      0.00");
    expect(call("12345678", "UDInt", 10, 3, "16#0000")).toBe(" 12345.678");
    expect(call("12345678", "UDInt", 10, 3, "16#0001")).toBe(" 12345,678");
    expect(call("123", "Int", 10, 0, "16#0004")).toBe("      +123");
    expect(call("-123", "Int", 10, 0, "16#0004")).toBe("      -123");
    expect(call("-0.00123", "Real", 10, 4, "16#0004")).toBe("   -0.0012");
    expect(call("12.345", "Real", 0, 2, "16#0000")).toBe("12.35"); // SIZE 0: as many characters as it needs
    expect(errorOf(() => call("-0.00123", "Real", 10, 4, "16#0006"))).toBe("VAL_STRG: exponential notation (FORMAT bit 1) is not simulated");
    expect(errorOf(() => call("12345678", "UDInt", 6, 3, "16#0000"))).toBe("VAL_STRG: IN needs 9 characters (12345.678) but SIZE is 6");
    const into = sim({ V: fb("V", "VAR\n  v : Int := 5;\n  s : String := 'ab';\nEND_VAR", "  VAL_STRG(IN := #v, SIZE := 0, PREC := 0, FORMAT := 16#0000, P := 1, OUT => #s);") });
    expect(errorOf(() => run(into, "V"))).toBe("VAL_STRG: OUT already has characters at P 1 and after: clear it first (writing into the middle of a string is not simulated)");
  });

  it("DELETE, INSERT and REPLACE work on characters from position P, like IEC 61131-3", () => {
    const s = sim({
      Str: fb(
        "Str",
        "VAR\n  d : String;\n  i : String;\n  r : String;\n  c : String;\nEND_VAR",
        "  #d := DELETE(IN := 'ABXYC', L := 2, P := 3);\n  #i := INSERT(IN1 := 'ABC', IN2 := 'XY', P := 2);\n  #r := REPLACE(IN1 := 'ABCDE', IN2 := 'X', L := 2, P := 3);\n  #c := CONCAT(IN2 := 'b', IN1 := 'a', IN3 := 'c');",
      ),
      Bad: fb("Bad", "VAR\n  d : String;\nEND_VAR", "  #d := DELETE(IN := 'ABC', L := 1, P := 0);"),
    });
    expect(run(s, "Str")).toMatchObject({ D: "ABC", I: "ABXYC", R: "ABXE", C: "abc" });
    expect(errorOf(() => run(s, "Bad"))).toBe("DELETE: L 1 characters from P 0 are not within IN (3 characters)");
  });

  it("communication, diagnostics and the instructions it does not model stop the test and say so", () => {
    const s = sim({
      Rd: fb("Rd", "VAR\n  ret : Int;\n  v : Real;\n  p : UInt := 1;\nEND_VAR", "  #ret := RDREC(REQ := TRUE, ID := 256, INDEX := 1, MLEN := 4);"),
      Sv: fb("Sv", "VAR\n  v : Real;\n  p : UInt := 1;\nEND_VAR", "  STRG_VAL(IN := '12', FORMAT := 16#0000, P := #p, OUT => #v);"),
    });
    const rest = "is not simulated: communication, motion, diagnostics, data logging and the other system instructions are not part of the offline simulator (docs/testing.md lists the ones it runs)";
    expect(errorOf(() => run(s, "Rd"))).toBe(`RDREC ${rest}; a test can stand in for it with stubs: { RDREC: {} }`);
    expect(errorOf(() => run(s, "Sv"))).toBe(`STRG_VAL ${rest}; a test can stand in for it with stubs: { STRG_VAL: {} }`);
  });

  it("rung test reads the virtual clock after advance", async () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/P/blocks/Fx_Clock.scl", fb("Fx_Clock", "VAR_OUTPUT\n  now : DTL;\nEND_VAR", "  RD_LOC_T(#now);"), 0);
    const r = await runTestFile(idx, "tests/clock.test.yaml", "block: Fx_Clock\ncycle: 100ms\ncases:\n  - steps:\n      - advance: 61s\n      - expect: { now.YEAR: 2024, now.MINUTE: 1, now.SECOND: 1, now.WEEKDAY: 2 }\n");
    expect(r.cases.map((c) => [c.passed, c.error, c.failures])).toEqual([[true, undefined, []]]);
  });
});
