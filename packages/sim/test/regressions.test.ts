// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { Simulator, type Instance, type Struct } from "../src/runtime.js";

function sim(src: Record<string, string>, maxSteps?: number) {
  const idx = new WorkspaceIndex();
  for (const [k, v] of Object.entries(src)) idx.set(k.includes("/") ? k : `file:///w/plc/P/blocks/${k}.scl`, v, 0);
  return new Simulator(idx, maxSteps);
}
const fb = (name: string, decl: string, body: string) => `FUNCTION_BLOCK "${name}"\n${decl}\nBEGIN\n${body}\nEND_FUNCTION_BLOCK\n`;
const run = (s: Simulator, name: string, inputs = {}): Struct => {
  const i = s.newInstance(name);
  s.callBlock(i, inputs);
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

describe("Simulator QA regressions", () => {
  it("RETURN in a called FC or FB ends only that call", () => {
    const s = sim({
      Early: 'FUNCTION "Early" : Int\nVAR_INPUT\n  x : Int;\nEND_VAR\nBEGIN\n  #Early := 1;\n  IF #x > 0 THEN\n    RETURN;\n  END_IF;\n  #Early := 2;\nEND_FUNCTION\n',
      Inner: fb("Inner", "VAR\n  n : Int;\nEND_VAR", "  #n := 1;\n  RETURN;\n  #n := 2;"),
      Caller: fb("Caller", 'VAR\n  a : Int;\n  b : Int;\n  i : "Inner";\nEND_VAR', '  #a := "Early"(x := 5);\n  #i();\n  #b := 42;'),
    });
    const m = run(s, "Caller");
    expect([m.A, m.B, (m.I as Instance).mem.N]).toEqual([1, 42, 1]);
  });

  it("divides REALs on members, globals and call results; INTs stay integer", () => {
    const s = sim({
      T: 'TYPE "T"\nSTRUCT\n  r : Real;\n  i : Int;\nEND_STRUCT;\nEND_TYPE\n',
      G: 'DATA_BLOCK "G"\nVAR\n  g : Real := 3.0;\n  n : Int := 7;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n',
      Half: 'FUNCTION "Half" : Real\nBEGIN\n  #Half := 5.0;\nEND_FUNCTION\n',
      R: fb(
        "R",
        'VAR\n  s : "T";\n  a : Array[0..1] of Real;\n  o1 : Real; o2 : Real; o3 : Real; o4 : Real; o5 : Real;\n  i1 : Int; i2 : Int;\nEND_VAR',
        '  #s.r := 5.0;\n  #s.i := 7;\n  #a[1] := 1.0;\n  #o1 := #s.r / 2;\n  #o2 := SQRT(4.0) / 4;\n  #o3 := "G".g / 4;\n  #o4 := "Half"() / 2;\n  #o5 := #a[1] / 4;\n  #i1 := #s.i / 2;\n  #i2 := "G".n / 2;',
      ),
    });
    const m = run(s, "R");
    expect([m.O1, m.O2, m.O3, m.O4, m.O5, m.I1, m.I2]).toEqual([2.5, 0.5, 0.75, 2.5, 0.25, 3, 3]);
  });

  it("matches CASE labels that are constants, ranges, lists, hex and typed literals", () => {
    const s = sim({
      C: fb(
        "C",
        "VAR_INPUT\n  st : Int;\nEND_VAR\nVAR_OUTPUT\n  hit : Int;\nEND_VAR\nVAR CONSTANT\n  IDLE : Int := 0;\n  RUN : Int := 1;\n  LAST : Int := 9;\nEND_VAR",
        "  CASE #st OF\n    #IDLE:\n      #hit := 10;\n    #RUN, 16#8201:\n      #hit := 11;\n    2..#LAST:\n      #hit := 12;\n    WORD#16#10, INT#-1:\n      #hit := 13;\n  ELSE\n    #hit := 99;\n  END_CASE;",
      ),
    });
    expect([0, 1, 0x8201, 5, 16, -1, 100].map((st) => run(s, "C", { st }).HIT)).toEqual([10, 11, 11, 12, 13, 13, 99]);
  });

  it("builds arrays inside array-of-struct elements with their own shape, quickly", () => {
    const members = Array.from({ length: 10 }, (_, k) => `      m${k} : Array[1..4] of Bool;`).join("\n");
    const s = sim({
      N: fb(
        "N",
        `VAR\n   sensor : Array[1..6] of Struct\n      zones : Array[1..4] of Struct\n         a : Bool;\n         b : Array[1..4] of Bool;\n      END_STRUCT;\n${members}\n   END_STRUCT;\n   grid : Array[0..1, 0..2] of Int;\nEND_VAR`,
        "   #sensor[2].zones[3].b[4] := TRUE;\n   #sensor[6].m9[4] := TRUE;\n   #grid[1, 2] := 7;",
      ),
    });
    const t0 = performance.now();
    const m = run(s, "N");
    expect(performance.now() - t0).toBeLessThan(500);
    const sensor = m.SENSOR as unknown as { items: { ZONES: { items: { B: { items: boolean[] } }[] }; M9: { items: boolean[] } }[] };
    expect(sensor.items).toHaveLength(6);
    expect(sensor.items[1]!.ZONES.items).toHaveLength(4);
    expect(sensor.items[1]!.ZONES.items[2]!.B.items).toEqual([false, false, false, true]);
    expect(sensor.items[5]!.M9.items).toEqual([false, false, false, true]);
    expect((m.GRID as unknown as { items: { items: number[] }[] }).items[1]!.items).toEqual([0, 0, 7]);
  });

  it("counts every loop iteration against the step limit (FOR BY 0, empty bodies)", () => {
    const f = sim({ L: fb("L", "VAR\n  i : Int;\nEND_VAR", "  FOR #i := 0 TO 10 BY 0 DO\n  END_FOR;") }, 10_000);
    expect(() => f.callBlock(f.newInstance("L"))).toThrow(/step limit/);
    const w = sim({ W: fb("W", "VAR\n  i : Int;\nEND_VAR", "  WHILE TRUE DO\n  END_WHILE;") }, 10_000);
    expect(() => w.callBlock(w.newInstance("W"))).toThrow(/step limit/);
  });

  it("supports END_REGION names, compound assignment, slice access and WSTRING literals", () => {
    const s = sim({
      X: fb(
        "X",
        "VAR\n  n : Int;\n  r : Real;\n  w : Word;\n  dw : DWord;\n  b3 : Bool;\n  b0 : Byte;\n  hi : Byte;\n  lo : Word;\n  ws : WString;\n  s : String;\n  c : Char;\nEND_VAR",
        "REGION setup data?\n  #n := 10;\n  #n += 5;\n  #n -= 1;\n  #n *= 2;\n  #n /= 4;\n  #r := 1.0;\n  #r /= 4;\nEND_REGION setup data?\n  #w := WORD#16#00F8;\n  #b3 := #w.%X3;\n  #w.%X0 := TRUE;\n  #w.%B1 := 16#AB;\n  #b0 := #w.%B0;\n  #dw := DW#16#12345678;\n  #hi := #dw.%B3;\n  #lo := #dw.%W0;\n  #dw.%D0 := 16#FFFFFFFF;\n  #ws := WSTRING#'wide';\n  #s := STRING#'it''s';\n  #c := CHAR#'z';",
      ),
    });
    const m = run(s, "X");
    expect([m.N, m.R, m.B3, m.W, m.B0, m.HI, m.LO, m.DW, m.WS, m.S, m.C]).toEqual([7, 0.25, true, 0xabf9, 0xf9, 0x12, 0x5678, 0xffffffff, "wide", "it's", "z"]);
  });

  it("fails calls of STL blocks the simulator does not run and of technology objects with a clear message", () => {
    const s = sim({
      "file:///w/plc/P/blocks/Stl.awl": 'FUNCTION "Stl" : Void\nVAR_INPUT\n  a : Bool;\nEND_VAR\nBEGIN\nNETWORK\nTITLE = x\n      A #a;\n      = #a;\n      TAK;\nEND_FUNCTION\n',
      "file:///w/plc/P/technology/Axis_1.xml": "<to/>",
      U: fb("U", "VAR\n  p : MC_POWER;\n  mode : Int;\nEND_VAR", '  CASE #mode OF\n    1: "Stl"(a := TRUE);\n    2: #p(Axis := "Axis_1", Enable := TRUE);\n    3: #mode := "Axis_1".StatusWord;\n  END_CASE;'),
    });
    const i = s.newInstance("U");
    expect(errorOf(() => s.callBlock(i, { mode: 1 }))).toMatch(/"Stl" uses STL instructions the simulator does not run yet: TAK/);
    expect(errorOf(() => s.callBlock(i, { mode: 2 }))).toMatch(/MC_POWER.*not simulated/);
    expect(errorOf(() => s.callBlock(i, { mode: 3 }))).toMatch(/"Axis_1" is a technology object.*not simulated/);
  });

  it("applies DB BEGIN start values, including instance DBs", () => {
    const s = sim({
      "file:///w/plc/P/blocks/D.db": 'DATA_BLOCK "D"\nVAR\n  cnt : Int := 100;\n  Plug : Struct\n    Delay : S5Time;\n  END_STRUCT;\n  arr : Array[1..2] of Int;\nEND_VAR\nBEGIN\n  cnt := 200;\n  Plug.Delay := S5T#1s;\n  arr[2] := 16#10;\nEND_DATA_BLOCK\n',
      Tm: fb("Tm", "VAR\n  T1 : TON_TIME;\n  n : Int;\nEND_VAR", "  #n := #n + 1;"),
      "file:///w/plc/P/blocks/Inst.db": 'DATA_BLOCK "Inst"\n"Tm"\nBEGIN\n  T1.PT := T#2s;\n  n := 5;\nEND_DATA_BLOCK\n',
      Use: 'FUNCTION "Use" : Int\nBEGIN\n  #Use := "D".cnt + "D".arr[2] + "Inst".n;\nEND_FUNCTION\n',
    });
    expect(s.callBlock("Use").returnValue).toBe(200 + 16 + 5);
    expect((s.globals.D as { PLUG: { DELAY: number } }).PLUG.DELAY).toBe(1000);
    expect(((s.globals.INST as Instance).mem.T1 as Instance).mem.PT).toBe(2000);
  });

  it("applies a DB's start values of members with quoted names", () => {
    const s = sim({
      "file:///w/plc/P/blocks/Fx_Valves.db": 'DATA_BLOCK "Fx_Valves"\nVAR\n  "Valve 1" : Struct\n    "Open, delay" : Time;\n  END_STRUCT;\nEND_VAR\nBEGIN\n  "Valve 1"."Open, delay" := T#2s;\nEND_DATA_BLOCK\n',
      Use: 'FUNCTION "Use" : Time\nBEGIN\n  #Use := "Fx_Valves"."Valve 1"."Open, delay";\nEND_FUNCTION\n',
    });
    expect(s.callBlock("Use").returnValue).toBe(2000);
  });

  it("runs IEC_TIMER / IEC_COUNTER instances and CTU_INT-style counters", () => {
    const s = sim({
      I: fb(
        "I",
        "VAR_INPUT\n  go : Bool;\nEND_VAR\nVAR\n  t : IEC_TIMER;\n  c : IEC_COUNTER;\n  u : CTU_INT;\n  q : Bool;\n  n : Int;\nEND_VAR",
        "  #t.TON(IN := #go, PT := T#20ms);\n  #c.CTU(CU := #go, PV := 2);\n  #u(CU := #go, R := FALSE, PV := 1, Q => #q, CV => #n);",
      ),
    });
    const i = s.newInstance("I");
    for (const [t, go] of [[0, true], [10, false], [20, true], [45, true]] as const) {
      s.time = t;
      s.callBlock(i, { go });
    }
    const t = i.mem.T as Instance;
    const c = i.mem.C as Instance;
    expect([t.mem.Q, t.mem.ET, c.mem.CV, c.mem.QU, i.mem.N, i.mem.Q]).toEqual([true, 20, 2, true, 2, true]);
  });

  it("sizes arrays with constant bounds", () => {
    const s = sim({
      A: fb("A", "VAR\n  items : Array[0..#N_LOC] of Int;\n  more : Array[1..N_LOC * 2] of Int;\nEND_VAR\nVAR CONSTANT\n  N_LOC : Int := 3;\nEND_VAR", "  #items[3] := 7;\n  #more[6] := 1;"),
    });
    const m = run(s, "A");
    expect([(m.ITEMS as unknown as { items: unknown[] }).items.length, (m.MORE as unknown as { items: unknown[] }).items.length]).toEqual([4, 6]);
  });

  it("rounds half to even like the PLC, divides REAL by zero to ±Inf/NaN, reports integer division by zero", () => {
    const s = sim({
      M: fb(
        "M",
        "VAR_INPUT\n  z : Int;\nEND_VAR\nVAR\n  r1 : DInt; r2 : DInt; r3 : DInt; r4 : DInt;\n  inf : Real; nan : Real;\n  q : Int;\nEND_VAR",
        "  #r1 := ROUND(2.5);\n  #r2 := ROUND(0.5);\n  #r3 := ROUND(-2.5);\n  #r4 := ROUND(1.6);\n  #inf := -1.0 / 0.0;\n  #nan := 0.0 / 0.0;\n  IF #z = 1 THEN #q := 5 / (#z - 1); END_IF;",
      ),
    });
    const m = run(s, "M", { z: 0 });
    expect([m.R1, m.R2, m.R3, m.R4, m.INF, Number.isNaN(m.NAN)]).toEqual([2, 0, -2, 2, -Infinity, true]);
    expect(errorOf(() => run(s, "M", { z: 1 }))).toMatch(/integer division by zero/);
  });

  it("gives readable errors for EXIT outside a loop, deep recursion and syntax errors", () => {
    const s = sim({
      E: fb("E", "VAR\n  n : Int;\nEND_VAR", "  EXIT;"),
      Rec: 'FUNCTION "Rec" : Int\nBEGIN\n  #Rec := "Rec"();\nEND_FUNCTION\n',
      Syn: fb("Syn", "VAR\n  n : Int;\nEND_VAR", "  #n := 1;\n  #n := ;"),
    });
    expect(errorOf(() => run(s, "E"))).toMatch(/EXIT outside of a loop/);
    expect(errorOf(() => s.callBlock("Rec"))).toMatch(/call depth.*recursion/);
    expect(errorOf(() => run(s, "Syn"))).toMatch(/Syntax error in Syn \(line 7\)/);
  });

  it("uses XML (SimaticML) DB start values and tag-table constants; XML blocks in a language it does not run (GRAPH) are reported as not simulated", () => {
    const xmlDb = '<?xml version="1.0"?>\n<Document><SW.Blocks.GlobalDB ID="0"><AttributeList><Interface><Sections><Section Name="Static"><Member Name="Speed" Datatype="Real"><StartValue>2.5</StartValue></Member></Section></Sections></Interface><Name>XDb</Name></AttributeList></SW.Blocks.GlobalDB></Document>';
    const xmlFb = '<?xml version="1.0"?>\n<Document><SW.Blocks.FB ID="0"><AttributeList><Interface><Sections><Section Name="Input"><Member Name="Go" Datatype="Bool" /></Section></Sections></Interface><Name>XFb</Name><ProgrammingLanguage>GRAPH</ProgrammingLanguage></AttributeList></SW.Blocks.FB></Document>';
    const tags = '<Document><SW.Tags.PlcTagTable ID="0"><AttributeList><Name>T</Name></AttributeList><ObjectList><SW.Tags.PlcUserConstant ID="1"><AttributeList><DataTypeName>Int</DataTypeName><Name>C_N</Name><Value>3</Value></AttributeList></SW.Tags.PlcUserConstant></ObjectList></SW.Tags.PlcTagTable></Document>';
    const s = sim({
      "file:///w/Program blocks/XDb.xml": xmlDb,
      "file:///w/Program blocks/XFb.xml": xmlFb,
      "file:///w/PLC tags/T.xml": tags,
      U: fb("U", 'VAR\n  r : Real;\n  a : Array[1.."C_N"] of Int;\n  x : "XFb";\n  mode : Int;\nEND_VAR', '  #r := "XDb".Speed * "C_N";\n  IF #mode = 1 THEN #x(Go := TRUE); END_IF;'),
    });
    const i = s.newInstance("U");
    s.callBlock(i);
    expect([i.mem.R, (i.mem.A as unknown as { items: unknown[] }).items.length]).toEqual([7.5, 3]);
    expect(errorOf(() => s.callBlock(i, { mode: 1 }))).toMatch(/"XFb" is kept as SimaticML XML in a language the simulator does not run/);
  });

  it("writes FC IN_OUT parameters back to the caller, named or positional", () => {
    const s = sim({
      Inc: 'FUNCTION "Inc" : Void\nVAR_IN_OUT\n  acc : Int;\nEND_VAR\nBEGIN\n  #acc := #acc + 1;\nEND_FUNCTION\n',
      O: fb("O", "VAR\n  a : Int;\n  b : Int;\nEND_VAR", '  "Inc"(acc := #a);\n  "Inc"(#b);'),
    });
    const i = s.newInstance("O");
    s.callBlock(i);
    s.callBlock(i);
    expect([i.mem.A, i.mem.B]).toEqual([2, 2]);
  });

  it("runs multiple assignments right to left and passes over a library block's (/* description */)", () => {
    const s = sim({
      M: fb("M", "VAR\n  a : Int;\n  b : Int;\n  c : Real;\n  done : Bool;\n  busy : Bool;\nEND_VAR", "  REGION DESCRIPTION\n  (/*\n  What the block does (and why).\n  */)\n  END_REGION\n  #a := #b := 7;\n  #done := #busy := #b > 5;\n  #c := #a := 3;"),
    });
    expect(run(s, "M")).toMatchObject({ A: 3, B: 7, C: 3, DONE: true, BUSY: true });
  });

  it("jumps with GOTO out of nested statements to a label, in a REGION too; ENO := is accepted", () => {
    const body = [
      "  ENO := TRUE;",
      "  REGION CHECK",
      "    IF #fault THEN",
      "      FOR #i := 1 TO 3 DO",
      "        #n := #n + 1;",
      "        GOTO Fx_Done;",
      "      END_FOR;",
      "    END_IF;",
      "  END_REGION",
      "  #n := #n + 10;",
      "  REGION REPORT",
      "  Fx_Done:",
      "    #reported := TRUE;",
      "  END_REGION",
    ].join("\n");
    const s = sim({
      G: fb("G", "VAR_INPUT\n  fault : Bool;\nEND_VAR\nVAR\n  n : Int;\n  reported : Bool;\nEND_VAR\nVAR_TEMP\n  i : Int;\nEND_VAR", body),
      Lost: fb("Lost", "VAR\n  n : Int;\nEND_VAR", "  IF #n = 0 THEN\n    Fx_Inner:\n    #n := 1;\n  END_IF;\n  GOTO Fx_Inner;"),
    });
    expect(run(s, "G", { fault: true })).toMatchObject({ N: 1, REPORTED: true });
    expect(run(s, "G", { fault: false })).toMatchObject({ N: 10, REPORTED: true });
    expect(errorOf(() => run(s, "Lost"))).toMatch(/GOTO Fx_Inner: Lost has no label Fx_Inner: in a statement list around the GOTO/);
  });
});
