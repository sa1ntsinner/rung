// SPDX-License-Identifier: BUSL-1.1
// Folding ranges and workspace symbols: finding one's way around a large project.
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "../src/workspace.js";
import { foldingRanges } from "../src/folding.js";
import { pathMembers, workspaceSymbols } from "../src/symbols.js";

const folds = (uri: string, text: string) => {
  const index = new WorkspaceIndex();
  return foldingRanges(index.set(uri, text, 1));
};

describe("folding ranges", () => {
  it("folds REGIONs as TIA Portal does, VAR sections, statements and the block, each up to the line before its END_", () => {
    const src = [
      'FUNCTION_BLOCK "Fx_Fold"', // 0
      "VAR_INPUT", // 1
      "   start : Bool;", // 2
      "END_VAR", // 3
      "VAR", // 4
      "   n : Int;", // 5
      "END_VAR", // 6
      "BEGIN", // 7
      "   REGION Inputs", // 8
      "      IF #start THEN", // 9
      "         #n := 1;", // 10
      "      ELSIF #n > 2 THEN", // 11
      "         #n := 2;", // 12
      "      END_IF;", // 13
      "      REGION inner", // 14
      "         #n := 3;", // 15
      "      END_REGION", // 16
      "   END_REGION", // 17
      "   CASE #n OF", // 18
      "      1:", // 19
      "         #n := 0;", // 20
      "   END_CASE;", // 21
      "   FOR #n := 1 TO 3 DO", // 22
      "      ;", // 23
      "   END_FOR;", // 24
      "END_FUNCTION_BLOCK", // 25
    ].join("\n");
    expect(folds("file:///w/plc/P/blocks/Fx_Fold.scl", src)).toEqual([
      { startLine: 0, endLine: 24 },
      { startLine: 1, endLine: 2 },
      { startLine: 4, endLine: 5 },
      { startLine: 8, endLine: 16, kind: "region" },
      { startLine: 9, endLine: 12 },
      { startLine: 14, endLine: 15, kind: "region" },
      { startLine: 18, endLine: 20 },
      { startLine: 22, endLine: 23 },
    ]);
  });

  it("is not fooled by keywords in strings and comments, folds comments, and leaves a statement still being typed open", () => {
    const src = [
      'FUNCTION "Fx_Text" : Void', // 0
      "VAR_TEMP", // 1
      "   s : String;", // 2
      "END_VAR", // 3
      "BEGIN", // 4
      "   // the first line of a comment", // 5
      "   // the second, IF this were code", // 6
      "   #s := 'IF END_IF REGION';", // 7
      "   (* a block comment", // 8
      "      over two lines with END_REGION *)", // 9
      "   IF #s = '' THEN", // 10
      "      #s := 'x'; // a comment after code", // 11
      "      // a comment of its own", // 12
      "END_FUNCTION", // 13
    ].join("\n");
    expect(folds("file:///w/plc/P/blocks/Fx_Text.scl", src)).toEqual([
      { startLine: 0, endLine: 12 },
      { startLine: 1, endLine: 2 },
      { startLine: 5, endLine: 6, kind: "comment" },
      { startLine: 8, endLine: 9, kind: "comment" },
    ]);
  });

  it("folds structured text of CODESYS and TwinCAT, and nothing of SimaticML", () => {
    const st = "PROGRAM PLC_PRG\nVAR\n    x : INT;\nEND_VAR\nWHILE x < 10 DO\n    x := x + 1;\nEND_WHILE\nEND_PROGRAM\n";
    expect(folds("file:///w/plc/Dev/blocks/PLC_PRG.st", st)).toEqual([
      { startLine: 0, endLine: 6 },
      { startLine: 1, endLine: 2 },
      { startLine: 4, endLine: 5 },
    ]);
    expect(folds("file:///w/plc/P/blocks/Fx_Lad.xml", '<?xml version="1.0"?>\n<Document>\nIF\n\nEND_IF\n</Document>\n')).toEqual([]);
  });
});

