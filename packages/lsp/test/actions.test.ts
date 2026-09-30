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

describe("update block calls, like TIA Portal", () => {
  const SCALE = 'FUNCTION "Fx_Scale" : Real\n   VAR_INPUT \n      Raw : Int;\n      Gain : Real;\n   END_VAR\n   VAR_IN_OUT \n      Stats : "UDT_Stats";\n   END_VAR\n\nBEGIN\n\t#Fx_Scale := #Raw * #Gain;\nEND_FUNCTION\n';
  const USER = 'FUNCTION_BLOCK "Fx_User"\n   VAR \n      t : TON;\n      v : Real;\n   END_VAR\n\nBEGIN\n\t#v := "Fx_Scale"(Raw := 3, Offset := 1);\n\t#t(IN := TRUE, PT := T#1s, PTT := T#2s);\n\t"Fx_Motor_DB"(Start := TRUE, Old := FALSE);\nEND_FUNCTION_BLOCK\n';
  const setup = () => {
    const idx = workspace(USER);
    idx.set("file:///w/plc/P/blocks/Fx_Scale.scl", SCALE, 0);
    idx.set("file:///w/plc/P/blocks/Fx_Motor_DB.db", 'DATA_BLOCK "Fx_Motor_DB"\n"Fx_Motor"\nBEGIN\nEND_DATA_BLOCK\n', 0);
    return idx;
  };

  it("flags arguments the callee no longer has and FC parameters a call leaves out", () => {
    const idx = setup();
    const d = diagnostics(idx, FB).filter((x) => x.code === "UNKNOWN_PARAMETER" || x.code === "MISSING_PARAMETER");
    expect(d.map((x) => `${x.code}: ${USER.slice(x.start, x.end)}: ${x.message}`)).toEqual([
      "UNKNOWN_PARAMETER: Offset: Offset is not a parameter of Fx_Scale (quick fix: remove it)",
      'MISSING_PARAMETER: "Fx_Scale": This call of Fx_Scale leaves out Gain, Stats: an FC gets every input and in/out (quick fix: add them)',
      "UNKNOWN_PARAMETER: PTT: PTT is not a parameter of TON (quick fix: remove it)",
      "UNKNOWN_PARAMETER: Old: Old is not a parameter of Fx_Motor (quick fix: remove it)",
    ]);
  });

  it("knows the parameters instructions take besides the numbered inputs (MUX's INELSE)", () => {
    const src = 'FUNCTION "Fx_Pick" : Int\n   VAR_INPUT \n      k : Int;\n   END_VAR\n\nBEGIN\n\t#Fx_Pick := MUX(K := #k, IN0 := 1, IN1 := 2, IN2 := 3, INELSE := 0);\n\t#Fx_Pick := MAX(IN1 := 1, IN2 := 2, IN3 := #k);\nEND_FUNCTION\n';
    const idx = workspace(src);
    expect(diagnostics(idx, FB).filter((x) => x.code === "UNKNOWN_PARAMETER")).toEqual([]);
  });

  it("removes a stale argument with its comma, and adds the missing parameters with values that compile", () => {
    const idx = setup();
    const at = (needle: string) => USER.indexOf(needle) + 1;
    const [remove] = codeActions(idx, FB, at("Offset"), at("Offset"));
    expect(remove!.title).toBe("Remove the argument Offset (Fx_Scale has no such parameter)");
    expect(apply(USER, remove!)).toContain('#v := "Fx_Scale"(Raw := 3);');
    const add = codeActions(idx, FB, at('"Fx_Scale"'), at('"Fx_Scale"')).find((f) => f.code === "MISSING_PARAMETER")!;
    expect(add.title).toBe("Add the missing parameters of Fx_Scale: Gain, Stats");
    expect(apply(USER, add)).toContain('#v := "Fx_Scale"(Raw := 3, Offset := 1, Gain := 0.0, Stats := #Stats);');
    const [ptt] = codeActions(idx, FB, at("PTT"), at("PTT"));
    expect(apply(USER, ptt!)).toContain("#t(IN := TRUE, PT := T#1s);");
  });
});

