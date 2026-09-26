// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { detectBlockType, findBlockHeaders, headerAt } from "../src/core/headers";

describe("findBlockHeaders", () => {
  it("finds every block kind with quoted and plain names", () => {
    const text = [
      'FUNCTION_BLOCK "Valve"',
      "VAR_INPUT x : Bool; END_VAR",
      "END_FUNCTION_BLOCK",
      'FUNCTION "Scale" : Real',
      "END_FUNCTION",
      "ORGANIZATION_BLOCK Main",
      "END_ORGANIZATION_BLOCK",
      '  DATA_BLOCK "Settings"',
      "END_DATA_BLOCK",
      'TYPE "Motor_T"',
      "END_TYPE",
    ].join("\n");
    expect(findBlockHeaders(text)).toEqual([
      { line: 0, column: 0, keyword: "FUNCTION_BLOCK", name: "Valve" },
      { line: 3, column: 0, keyword: "FUNCTION", name: "Scale" },
      { line: 5, column: 0, keyword: "ORGANIZATION_BLOCK", name: "Main" },
      { line: 7, column: 2, keyword: "DATA_BLOCK", name: "Settings" },
      { line: 9, column: 0, keyword: "TYPE", name: "Motor_T" },
    ]);
  });

  it("does not read FUNCTION out of FUNCTION_BLOCK or END_FUNCTION", () => {
    const h = findBlockHeaders('FUNCTION_BLOCK "A"\nEND_FUNCTION_BLOCK\nEND_FUNCTION\n');
    expect(h.map((x) => x.keyword)).toEqual(["FUNCTION_BLOCK"]);
  });

  it("skips headers inside comments", () => {
    const text = ['// FUNCTION_BLOCK "Line"', '(* FUNCTION "Multi', 'FUNCTION_BLOCK "Inside" *)', '/* TYPE "C" */ FUNCTION "After"', "  (* one line *) FUNCTION_BLOCK \"Real\""].join("\r\n");
    expect(findBlockHeaders(text).map((h) => h.name)).toEqual(["After", "Real"]);
  });

  it("accepts lower-case keywords and CRLF", () => {
    expect(findBlockHeaders('function_block "x"\r\nend_function_block')).toEqual([{ line: 0, column: 0, keyword: "FUNCTION_BLOCK", name: "x" }]);
  });

  it("headerAt picks the block around a line", () => {
    const h = findBlockHeaders('FUNCTION "A" : Void\nEND_FUNCTION\nFUNCTION "B" : Void\nx := 1;\nEND_FUNCTION');
    expect(headerAt(h, 3)?.name).toBe("B");
    expect(headerAt(h, 1)?.name).toBe("A");
    expect(headerAt([], 0)).toBeUndefined();
  });
});

describe("detectBlockType", () => {
  it("uses the form for db and udt", () => {
    expect(detectBlockType("db", "")).toBe("DB");
    expect(detectBlockType("udt", "")).toBe("UDT");
  });
  it("reads SCL and AWL headers", () => {
    expect(detectBlockType("scl", '// comment\nORGANIZATION_BLOCK "Main"')).toBe("OB");
    expect(detectBlockType("awl", 'FUNCTION "F" : Void')).toBe("FC");
    expect(detectBlockType("scl", "garbage")).toBeUndefined();
  });
  it("reads SimaticML", () => {
    expect(detectBlockType("xml", "<Document><SW.Blocks.FB ID='0'>")).toBe("FB");
    expect(detectBlockType("xml", "<SW.Blocks.InstanceDB ID='0'>")).toBe("DB");
    expect(detectBlockType("xml", "<SW.Types.PlcStruct ID='0'>")).toBe("UDT");
    expect(detectBlockType("xml", "<SW.Tags.PlcTagTable>")).toBeUndefined();
  });
  it("reads protected.yaml", () => {
    expect(detectBlockType("protected.yaml", '# x\naddress: "plc:A/blocks/X"\nkind: "block"\nblockType: "FB"\n')).toBe("FB");
    expect(detectBlockType("protected.yaml", 'kind: "block"\nblockType: "GlobalDB"\n')).toBe("DB");
    expect(detectBlockType("protected.yaml", 'kind: "type"\nblockType: null\n')).toBe("UDT");
  });
});
