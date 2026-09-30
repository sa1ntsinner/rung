// SPDX-License-Identifier: BUSL-1.1
// STL blocks on the simulator: the truth tables and accumulator rules of the S7-300/400 STL manual.
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { Simulator } from "../src/runtime.js";

const TAGS = "VAR_GLOBAL\n    Fx_Timer AT %T1 : Timer;\n    Fx_Start AT %I0.0 : Bool;\n    Fx_Lamp AT %Q0.0 : Bool;\nEND_VAR\n";

function sim(blocks: Record<string, string>) {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/plc/P/tags/Fx_Tags.tags.st", TAGS, 0);
  for (const [k, v] of Object.entries(blocks)) idx.set(`file:///w/plc/P/blocks/${k}.awl`, v, 0);
  return new Simulator(idx);
}
/** An STL block as TIA Portal exports it: header, interface, then one NETWORK per entry of `networks`. */
const awl = (kind: "FUNCTION" | "FUNCTION_BLOCK", name: string, decl: string, networks: string[], ret = "Void") =>
  `${kind} "${name}"${kind === "FUNCTION" ? ` : ${ret}` : ""}\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\n${decl}\nBEGIN\n` +
  networks.map((n, i) => `NETWORK\nTITLE = network ${i + 1}\n${n.split("\n").map((l) => `      ${l}`).join("\n")}\n`).join("") +
  `END_${kind}\n`;
