// SPDX-License-Identifier: BUSL-1.1
// A new object's file: where the workspace keeps it and the text TIA Portal V20 exports for it (checked by import,
// compile and export), or why it cannot be made (a name taken in the PLC, a name TIA refuses, a file there).
import { describe, it, expect } from "vitest";
import { newObject } from "../src/newObject.js";

const none = { names: new Set<string>(), types: new Set<string>(), tables: new Set<string>(), paths: [] as string[] };

describe("newObject", () => {
  it("an FB at the PLC's blocks folder, as TIA Portal exports a new one", () => {
    expect(newObject({ kind: "FB", name: "FB_Valve", plc: "PLC_1", groups: ["Line", "Valves"] }, none)).toEqual({
      path: "plc/PLC_1/blocks/Line/Valves/FB_Valve.scl",
      text: "FUNCTION_BLOCK \"FB_Valve\"\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\n\nBEGIN\nEND_FUNCTION_BLOCK\n\n",
    });
  });
  it("an FC with its return type, a DB, a UDT, a tag table, in a software unit", () => {
    expect(newObject({ kind: "FC", name: "Calc", plc: "PLC_1", returnType: "Int" }, none)).toMatchObject({ path: "plc/PLC_1/blocks/Calc.scl", text: expect.stringMatching(/^FUNCTION "Calc" : Int\n/) });
    expect(newObject({ kind: "DB", name: "Line_DB", plc: "PLC_1" }, none)).toMatchObject({ path: "plc/PLC_1/blocks/Line_DB.db", text: expect.stringContaining("NON_RETAIN\n   VAR \n      Tag_1 : Bool;\n   END_VAR\n") });
    expect(newObject({ kind: "UDT", name: "T_Pos", plc: "PLC_1", unit: "Conveyor" }, none)).toMatchObject({ path: "plc/PLC_1/units/Conveyor/types/T_Pos.udt", text: expect.stringContaining("   STRUCT\n      Tag_1 : Bool;\n   END_STRUCT;\n") });
    expect(newObject({ kind: "TAGS", name: "Inputs", plc: "PLC_1" }, none)).toMatchObject({ path: "plc/PLC_1/tags/Inputs.tags.st", text: expect.stringMatching(/^\/\/ PLC tag table Inputs in TIA Portal;[^\n]*\n[\s\S]*\nVAR_GLOBAL\nEND_VAR\n$/) });
  });
  it("a name any file system holds: escaped in the path, as written in the header", () => {
    expect(newObject({ kind: "FB", name: "Motor/1: Ü", plc: "PLC_1" }, none)).toMatchObject({ path: "plc/PLC_1/blocks/Motor%2F1%3A Ü.scl", text: expect.stringMatching(/^FUNCTION_BLOCK "Motor\/1: Ü"\n/) });
  });
  it("refuses a name taken in the PLC (blocks share one list), a name with a quote, an empty name, a file there", () => {
    expect(newObject({ kind: "DB", name: "fb_valve", plc: "PLC_1" }, { ...none, names: new Set(["fb_valve"]) })).toEqual({ reason: "PLC_1 already has a block fb_valve." });
    expect(newObject({ kind: "UDT", name: "FB_Valve", plc: "PLC_1" }, { ...none, names: new Set(["fb_valve"]) })).toMatchObject({ path: "plc/PLC_1/types/FB_Valve.udt" });
    expect(newObject({ kind: "UDT", name: "t_pos", plc: "PLC_1" }, { ...none, types: new Set(["t_pos"]) })).toEqual({ reason: "PLC_1 already has a data type t_pos." });
    expect(newObject({ kind: "FB", name: 'a"b', plc: "PLC_1" }, none)).toMatchObject({ reason: expect.stringContaining('"') });
    expect(newObject({ kind: "FB", name: "  ", plc: "PLC_1" }, none)).toMatchObject({ reason: expect.any(String) });
    expect(newObject({ kind: "FB", name: "X", plc: "PLC_1" }, { ...none, paths: ["plc/PLC_1/blocks/x.scl"] })).toMatchObject({ reason: expect.stringContaining("plc/PLC_1/blocks/x.scl") });
  });
});
