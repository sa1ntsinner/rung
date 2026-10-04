// SPDX-License-Identifier: BUSL-1.1
// Rows pasted from Excel or TIA Portal's interface table, read into declarations before anything is written.
import { describe, it, expect } from "vitest";
import { parsePastedRows } from "../src/declarationPaste.js";

describe("parsePastedRows", () => {
  it("reads English column names, in any order, and ignores other columns", () => {
    const r = parsePastedRows("Name\tData type\tDefault value\tRetain\tComment\r\nSpeed\tReal\t1500.0\tFalse\trated speed\r\nRun\tBool\t\tFalse\t\r\n");
    expect(r).toEqual({
      rows: [
        { name: "Speed", type: "Real", start: "1500.0", comment: "rated speed" },
        { name: "Run", type: "Bool" },
      ],
      errors: [],
    });
  });

  it("reads German column names and Start value", () => {
    const r = parsePastedRows("Kommentar\tName\tDatentyp\tStartwert\nramp\tAccel\tLReal\t2.5\n");
    expect(r.rows).toEqual([{ name: "Accel", type: "LReal", start: "2.5", comment: "ramp" }]);
  });

  it("without a header: name, type, start value, comment", () => {
    expect(parsePastedRows("a\tInt\t5\tfive\nb\tBool").rows).toEqual([
      { name: "a", type: "Int", start: "5", comment: "five" },
      { name: "b", type: "Bool" },
    ]);
  });

  it("reads Excel's quoted fields with tabs, quotes and line breaks, skips empty lines", () => {
    const r = parsePastedRows('Name\tData type\tComment\n"x y"\tString[10]\t"says ""hi""\tthere"\n\n\nz\tInt\t"two\nlines"\n');
    expect(r.rows).toEqual([
      { name: "x y", type: "String[10]", comment: 'says "hi"\tthere' },
      { name: "z", type: "Int", comment: "two lines" },
    ]);
  });

  it("an empty quoted cell is empty; a row whose type is no type is an error", () => {
    expect(parsePastedRows('a\tInt\t""\tnote').rows).toEqual([{ name: "a", type: "Int", comment: "note" }]);
    expect(parsePastedRows("b\tInt garbage").errors).toEqual([{ line: 1, message: '"Int garbage" is not a data type.' }]);
  });

  it("strips TIA's quotes around a name and keeps a quoted type", () => {
    expect(parsePastedRows('"30ms"\t"T_Pos"').rows).toEqual([{ name: "30ms", type: '"T_Pos"' }]);
  });

  it("reports a row with no type by its line, keeps the others", () => {
    const r = parsePastedRows("Name\tData type\nok\tInt\nbad\t\n\tInt\n");
    expect(r.rows).toEqual([{ name: "ok", type: "Int" }]);
    expect(r.errors).toEqual([
      { line: 3, message: '"bad" has no data type.' },
      { line: 4, message: "A row has no name." },
    ]);
  });

  it("a single word is not a table", () => {
    expect(parsePastedRows("Speed")).toEqual({ rows: [], errors: [{ line: 1, message: '"Speed" has no data type.' }] });
    expect(parsePastedRows("")).toEqual({ rows: [], errors: [] });
  });
});
