// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, codeActions, diagnostics, hover, type QuickFix } from "../src/index.js";

const FB = "file:///w/plc/P/blocks/Fx_Line.scl";
const MOTOR = 'FUNCTION_BLOCK "Fx_Motor"\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\n   VAR_INPUT \n      Start : Bool;\n   END_VAR\n\nBEGIN\n\t;\nEND_FUNCTION_BLOCK\n';

function workspace(line: string) {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/plc/P/blocks/Fx_Motor.scl", MOTOR, 0);
  idx.set(FB, line, 0);
  return idx;
}
const apply = (text: string, f: QuickFix, uri = FB) =>
  f.edits
    .filter((e) => e.uri === uri)
    .sort((a, b) => b.start - a.start)
    .reduce((t, e) => t.slice(0, e.start) + e.newText + t.slice(e.end), text);
const at = (idx: WorkspaceIndex, needle: string) => idx.docs.get(FB)!.text.indexOf(needle) + 1;

describe("help on hover", () => {
  it("describes types in declarations: instructions with their parameters, data types with their range, PLC data types", () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/P/types/UDT_Motor.udt", 'TYPE "UDT_Motor"\nVERSION : 0.1\n   STRUCT\n      Speed : Real;\n   END_STRUCT;\n\nEND_TYPE\n', 0);
    const src = 'FUNCTION_BLOCK "Fx_T"\n   VAR \n      t : TON;\n      n : Int;\n      m : "UDT_Motor";\n   END_VAR\n\nBEGIN\n\t;\nEND_FUNCTION_BLOCK\n';
    idx.set(FB, src, 0);
    const h = (needle: string) => hover(idx, FB, src.indexOf(needle) + 1)?.markdown;
    expect(h("TON;")).toMatch(/^\*\*TON\*\* \(function block: call it through an instance\)\n\nOn-delay timer[\s\S]*\| PT \| Input \| Time \| preset time \|/);
    expect(h("Int;")).toBe("**Int**: 16-bit signed integer: -32768 to 32767");
    expect(h('"UDT_Motor"')).toBe("**PLC data type UDT_Motor**\n\n- Speed : Real");
  });
});

describe("quick fixes", () => {
  const LINE =
    'FUNCTION_BLOCK "Fx_Line"\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\n   VAR_INPUT \n      Go : Bool;\n   END_VAR\n\n   VAR_TEMP \n      t : Int;\n   END_VAR\n\n\nBEGIN\n\t#Speed := 12.5;\n\t#Busy := #Go AND #t > 0;\n\t"Fx_Motor"(Start := #Go);\nEND_FUNCTION_BLOCK\n';

  it("declares an undeclared local, with the type its use suggests, in the section it belongs to", () => {
    const idx = workspace(LINE);
    const fixes = codeActions(idx, FB, at(idx, "#Speed"), at(idx, "#Speed"));
    expect(fixes.map((f) => f.title)).toEqual(["Declare #Speed : Real as a temporary (VAR_TEMP)", "Declare #Speed : Real as a static (VAR, kept between calls)"]);
    expect(apply(LINE, fixes[0]!)).toContain("   VAR_TEMP \n      t : Int;\n      Speed : Real;\n   END_VAR\n");
    // no VAR section yet: it goes where TIA Portal writes it, after the inputs and before VAR_TEMP
    expect(apply(LINE, fixes[1]!)).toContain("   END_VAR\n\n   VAR \n      Speed : Real;\n   END_VAR\n   VAR_TEMP \n");
    expect(codeActions(idx, FB, at(idx, "#Busy"), at(idx, "#Busy"))[0]!.title).toBe("Declare #Busy : Bool as a temporary (VAR_TEMP)");
  });

  it("an FB called without an instance: a new instance DB or a multi-instance, like TIA Portal's call options", () => {
    const idx = workspace(LINE);
    expect(diagnostics(idx, FB).filter((d) => d.code === "NO_INSTANCE").map((d) => d.message)).toEqual([
      '"Fx_Motor" is a function block: call it through an instance, a new instance DB or a multi-instance (quick fix)',
    ]);
    const fixes = codeActions(idx, FB, at(idx, '"Fx_Motor"'), at(idx, '"Fx_Motor"'));
    expect(fixes.map((f) => f.title)).toEqual(['Create the instance DB "Fx_Motor_DB" and call "Fx_Motor" through it', 'Call "Fx_Motor" as the multi-instance #Fx_Motor_Instance of Fx_Line']);
    const [single, multi] = fixes;
    expect(single!.create).toEqual({ uri: "file:///w/plc/P/blocks/Fx_Motor_DB.db", text: 'DATA_BLOCK "Fx_Motor_DB"\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\nNON_RETAIN\n"Fx_Motor"\n\nBEGIN\n\nEND_DATA_BLOCK\n' });
    expect(apply(LINE, single!)).toContain('\t"Fx_Motor_DB"(Start := #Go);');
    const withMulti = apply(LINE, multi!);
    expect(withMulti).toContain('   VAR \n      Fx_Motor_Instance : "Fx_Motor";\n   END_VAR\n');
    expect(withMulti).toContain("\t#Fx_Motor_Instance(Start := #Go);");
    // the fixed block is clean
    idx.set(FB, withMulti, 1);
    expect(diagnostics(idx, FB).map((d) => d.code)).not.toContain("NO_INSTANCE");
  });

  it("does not reuse a DB name that exists", () => {
    const idx = workspace(LINE);
    idx.set("file:///w/plc/P/blocks/Fx_Motor_DB.db", 'DATA_BLOCK "Fx_Motor_DB"\n"Fx_Motor"\nBEGIN\nEND_DATA_BLOCK\n', 0);
    expect(codeActions(idx, FB, at(idx, '"Fx_Motor"('), at(idx, '"Fx_Motor"('))[0]!.title).toBe('Create the instance DB "Fx_Motor_DB_1" and call "Fx_Motor" through it');
  });
});