describe("workspace symbols", () => {
  const fb = (name: string) => `FUNCTION_BLOCK "${name}"\nBEGIN\nEND_FUNCTION_BLOCK\n`;

  it("finds blocks of every PLC with the PLC and folder as container, and tags with their table", () => {
    const index = new WorkspaceIndex();
    index.set("file:///w/plc/PLC_1/blocks/Drives/Fx_Motor.scl", fb("Fx_Motor"), 1);
    index.set("file:///w/plc/PLC_2/blocks/Fx_Motor.scl", fb("Fx_Motor"), 1);
    index.set("file:///w/plc/PLC_1/blocks/Fx_MotorGroup.scl", fb("Fx_MotorGroup"), 1);
    index.set("file:///w/plc/PLC_1/blocks/Fx_Pump.scl", fb("Fx_Pump"), 1);
    index.set("file:///w/plc/PLC_1/blocks/Fx_Pumpmotor.scl", fb("Fx_Pumpmotor"), 1);
    index.set("file:///w/plc/PLC_1/tags/Io.tags.st", "VAR_GLOBAL\n    MotorOn AT %Q0.0 : Bool;\nEND_VAR\nVAR_GLOBAL CONSTANT\n    MotorMax : Int := 3000;\nEND_VAR\n", 1);
    const found = workspaceSymbols(index, "motor");
    expect(found.map((s) => [s.name, s.container])).toEqual([
      ["Fx_Motor", "PLC_1 / Drives"],
      ["Fx_Motor", "PLC_2"],
      ["Fx_MotorGroup", "PLC_1"],
      ["MotorMax", "PLC_1 / Io"],
      ["MotorOn", "PLC_1 / Io"],
      ["Fx_Pumpmotor", "PLC_1"],
    ]);
    // the exact name first, names starting with the query before names containing it
    expect(workspaceSymbols(index, "Fx_Motor").map((s) => s.name)).toEqual(["Fx_Motor", "Fx_Motor", "Fx_MotorGroup"]);
    expect(workspaceSymbols(index, "motormax")[0]).toMatchObject({ kind: "TAG", constant: true });
    expect(workspaceSymbols(index, "").length).toBe(found.length + 1);
  });

  it("answers fast in a project of 1300 objects", () => {
    const index = new WorkspaceIndex();
    for (let i = 0; i < 1300; i++) index.set(`file:///w/plc/PLC_1/blocks/F${i % 30}/Perf_Drive_${i}.scl`, fb(`Perf_Drive_${i}`), 1);
    workspaceSymbols(index, "warm up");
    const t0 = performance.now();
    const found = workspaceSymbols(index, "drive_12");
    expect(performance.now() - t0).toBeLessThan(50);
    expect(found[0]!.name).toBe("Perf_Drive_12");
    expect(found).toHaveLength(111); // _12, _120 to _129, _1200 to _1299
  });
});

describe("members for a pick list", () => {
  it("lists one level below a DB, an instance DB, a struct member and a UDT-typed tag", () => {
    const index = new WorkspaceIndex();
    index.set("file:///w/plc/PLC_1/types/T_Point.udt", 'TYPE "T_Point"\nVERSION : 0.1\n   STRUCT\n      x : Real;\n      y : Real;\n   END_STRUCT;\nEND_TYPE\n', 1);
    index.set("file:///w/plc/PLC_1/blocks/Line_DB.db", 'DATA_BLOCK "Line_DB"\nVERSION : 0.1\n   VAR\n      Speed : Int;\n      Pos : "T_Point";\n      Run : Bool;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n', 1);
    index.set("file:///w/plc/PLC_1/blocks/FB_M.scl", 'FUNCTION_BLOCK "FB_M"\nVAR_INPUT\n   Start : Bool;\nEND_VAR\nVAR_TEMP\n   t : Int;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', 1);
    index.set("file:///w/plc/PLC_1/blocks/M_DB.db", 'DATA_BLOCK "M_DB"\nVERSION : 0.1\n"FB_M"\nBEGIN\nEND_DATA_BLOCK\n', 1);
    index.set("file:///w/plc/PLC_1/tags/Io.tags.st", 'VAR_GLOBAL\n    Home : "T_Point";\nEND_VAR\n', 1);
    const names = (path: string[]) => pathMembers(index, path).map((m) => `${m.name}:${m.type}${m.more ? "+" : ""}`);
    expect(names(["Line_DB"])).toEqual(["Speed:Int", "Pos:\"T_Point\"+", "Run:Bool"]);
    expect(names(["line_db", "Pos"])).toEqual(["x:Real", "y:Real"]);
    expect(names(["M_DB"])).toEqual(["Start:Bool"]);
    expect(names(["Home"])).toEqual(["x:Real", "y:Real"]);
    expect(names(["Line_DB", "Nope"])).toEqual([]);
  });
});