const BITS = "   VAR_INPUT\n      a : Bool;\n      b : Bool;\n      c : Bool;\n      d : Bool;\n   END_VAR\n   VAR_OUTPUT\n      q : Bool;\n   END_VAR";
const fc = (net: string) => sim({ Fx_Logic: awl("FUNCTION", "Fx_Logic", BITS, [net]) });
/** Every combination of a, b, c, d against the expected q. */
const truth = (s: Simulator, want: (a: boolean, b: boolean, c: boolean, d: boolean) => boolean) => {
  for (let n = 0; n < 16; n++) {
    const [a, b, c, d] = [8, 4, 2, 1].map((m) => !!(n & m)) as [boolean, boolean, boolean, boolean];
    expect([a, b, c, d, s.callBlock("Fx_Logic", { a, b, c, d }).outputs.Q]).toEqual([a, b, c, d, want(a, b, c, d)]);
  }
};
const errorOf = (f: () => unknown) => {
  try {
    f();
    return "no error";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("STL bit logic", () => {
  it("A, AN, O, ON and X combine the test result with the RLO, in order (manual §1.2 to §1.7)", () => {
    // O with an operand ORs with the RLO so far, and an A after it ANDs with that: (a OR b) AND c
    truth(fc("A #a;\nO #b;\nA #c;\n= #q;"), (a, b, c) => (a || b) && c);
    truth(fc("A #a;\nA #b;\nO #c;\nA #d;\n= #q;"), (a, b, c, d) => ((a && b) || c) && d);
    truth(fc("AN #a;\nON #b;\nA #c;\n= #q;"), (a, b, c) => (!a || !b) && c);
    truth(fc("X #a;\nX #b;\nXN #c;\n= #q;"), (a, b, c) => (a !== b) !== !c);
    truth(fc("A #a;\nNOT;\n= #q;"), (a) => !a);
  });

  it("only O without an operand puts AND before OR (manual §1.8)", () => {
    truth(fc("A #a;\nA #b;\nO;\nA #c;\nA #d;\n= #q;"), (a, b, c, d) => (a && b) || (c && d));
    // the manual's example: A a; A b; O; A c; A d; O e — the last O with an operand ORs with the whole RLO
    truth(fc("A #a;\nA #b;\nO;\nA #c;\nO #d;\n= #q;"), (a, b, c, d) => (a && b) || c || d);
    truth(fc("A #a;\nO;\nA(;\nA #b;\nO #c;\n);\nA #d;\n= #q;"), (a, b, c, d) => a || ((b || c) && d));
  });

  it("A( ... ) nests a string; AN( and ON( negate it; at most 7 levels", () => {
    truth(fc("A(;\nA #a;\nO #b;\n);\nA(;\nA #c;\nO #d;\n);\n= #q;"), (a, b, c, d) => (a || b) && (c || d));
    truth(fc("A #a;\nO(;\nA #b;\nA #c;\n);\nAN(;\nA #d;\n);\n= #q;"), (a, b, c, d) => (a || (b && c)) && !d);
    truth(fc("ON(;\nA #a;\nA #b;\n);\nA #c;\n= #q;"), (a, b, c) => !(a && b) && c);
    // = or SD inside A( ... ) ends the string there and keeps its RLO, which ) then takes (a coil or timer in a LAD branch)
    truth(fc('A(;\nA #a;\n= #q;\n);\nA #b;\n= #q;'), (a, b) => a && b);
    truth(fc('A(;\nA #a;\nL S5T#1S;\nSD "Fx_Timer";\n);\nO #b;\n= #q;'), (a, b) => a || b);
    const deep = fc(`${"A(;\n".repeat(8)}A #a;\n${");\n".repeat(8)}= #q;`);
    expect(errorOf(() => deep.callBlock("Fx_Logic", {}))).toMatch(/more than 7 nested/);
  });

  it("=, S and R end the string and keep its RLO; SET and CLR set it", () => {
    truth(fc("A #a;\nA #b;\n= #q;\n= #q;"), (a, b) => a && b);
    const s = sim({
      Fx_Latch: awl("FUNCTION_BLOCK", "Fx_Latch", "   VAR_INPUT\n      set1 : Bool;\n      reset1 : Bool;\n   END_VAR\n   VAR_OUTPUT\n      q : Bool;\n      one : Bool;\n      zero : Bool;\n   END_VAR", ["A #set1;\nS #q;\nA #reset1;\nR #q;", "SET;\n= #one;\nCLR;\n= #zero;"]),
    });
    const i = s.newInstance("Fx_Latch");
    const q = (set1: boolean, reset1: boolean) => (s.callBlock(i, { set1, reset1 }), [i.mem.Q, i.mem.ONE, i.mem.ZERO]);
    expect([q(true, false), q(false, false), q(true, true), q(false, false)]).toEqual([
      [true, true, false],
      [true, true, false],
      [false, true, false], // R after S in the same scan: reset wins
      [false, true, false],
    ]);
  });

  it("FP and FN see an edge once, keep the RLO in their edge bit, and the string goes on", () => {
    const s = sim({
      Fx_Edge: awl(
        "FUNCTION_BLOCK",
        "Fx_Edge",
        "   VAR_INPUT\n      a : Bool;\n      b : Bool;\n   END_VAR\n   VAR_OUTPUT\n      up : Bool;\n      down : Bool;\n      upAndB : Bool;\n   END_VAR\n   VAR\n      m1 : Bool;\n      m2 : Bool;\n      m3 : Bool;\n   END_VAR",
        ["A #a;\nFP #m1;\n= #up;", "A #a;\nFN #m2;\n= #down;", "A #a;\nFP #m3;\nA #b;\n= #upAndB;"],
      ),
    });
    const i = s.newInstance("Fx_Edge");
    const seen = [false, true, true, false, false, true].map((a) => (s.callBlock(i, { a, b: true }), [i.mem.UP, i.mem.DOWN, i.mem.UPANDB, i.mem.M1]));
    expect(seen).toEqual([
      [false, false, false, false],
      [true, false, true, true],
      [false, false, false, true],
      [false, true, false, false],
      [false, false, false, false],
      [true, false, true, true],
    ]);
  });
});

describe("STL compares and jumps", () => {
  const CMP = "   VAR_INPUT\n      a : Bool;\n      x : Int;\n      y : Int;\n      dx : DInt;\n      dy : DInt;\n      rx : Real;\n      ry : Real;\n   END_VAR\n   VAR_OUTPUT\n      gt : Bool;\n      eqInA : Bool;\n      dne : Bool;\n      rlt : Bool;\n   END_VAR";
  it("a compare starts a logic string (or one inside A( ... )) and gives the RLO", () => {
    const s = sim({ Fx_Cmp: awl("FUNCTION", "Fx_Cmp", CMP, ["L #x;\nL #y;\n>I;\n= #gt;", "A #a;\nA(;\nL #x;\nL #y;\n==I;\n);\n= #eqInA;", "L #dx;\nL #dy;\n<>D;\n= #dne;", "L #rx;\nL #ry;\n<R;\n= #rlt;"]) });
    const out = (a: boolean, x: number, y: number) => s.callBlock("Fx_Cmp", { a, x, y, dx: x, dy: y, rx: x / 2, ry: y / 2 }).outputs;
    expect(out(true, -1, -2)).toMatchObject({ GT: true, EQINA: false, DNE: true, RLT: false }); // ACCU2 > ACCU1 as signed Ints
    expect(out(true, 3, 3)).toMatchObject({ GT: false, EQINA: true, DNE: false, RLT: false });
    expect(out(false, 3, 3)).toMatchObject({ EQINA: false });
    expect(out(true, 2, 5)).toMatchObject({ GT: false, RLT: true });
  });

  it("refuses a compare inside a running string, where the manual leaves the combination open", () => {
    const s = sim({ Fx_Cmp: awl("FUNCTION", "Fx_Cmp", CMP, ["A #a;\nL #x;\nL #y;\n>I;\n= #gt;"]) });
    expect(errorOf(() => s.callBlock("Fx_Cmp", { a: true }))).toBe(">I inside a running logic string is not simulated: start the string with it, or put it in A( ... )");
  });

  it("JC and JCN jump on the RLO and leave RLO = 1, /FC = 0 either way; JU and a loop back", () => {
    const decl = "   VAR_INPUT\n      a : Bool;\n   END_VAR\n   VAR_OUTPUT\n      q : Bool;\n      n : Int;\n      k : Int;\n   END_VAR";
    const s = sim({
      Fx_Jump: awl("FUNCTION", "Fx_Jump", decl, ["A #a;\nJC over;\n= #q;\nover: NOP 0;", "A #a;\nJCN skip;\nL 7;\nT #n;\nskip: NOP 0;", "L 0;\nT #k;\nagain: L #k;\nL 1;\n+I;\nT #k;\nL #k;\nL 5;\n<I;\nJC again;\nJU done;\nL 99;\nT #k;\ndone: NOP 0;"]),
    });
    // a = FALSE: JC does not jump, and the RLO it leaves is 1
    expect(s.callBlock("Fx_Jump", { a: false }).outputs).toMatchObject({ Q: true, N: 0, K: 5 });
    expect(s.callBlock("Fx_Jump", { a: true }).outputs).toMatchObject({ Q: false, N: 7, K: 5 });
  });

  it("a network does not end a logic string: it goes on in the next one (manual §1.22)", () => {
    const s = fc("A #a;");
    expect(s.callBlock("Fx_Logic", { a: true }).outputs.Q).toBe(false); // the block's end discards an open string
    truth(sim({ Fx_Logic: awl("FUNCTION", "Fx_Logic", BITS, ["A #a;", "A #b;\n= #q;"]) }), (a, b) => a && b);
  });
});

describe("STL accumulators", () => {
  const decl =
    "   VAR_INPUT\n      i : Int;\n      b : Byte;\n      w : Word;\n      r : Real;\n   END_VAR\n   VAR_OUTPUT\n      dw : DWord;\n      di : DInt;\n      sum : Int;\n      wrap : Int;\n      prod : DInt;\n      div : DWord;\n      swapped : Word;\n      rev : DWord;\n      low : Byte;\n      quot : Real;\n      rnd : DInt;\n      tr : DInt;\n      keepHigh : DWord;\n   END_VAR";
  const code = [
    "L #i;\nT #dw;\nL #i;\nITD;\nT #di;",
    "L #b;\nL 1;\n+I;\nT #sum;\nL 32767;\nL 1;\n+I;\nT #wrap;",
    "L 300;\nL 300;\n*I;\nT #prod;\nL 7;\nL 2;\n/I;\nT #div;",
    "L W#16#1234;\nCAW;\nT #swapped;\nL DW#16#1234_5678;\nCAD;\nT #rev;\nL #w;\nT #low;",
    "L 5;\nITD;\nDTR;\nL 2.0;\n/R;\nT #quot;\nL #r;\nRND;\nT #rnd;\nL #r;\nTRUNC;\nT #tr;",
    "L 1;\nL DW#16#0007_0000;\n+I;\nT #keepHigh;",
  ];
  const run = (inputs: Record<string, unknown>) => sim({ Fx_Acc: awl("FUNCTION", "Fx_Acc", decl, code) }).callBlock("Fx_Acc", inputs as never).outputs;

  it("L clears ACCU1 first: an Int of -1 is 16#0000FFFF until ITD extends its sign", () => {
    expect(run({ i: -1, b: 255, w: 0x1234, r: 2.5 })).toMatchObject({ DW: 0xffff, DI: -1, SUM: 256, WRAP: -32768 });
  });

  it("*I gives a DINT, /I the quotient in ACCU1-L and the remainder in ACCU1-H; +I leaves ACCU1-H alone", () => {
    expect(run({ i: 0, b: 0, w: 0, r: 0 })).toMatchObject({ PROD: 90000, DIV: 0x0001_0003, KEEPHIGH: 0x0007_0001 });
  });

  it("CAW and CAD swap bytes, T to a Byte keeps the low byte, DTR and /R work in REAL", () => {
    expect(run({ i: 0, b: 0, w: 0x1234, r: 0 })).toMatchObject({ SWAPPED: 0x3412, REV: 0x78563412, LOW: 0x34, QUOT: 2.5 });
  });

  it("RND rounds half way to the even number, TRUNC toward zero", () => {
    const rnd = (r: number) => [run({ i: 0, b: 0, w: 0, r }).RND, run({ i: 0, b: 0, w: 0, r }).TR];
    expect([rnd(2.5), rnd(3.5), rnd(-2.5), rnd(2.6), rnd(-2.7)]).toEqual([
      [2, 2],
      [4, 3],
      [-2, -2],
      [3, 2],
      [-3, -2],
    ]);
  });

  it("an FC's #RET_VAL is its return value; absolute addresses are the PLC tags at them", () => {
    const s = sim({
      Fx_Inc: awl("FUNCTION", "Fx_Inc", "   VAR_INPUT\n      x : Int;\n   END_VAR", ["L #x;\nL 1;\n+I;\nT #RET_VAL;"], "Int"),
      Fx_Io: awl("FUNCTION", "Fx_Io", "", ["A %I0.0;\n= %Q0.0;"]),
      Fx_NoTag: awl("FUNCTION", "Fx_NoTag", "", ["A %I7.7;\n= %Q0.0;"]),
    });
    expect(s.callBlock("Fx_Inc", { x: 41 }).returnValue).toBe(42);
    s.globals.FX_START = true;
    s.callBlock("Fx_Io");
    expect(s.globals.FX_LAMP).toBe(true);
    expect(errorOf(() => s.callBlock("Fx_NoTag"))).toBe("%I7.7 has no PLC tag: an address without a tag is not simulated");
  });
});

describe("STL S5 timers", () => {
  const decl = "   VAR_INPUT\n      start : Bool;\n   END_VAR\n   VAR_OUTPUT\n      done : Bool;\n   END_VAR\n   VAR\n      preset : Word := 16#1020;\n   END_VAR";
  const cycle = (s: Simulator, i: ReturnType<Simulator["newInstance"]>, start: boolean) => {
    s.time += 100;
    s.callBlock(i, { start });
    return i.mem.DONE;
  };

  it("SD starts on a rising RLO, is done once the time has passed while the RLO stays 1, and resets on 0", () => {
    const s = sim({ Fx_Delay: awl("FUNCTION_BLOCK", "Fx_Delay", decl, ["A #start;\nL S5T#2S;\nSD \"Fx_Timer\";", "A \"Fx_Timer\";\n= #done;"]) });
    const i = s.newInstance("Fx_Delay");
    // one cycle every 100 ms: start from 200 ms on, done at 2200 ms; RLO 0 resets; a new start counts from 0 again
    const seen = [false, ...Array(21).fill(true), false, true].map((st) => cycle(s, i, st));
    expect(seen.indexOf(true)).toBe(21);
    expect(seen.slice(21)).toEqual([true, false, false]);
  });

  it("takes the S5TIME from a Word (time base and BCD) or an S5Time variable, and refuses what is no S5TIME", () => {
    const fromWord = sim({ Fx_Delay: awl("FUNCTION_BLOCK", "Fx_Delay", decl, ["A #start;\nL #preset;\nSD \"Fx_Timer\";\nA \"Fx_Timer\";\n= #done;"]) });
    const i = fromWord.newInstance("Fx_Delay"); // 16#1020: 20 × 100 ms
    const seen = Array.from({ length: 21 }, () => cycle(fromWord, i, true));
    expect([seen[19], seen[20]]).toEqual([false, true]);
    const s5 = sim({ Fx_Delay: awl("FUNCTION_BLOCK", "Fx_Delay", decl.replace("preset : Word := 16#1020", "preset : S5Time := S5T#500MS"), ["A #start;\nL #preset;\nSD \"Fx_Timer\";\nA \"Fx_Timer\";\n= #done;"]) });
    const j = s5.newInstance("Fx_Delay");
    expect(Array.from({ length: 6 }, () => cycle(s5, j, true))).toEqual([false, false, false, false, false, true]);
    const bad = sim({ Fx_Delay: awl("FUNCTION_BLOCK", "Fx_Delay", decl.replace("16#1020", "16#00AF"), ["A #start;\nL #preset;\nSD \"Fx_Timer\";"]) });
    expect(errorOf(() => cycle(bad, bad.newInstance("Fx_Delay"), true))).toBe("SD: 16#af in ACCU1 is not an S5TIME (BCD digits 0 to 9)");
  });
});

describe("STL CALL", () => {
  const COUNT = 'FUNCTION_BLOCK "Fx_Count"\nVAR_INPUT\n  up : Bool;\nEND_VAR\nVAR_OUTPUT\n  n : Int;\nEND_VAR\nVAR\n  last : Bool;\nEND_VAR\nBEGIN\n  IF #up AND NOT #last THEN\n    #n := #n + 1;\n  END_IF;\n  #last := #up;\nEND_FUNCTION_BLOCK\n';
  const DOUBLE = 'FUNCTION "Fx_Double" : Int\nVAR_INPUT\n  x : Int;\nEND_VAR\nBEGIN\n  #Fx_Double := #x * 2;\nEND_FUNCTION\n';
  const caller = awl(
    "FUNCTION_BLOCK",
    "Fx_Caller",
    '   VAR_INPUT\n      go : Bool;\n   END_VAR\n   VAR_OUTPUT\n      n1 : Int;\n      n2 : Int;\n      d : Int;\n      after : Bool;\n   END_VAR\n   VAR\n      sub : "Fx_Count";\n   END_VAR',
    [
      'CALL "Fx_Count" , "Fx_Count_DB"\n(  up                          := #go ,\n   n                           := #n1\n);',
      "CALL #sub\n(  up := #go ,\n   n := #n2\n);",
      // CALL leaves the RLO as it was and ends the string (/FC = 0): the = after it writes the RLO from before
      'SET;\nCALL "Fx_Double"\n(  x := 21 ,\n   RET_VAL := #d\n);\n= #after;',
    ],
  );
  function workspace(extra: Record<string, string> = {}) {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/P/blocks/Fx_Count.scl", COUNT, 0);
    idx.set("file:///w/plc/P/blocks/Fx_Count_DB.db", 'DATA_BLOCK "Fx_Count_DB"\n"Fx_Count"\nBEGIN\nEND_DATA_BLOCK\n', 0);
    idx.set("file:///w/plc/P/blocks/Fx_Double.scl", DOUBLE, 0);
    idx.set("file:///w/plc/P/blocks/Fx_Caller.awl", caller, 0);
    for (const [k, v] of Object.entries(extra)) idx.set(`file:///w/plc/P/blocks/${k}`, v, 0);
    return new Simulator(idx);
  }

  it("calls an FB with its instance DB, a multi-instance and an FC with RET_VAL, every parameter with :=", () => {
    const s = workspace();
    const i = s.newInstance("Fx_Caller");
    const scan = (go: boolean) => (s.callBlock(i, { go }), [i.mem.N1, i.mem.N2, i.mem.D, i.mem.AFTER]);
    expect([scan(true), scan(true), scan(false), scan(true)]).toEqual([
      [1, 1, 42, true],
      [1, 1, 42, true],
      [1, 1, 42, true],
      [2, 2, 42, true],
    ]);
  });

  it("calls a stub where the FB is not in the workspace, and refuses a CALL by block number", () => {
    const s = workspace({
      "Lib_Pump_DB.db": 'DATA_BLOCK "Lib_Pump_DB"\n"Lib_Pump"\nBEGIN\nEND_DATA_BLOCK\n',
      "Fx_Pump.awl": awl("FUNCTION", "Fx_Pump", "   VAR_INPUT\n      go : Bool;\n   END_VAR\n   VAR_OUTPUT\n      running : Bool;\n   END_VAR", ['CALL "Lib_Pump" , "Lib_Pump_DB"\n(  start := #go\n);', 'A "Lib_Pump_DB".running;\n= #running;']),
      "Fx_Number.awl": awl("FUNCTION", "Fx_Number", "", ["CALL FB 10 , DB 10;"]),
    });
    s.stubs = new Map([["LIB_PUMP", { RUNNING: true }]]);
    expect(s.callBlock("Fx_Pump", { go: true }).outputs.RUNNING).toBe(true);
    expect(((s.globals.LIB_PUMP_DB as { mem: Record<string, unknown> }).mem.START)).toBe(true);
    expect(errorOf(() => s.callBlock("Fx_Number"))).toBe('"Fx_Number" uses STL instructions the simulator does not run yet: CALL of a block by number (FB 10, DB 10)');
  });
});

describe("STL outside the subset", () => {
  it("is refused before the block runs, with the list of what is missing", () => {
    const s = sim({ Fx_Old: awl("FUNCTION", "Fx_Old", BITS, ['A #a;\n= "Fx_Lamp";', "L 1;\nL 2;\nTAK;\nOPN DB 1;\nA [AR1,P#0.0];\nL P#1.0;\nJZ x;\nA OV;\nx: NOP 0;"]) });
    expect(errorOf(() => s.callBlock("Fx_Old", { a: true }))).toBe(
      '"Fx_Old" uses STL instructions the simulator does not run yet: JZ, OPN, TAK, indirect addressing ([...]), pointer constants (P#), status bits as operands (OV, OS, BR, ==0 ...)',
    );
    expect(s.globals.FX_LAMP).toBeUndefined(); // not even its first network ran
  });
});
