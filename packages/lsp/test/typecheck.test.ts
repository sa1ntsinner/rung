// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, conversion, diagnostics } from "../src/index.js";

describe("assignments as TIA Portal V20 compiles them", () => {
  it("the table: refused, warned, converted (TIA Portal's own answers)", () => {
    expect(conversion("Int", "Real")).toBe("warning"); // TIA Portal truncates, and warns
    expect(conversion("Int", "DInt")).toBe("warning");
    expect(conversion("DInt", "Int")).toBe("ok");
    expect(conversion("Real", "LInt")).toBe("warning");
    expect(conversion("Bool", "Byte")).toBe("error");
    expect(conversion("String[20]", "Char")).toBe("ok");
    expect(conversion("Char", "String")).toBe("warning"); // the first character, with a warning
    expect(conversion("TOD", "DInt")).toBe("warning");
    expect(conversion("Time", "DInt")).toBe("ok");
    expect(conversion("Time", "Int")).toBe("error");
    expect(conversion("Int", "Int")).toBe("same");
    expect(conversion('"Ud_X"', "Int")).toBeUndefined();
  });

  it("judges a := b with variables, members and DB values on both sides; not expressions or elements", () => {
    const i = new WorkspaceIndex();
    i.set("file:///w/plc/P/types/Ud_S.udt", 'TYPE "Ud_S"\n   STRUCT\n      t : Time;\n   END_STRUCT;\nEND_TYPE\n', 0);
    i.set("file:///w/plc/P/blocks/Plant.db", 'DATA_BLOCK "Plant"\n   VAR\n      speed : DInt;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n', 0);
    const text = `FUNCTION_BLOCK "X"
VAR
  i : Int;
  d : DInt;
  s : "Ud_S";
  arr : Array[0..3] of Real;
END_VAR
BEGIN
  #i := #s.t;
  #i := "Plant".speed;
  #d := #i;
  #i := #s.t + 1;
  #arr[0] := #i;
  IF #d > 0 THEN #i := #d; END_IF;
END_FUNCTION_BLOCK
`;
    i.set("file:///w/plc/P/blocks/X.scl", text, 0);
    const found = diagnostics(i, "file:///w/plc/P/blocks/X.scl")
      .filter((d) => d.code.startsWith("TYPE_"))
      .map((d) => `${d.code} ${text.slice(d.start, d.end)}`);
    expect(found).toEqual(["TYPE_MISMATCH #s.t", 'TYPE_NARROWING "Plant".speed', "TYPE_NARROWING #d"]);
  });

  it("judges a block call's arguments by the same table (inputs and outputs; not IN_OUT or expressions)", () => {
    const i = new WorkspaceIndex();
    i.set("file:///w/plc/P/blocks/Fc_P.scl", 'FUNCTION "Fc_P" : Void\nVAR_INPUT\n  n : Int;\n  t : Time;\nEND_VAR\nVAR_OUTPUT\n  r : DInt;\nEND_VAR\nVAR_IN_OUT\n  io : Int;\nEND_VAR\nBEGIN\n  #r := 1;\nEND_FUNCTION\n', 0);
    const text = 'FUNCTION_BLOCK "X"\nVAR\n  d : DInt;\n  b : Bool;\n  i : Int;\nEND_VAR\nBEGIN\n  "Fc_P"(n := #d, t := #b, r => #i, io := #d);\n  "Fc_P"(n := #d + 1, t := #d, r => #d, io := #i);\nEND_FUNCTION_BLOCK\n';
    i.set("file:///w/plc/P/blocks/X.scl", text, 0);
    const found = diagnostics(i, "file:///w/plc/P/blocks/X.scl")
      .filter((d) => d.code.startsWith("TYPE_"))
      .map((d) => `${d.code} ${text.slice(d.start, d.end)}`);
    expect(found).toEqual(["TYPE_NARROWING #d", "TYPE_MISMATCH #b", "TYPE_NARROWING #i"]);
  });
});
