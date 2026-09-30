// SPDX-License-Identifier: BUSL-1.1
// VARIANT and ARRAY[*] parameters: bound to the caller's variable with its declared type, and the instructions
// that read them (TypeOf, TypeOfElements, VariantGet/Put, MOVE_BLK_VARIANT, CountOfElements, IS_NULL/NOT_NULL).
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { Simulator, type Struct } from "../src/runtime.js";

const POINT = 'TYPE "Fx_Point"\nVERSION : 0.1\n   STRUCT\n      x : Int;\n      y : Int;\n   END_STRUCT;\nEND_TYPE\n';

function sim(src: Record<string, string>) {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/plc/P/types/Fx_Point.udt", POINT, 0);
  for (const [k, v] of Object.entries(src)) idx.set(`file:///w/plc/P/blocks/${k}.scl`, v, 0);
  return new Simulator(idx);
}
const fb = (name: string, decl: string, body: string) => `FUNCTION_BLOCK "${name}"\n${decl}\nBEGIN\n${body}\nEND_FUNCTION_BLOCK\n`;
const fc = (name: string, ret: string, decl: string, body: string) => `FUNCTION "${name}" : ${ret}\n${decl}\nBEGIN\n${body}\nEND_FUNCTION\n`;
const run = (s: Simulator, name: string): Struct => {
  const i = s.newInstance(name);
  s.callBlock(i);
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

describe("VARIANT parameters", () => {
  it("TypeOf compares with a data type, a PLC data type or another TypeOf, also through a VARIANT passed on", () => {
    const s = sim({
      Kind: fc(
        "Kind",
        "Int",
        "VAR_INPUT\n  v : Variant;\nEND_VAR",
        '  IF TypeOf(#v) = Int THEN\n    #Kind := 1;\n  ELSIF TypeOf(#v) = Real THEN\n    #Kind := 2;\n  ELSIF TypeOf(#v) = "Fx_Point" THEN\n    #Kind := 3;\n  ELSIF TypeOf(#v) = String THEN\n    #Kind := 4;\n  ELSE\n    #Kind := 0;\n  END_IF;',
      ),
      Outer: fc("Outer", "Int", "VAR_INPUT\n  v : Variant;\nEND_VAR", '  #Outer := "Kind"(v := #v);'),
      Same: fc("Same", "Bool", "VAR_INPUT\n  a : Variant;\n  b : Variant;\nEND_VAR", "  #Same := TypeOf(#a) = TypeOf(#b);"),
      Caller: fb(
        "Caller",
        'VAR\n  i : Int;\n  r : Real;\n  p : "Fx_Point";\n  s : String[20];\n  b : Bool;\n  k : Array[1..5] of Int;\n  onInt : Int;\n  onReal : Int;\n  onPoint : Int;\n  onString : Int;\n  onBool : Int;\n  passedOn : Int;\n  same : Bool;\n  differ : Bool;\n  element : Int;\nEND_VAR',
        '  #onInt := "Kind"(v := #i);\n  #onReal := "Kind"(v := #r);\n  #onPoint := "Kind"(v := #p);\n  #onString := "Kind"(v := #s);\n  #onBool := "Kind"(v := #b);\n  #passedOn := "Outer"(v := #r);\n  #same := "Same"(a := #i, b := #k[2]);\n  #differ := "Same"(a := #i, b := #r);\n  #element := "Kind"(v := #k[3]);',
      ),
    });
    expect(run(s, "Caller")).toMatchObject({ ONINT: 1, ONREAL: 2, ONPOINT: 3, ONSTRING: 4, ONBOOL: 0, PASSEDON: 2, SAME: true, DIFFER: false, ELEMENT: 1 });
  });

  it("CASE TypeOfElements(...) OF picks the branch of the array's element type", () => {
    const s = sim({
      Elem: fc("Elem", "Int", "VAR_IN_OUT\n  a : Variant;\nEND_VAR", '  CASE TypeOfElements(#a) OF\n    Int:\n      #Elem := 1;\n    UInt, DInt:\n      #Elem := 2;\n    "Fx_Point":\n      #Elem := 3;\n    ELSE\n      #Elem := 0;\n  END_CASE;'),
      Caller: fb("Caller", 'VAR\n  ints : Array[0..3] of Int;\n  dints : Array[1..2] of DInt;\n  points : Array[1..2] of "Fx_Point";\n  bits : Array[0..7] of Bool;\n  e1 : Int;\n  e2 : Int;\n  e3 : Int;\n  e4 : Int;\nEND_VAR', '  #e1 := "Elem"(a := #ints);\n  #e2 := "Elem"(a := #dints);\n  #e3 := "Elem"(a := #points);\n  #e4 := "Elem"(a := #bits);'),
    });
    expect(run(s, "Caller")).toMatchObject({ E1: 1, E2: 2, E3: 3, E4: 0 });
  });

  it("TypeOf and TypeOfElements refuse what they would not answer on the PLC", () => {
    const s = sim({
      Of: fc("Of", "Bool", "VAR_INPUT\n  v : Variant;\nEND_VAR", "  #Of := TypeOf(#v) = Int;"),
      Els: fc("Els", "Bool", "VAR_INPUT\n  v : Variant;\nEND_VAR", "  #Els := TypeOfElements(#v) = Int;"),
      A: fb("A", "VAR\n  k : Array[1..2] of Int;\n  x : Bool;\nEND_VAR", '  #x := "Of"(v := #k);'),
      B: fb("B", "VAR\n  i : Int;\n  x : Bool;\nEND_VAR", '  #x := "Els"(v := #i);'),
      C: fb("C", "VAR\n  x : Bool;\nEND_VAR", '  #x := "Of"();'),
    });
    expect(errorOf(() => run(s, "A"))).toBe("TYPEOF: OPERAND is an ARRAY: TypeOfElements gives the data type of its elements");
    expect(errorOf(() => run(s, "B"))).toBe("TYPEOFELEMENTS: OPERAND is not an ARRAY (it is Int)");
    expect(errorOf(() => run(s, "C"))).toBe("TYPEOF: OPERAND is a VARIANT that points nowhere (the call gave it no variable)");
  });

  it("VariantGet reads and VariantPut writes the caller's variable, of one data type only", () => {
    const s = sim({
      Get: fc("Get", "Int", "VAR_INPUT\n  v : Variant;\nEND_VAR", "  VariantGet(SRC := #v, DST => #Get);"),
      Put: fc("Put", "Void", "VAR_IN_OUT\n  v : Variant;\nEND_VAR\nVAR_TEMP\n  x : Int;\nEND_VAR", "  #x := 42;\n  VariantPut(SRC := #x, DST := #v);"),
      Caller: fb("Caller", "VAR\n  i : Int := 7;\n  got : Int;\n  target : Int;\nEND_VAR", '  #got := "Get"(v := #i);\n  "Put"(v := #target);'),
      Wrong: fb("Wrong", "VAR\n  r : Real;\nEND_VAR", '  "Put"(v := #r);'),
    });
    expect(run(s, "Caller")).toMatchObject({ GOT: 7, TARGET: 42 });
    expect(errorOf(() => run(s, "Wrong"))).toBe("VARIANTPUT: SRC is Int and DST is Real: it copies between one data type only");
  });

  it("MOVE_BLK_VARIANT copies elements by 0-based index, into an array or a single variable, and returns 0", () => {
    // the pattern of a min search over any array: one element at a time into a variable of the element type
    const minOf = fc(
      "MinOf",
      "Void",
      "VAR_INPUT\n  values : Variant;\nEND_VAR\nVAR_OUTPUT\n  minValue : Variant;\n  minIndex : DInt;\n  ret : Int;\nEND_VAR\nVAR_TEMP\n  n : DInt;\n  i : DInt;\n  cur : Int;\n  best : Int;\nEND_VAR",
      "  #n := UDINT_TO_DINT(CountOfElements(#values));\n  #ret := MOVE_BLK_VARIANT(SRC := #values, COUNT := 1, SRC_INDEX := 0, DEST_INDEX := 0, DEST => #best);\n  FOR #i := 1 TO #n - 1 DO\n    #ret := MOVE_BLK_VARIANT(SRC := #values, COUNT := 1, SRC_INDEX := #i, DEST_INDEX := 0, DEST => #cur);\n    IF #cur < #best THEN\n      #best := #cur;\n      #minIndex := #i;\n    END_IF;\n  END_FOR;\n  #ret := MOVE_BLK_VARIANT(SRC := #values, COUNT := 1, SRC_INDEX := #minIndex, DEST_INDEX := 0, DEST => #minValue);",
    );
    const s = sim({
      MinOf: minOf,
      Caller: fb(
        "Caller",
        "VAR\n  a : Array[1..4] of Int;\n  b : Array[0..3] of Int;\n  m : Int;\n  at : DInt;\n  r1 : Int;\n  r2 : Int;\nEND_VAR",
        '  #a[1] := 7;\n  #a[2] := 3;\n  #a[3] := 9;\n  #a[4] := 5;\n  "MinOf"(values := #a, minValue => #m, minIndex => #at, ret => #r1);\n  #r2 := MOVE_BLK_VARIANT(SRC := #a, COUNT := 2, SRC_INDEX := 2, DEST_INDEX := 1, DEST => #b);',
      ),
      Past: fb("Past", "VAR\n  a : Array[1..4] of Int;\n  b : Array[0..3] of Int;\n  r : Int;\nEND_VAR", "  #r := MOVE_BLK_VARIANT(SRC := #a, COUNT := 3, SRC_INDEX := 2, DEST_INDEX := 0, DEST => #b);"),
      Types: fb("Types", "VAR\n  a : Array[1..4] of Int;\n  b : Array[0..3] of Real;\n  r : Int;\nEND_VAR", "  #r := MOVE_BLK_VARIANT(SRC := #a, COUNT := 1, SRC_INDEX := 0, DEST_INDEX := 0, DEST => #b);"),
      Overlap: fb("Overlap", "VAR\n  a : Array[1..4] of Int;\n  r : Int;\nEND_VAR", "  #r := MOVE_BLK_VARIANT(SRC := #a, COUNT := 2, SRC_INDEX := 0, DEST_INDEX := 1, DEST => #a);"),
    });
    const m = run(s, "Caller");
    expect([m.M, m.AT, m.R1, m.R2]).toEqual([3, 1, 0, 0]);
    expect((m.B as { items: number[] }).items).toEqual([0, 9, 5, 0]);
    expect(errorOf(() => run(s, "Past"))).toBe("MOVE_BLK_VARIANT: SRC_INDEX 2 and COUNT 3 run past SRC (4 elements)");
    expect(errorOf(() => run(s, "Types"))).toBe("MOVE_BLK_VARIANT: an element of SRC is Int and an element of DEST is Real: it copies between one data type only");
    expect(errorOf(() => run(s, "Overlap"))).toBe("MOVE_BLK_VARIANT: SRC and DEST overlap in one array: an overlapping copy is not simulated");
  });

  it("an ARRAY[*] parameter is the caller's array: bounds, element type and writes", () => {
    const s = sim({
      Fill: fc("Fill", "Bool", "VAR_IN_OUT\n  a : Array[*] of Int;\nEND_VAR\nVAR_TEMP\n  i : DInt;\nEND_VAR", "  FOR #i := LOWER_BOUND(ARR := #a, DIM := 1) TO UPPER_BOUND(ARR := #a, DIM := 1) DO\n    #a[#i] := DINT_TO_INT(#i) * 10;\n  END_FOR;\n  #Fill := TypeOfElements(#a) = Int;"),
      Caller: fb("Caller", "VAR\n  a : Array[-1..1] of Int;\n  isInt : Bool;\nEND_VAR", '  #isInt := "Fill"(a := #a);'),
    });
    const m = run(s, "Caller");
    expect([(m.A as { items: number[] }).items, m.ISINT]).toEqual([[-10, 0, 10], true]);
  });

  it("IS_NULL and NOT_NULL tell a REF_TO or VARIANT that points nowhere", () => {
    const s = sim({
      Given: fc("Given", "Bool", "VAR_IN_OUT\n  v : Variant;\nEND_VAR", "  #Given := NOT_NULL(#v);"),
      Caller: fb("Caller", "VAR\n  x : Int;\n  r : REF_TO Int;\n  before : Bool;\n  after : Bool;\n  bound : Bool;\n  given : Bool;\nEND_VAR", '  #before := IS_NULL(#r);\n  #r := REF(#x);\n  #after := IS_NULL(#r);\n  #bound := NOT_NULL(#r);\n  #given := "Given"(v := #x);'),
      Plain: fb("Plain", "VAR\n  x : Int;\n  n : Bool;\nEND_VAR", "  #n := IS_NULL(#x);"),
    });
    expect(run(s, "Caller")).toMatchObject({ BEFORE: true, AFTER: false, BOUND: true, GIVEN: true });
    expect(errorOf(() => run(s, "Plain"))).toBe("IS_NULL: OPERAND must be a REF_TO or VARIANT variable");
  });

  it("stays bound to the caller's variable when the structure or array around it is assigned anew", () => {
    const s = sim({
      // the callee first replaces what holds the variable, then writes through the VARIANT
      PutPoint: fc("PutPoint", "Void", 'VAR_IN_OUT\n  v : Variant;\nEND_VAR\nVAR_TEMP\n  x : Int;\nEND_VAR', '  "Fx_Data".point := "Fx_Data".other;\n  #x := 42;\n  VariantPut(SRC := #x, DST := #v);'),
      PutList: fc("PutList", "Void", 'VAR_IN_OUT\n  v : Variant;\nEND_VAR\nVAR_TEMP\n  x : Int;\nEND_VAR', '  "Fx_Data".list := "Fx_Data".spare;\n  #x := 42;\n  VariantPut(SRC := #x, DST := #v);'),
      Caller: fb("Caller", "VAR\n  i : Int := 2;\nEND_VAR", '  "PutPoint"(v := "Fx_Data".point.x);\n  "PutList"(v := "Fx_Data".list[#i]);'),
    });
    (s as unknown as { index: WorkspaceIndex }).index.set("file:///w/plc/P/blocks/Fx_Data.db", 'DATA_BLOCK "Fx_Data"\n   VAR\n      point : "Fx_Point";\n      other : "Fx_Point";\n      list : Array[1..3] of Int;\n      spare : Array[1..3] of Int;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n', 0);
    run(s, "Caller");
    const db = s.globals.FX_DATA as { POINT: Struct; LIST: { items: number[] } };
    expect([db.POINT.X, db.LIST.items]).toEqual([42, [0, 42, 0]]);
  });
});
