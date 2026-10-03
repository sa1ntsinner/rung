// SPDX-License-Identifier: BUSL-1.1
// The exact source spans of declarations: what a table edits must be found again byte for byte.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";

const FB = [
  'FUNCTION_BLOCK "Fx_Comm"',
  "{ S7_Optimized_Access := 'TRUE' }",
  "VERSION : 0.1",
  "   VAR RETAIN",
  "      agentNo : Int;   // agent number",
  "      feedback { ExternalWritable := 'False'} : Struct",
  "         speed { ExternalWritable := 'False'} : Real := 1.5;",
  "      END_STRUCT;",
  "      \"30msPls\" { S7_SetPoint := 'True'} : Bool;",
  "      buf : Array[0..255] of Byte;",
  "   END_VAR",
  "   VAR CONSTANT",
  "      PI : Real := 3.14159;",
  "   END_VAR",
  "BEGIN",
  "END_FUNCTION_BLOCK",
  "",
].join("\n");

const slice = (src: string, s?: { start: number; end: number }) => (s ? src.slice(s.start, s.end) : undefined);

describe("declaration spans", () => {
  it("cover name, attributes, type, start value and comment exactly", () => {
    const b = parse(FB).blocks[0]!;
    const [agentNo, feedback, pls, buf] = b.vars;
    expect(slice(FB, agentNo!.src!.name)).toBe("agentNo");
    expect(slice(FB, agentNo!.src!.type)).toBe("Int");
    expect(slice(FB, agentNo!.src!.comment)).toBe("// agent number");
    expect(slice(FB, agentNo!.src!.whole)).toBe("agentNo : Int;");
    expect(slice(FB, feedback!.src!.attrs)).toBe("{ ExternalWritable := 'False'}");
    expect(slice(FB, feedback!.src!.type)).toBe("Struct");
    expect(slice(FB, feedback!.src!.whole)).toMatch(/^feedback \{[\s\S]*END_STRUCT;$/);
    const speed = feedback!.members![0]!;
    expect(slice(FB, speed.src!.init)).toBe("1.5");
    expect(slice(FB, pls!.src!.name)).toBe('"30msPls"');
    expect(pls!.name).toBe("30msPls");
    expect(slice(FB, buf!.src!.type)).toBe("Array[0..255] of Byte");
  });

  it("record sections with their modifiers and body", () => {
    const b = parse(FB).blocks[0]!;
    expect(b.sections!.map((s) => [s.keyword, s.modifiers, s.section])).toEqual([
      ["VAR", ["RETAIN"], "Static"],
      ["VAR", ["CONSTANT"], "Constant"],
    ]);
    expect(slice(FB, b.sections![0]!.header)).toBe("VAR RETAIN");
    expect(slice(FB, b.sections![0]!.whole)).toMatch(/^VAR RETAIN[\s\S]*END_VAR$/);
  });

  it("spans are exact in a CRLF source with a BOM", () => {
    const crlf = "﻿" + FB.replace(/\n/g, "\r\n");
    const v = parse(crlf).blocks[0]!.vars[0]!;
    expect(slice(crlf, v.src!.whole)).toBe("agentNo : Int;");
    expect(slice(crlf, v.src!.comment)).toBe("// agent number");
  });
});