describe("define a PLC tag, like TIA Portal's Define tag", () => {
  const TABLE = "file:///w/plc/P/tags/Default%20tag%20table.tags.st";
  const table = "VAR_GLOBAL\n    A AT %M10.0 : Bool;\n    B AT %M10.1 : Bool;\nEND_VAR\n\nVAR_GLOBAL CONSTANT\n    K : Int := 3;\nEND_VAR\n";
  const src = 'FUNCTION "Fx_T" : Void\nBEGIN\n\t"Pump_On" := TRUE;\n\t"Level" := 5;\n\t"Fx_Missing"();\nEND_FUNCTION\n';
  const setup = () => {
    const idx = new WorkspaceIndex();
    idx.set(TABLE, table, 0);
    idx.set(FB, src, 0);
    return idx;
  };

  it("adds the tag to the tag table at the next free bit memory, with the type its use suggests", () => {
    const idx = setup();
    const on = codeActions(idx, FB, src.indexOf('"Pump_On"') + 1, src.indexOf('"Pump_On"') + 1).filter((f) => f.code === "UNKNOWN_GLOBAL");
    expect(on.map((f) => f.title)).toEqual(['Create the PLC tag "Pump_On" : Bool at %M10.2 in Default tag table']);
    expect(apply(table, on[0]!, TABLE)).toBe(table.replace("    B AT %M10.1 : Bool;\n", "    B AT %M10.1 : Bool;\n    Pump_On AT %M10.2 : Bool;\n"));
    const level = codeActions(idx, FB, src.indexOf('"Level"') + 1, src.indexOf('"Level"') + 1).find((f) => f.code === "UNKNOWN_GLOBAL")!;
    expect(level.title).toBe('Create the PLC tag "Level" : Int at %MW12 in Default tag table');
    expect(diagnostics(idx, FB).find((d) => d.code === "UNKNOWN_GLOBAL")!.message).toContain("quick fix: create it as a PLC tag");
    // a call is a block, not a tag
    expect(codeActions(idx, FB, src.indexOf('"Fx_Missing"') + 1, src.indexOf('"Fx_Missing"') + 1).filter((f) => f.code === "UNKNOWN_GLOBAL")).toEqual([]);
  });

  it("takes the next free bit memory of the file's own PLC", () => {
    const idx = setup();
    const other = "file:///w/plc/Q/tags/Default%20tag%20table.tags.st";
    idx.set(other, 'VAR_GLOBAL\n    Far AT %MD100 : DInt;\n    Recipe AT %M200.0 : "UDT_Recipe";\nEND_VAR\n', 0);
    const on = codeActions(idx, FB, src.indexOf('"Pump_On"') + 1, src.indexOf('"Pump_On"') + 1).filter((f) => f.code === "UNKNOWN_GLOBAL");
    expect(on.map((f) => f.title)).toEqual(['Create the PLC tag "Pump_On" : Bool at %M10.2 in Default tag table']);
  });

  it("goes past a 64-bit tag at a bit address, and chooses nothing where a tag's size is unknown", () => {
    const idx = new WorkspaceIndex();
    idx.set(TABLE, "VAR_GLOBAL\n    Wide AT %M0.0 : LReal;\nEND_VAR\n", 0);
    idx.set(FB, src, 0);
    const on = codeActions(idx, FB, src.indexOf('"Pump_On"') + 1, src.indexOf('"Pump_On"') + 1).find((f) => f.code === "UNKNOWN_GLOBAL")!;
    expect(on.title).toBe('Create the PLC tag "Pump_On" : Bool at %M8.0 in Default tag table');
    idx.set(TABLE, 'VAR_GLOBAL\n    Recipe AT %M20.0 : "UDT_Recipe";\nEND_VAR\n', 1);
    expect(codeActions(idx, FB, src.indexOf('"Pump_On"') + 1, src.indexOf('"Pump_On"') + 1).filter((f) => f.code === "UNKNOWN_GLOBAL")).toEqual([]);
  });
});

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
