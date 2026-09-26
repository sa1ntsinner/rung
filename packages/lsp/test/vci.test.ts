// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { WorkspaceIndex, uriOf, diagnostics, definition, hover, complete, parseSimaticMl } from "../src/index.js";

// A synthetic TIA Portal VCI export: Program blocks/, PLC tags/, PLC data types/, Technology objects/, .vci/
const dir = fileURLToPath(new URL("./vci/", import.meta.url));
const pump = () => uriOf(join(dir, "Program blocks", "Drives", "FB_Pump.scl"));
let idx: WorkspaceIndex;
const at = (needle: string, delta = 1) => idx.docs.get(pump())!.text.indexOf(needle) + delta;
const textAt = (l: { uri: string; start: number; end: number }) => idx.docs.get(l.uri)!.text.slice(l.start, l.end);

beforeAll(async () => {
  idx = new WorkspaceIndex();
  await idx.load(dir);
});

describe("TIA VCI export layout", () => {
  it("detects the layout and indexes SCL sources, XML blocks, data types, tag tables and technology objects", () => {
    expect(idx.layout).toBe("vci");
    const names = idx.allGlobals().map((g) => `${g.kind}:${g.name}`).sort();
    expect(names).toEqual(["DB:DB_Inst", "DB:DB_Plant", "DB:DB_Xml", "FB:FB_Lad", "FB:FB_Pump", "OBJECT:Axis_1", "TAG:C_MAX", "TAG:Pump running", "UDT:ST_Motor", "UDT:UDT_Scl"]);
    expect(idx.global("DB_Inst")!.block!.dbOf).toBe("FB_Lad");
  });

  it("reports only genuinely unknown names", () => {
    const d = diagnostics(idx, pump()).map((x) => [x.code, idx.docs.get(pump())!.text.slice(x.start, x.end)]);
    expect(d).toEqual([
      ["UNKNOWN_MEMBER", "Missing"],
      ["UNKNOWN_GLOBAL", '"Nope"'],
    ]);
  });

  it("resolves members declared in SimaticML XML (UDTs, FB interfaces, instance and global DBs)", () => {
    const current = definition(idx, pump(), at("Current"))!;
    expect(current.uri).toContain("ST_Motor.xml");
    expect(textAt(current)).toBe("Current");
    const limit = definition(idx, pump(), at("Limit >"))!;
    expect(current.uri === limit.uri).toBe(false);
    expect(textAt(limit)).toBe("Limit");
    expect(textAt(definition(idx, pump(), at('"DB_Xml"'))!)).toBe("DB_Xml");
    expect(hover(idx, pump(), at("Done"))!.markdown).toMatch(/\*\*Done\*\* : `Bool` — sequence finished/);
    expect(hover(idx, pump(), at('"Pump running"'))!.markdown).toMatch(/PLC tag \*\*Pump running\*\* : `Bool` at `%Q0.1`/);
    expect(hover(idx, pump(), at('"C_MAX"'))!.markdown).toMatch(/PLC constant \*\*C_MAX\*\* : `Int` = `4`/);
  });

  it("completes members of XML-declared types", () => {
    const text = idx.docs.get(pump())!.text.replace('"Nope".x := 1;', "#Lad.");
    idx.set(pump(), text, 1);
    expect(complete(idx, pump(), text.indexOf("#Lad.") + "#Lad.".length).map((c) => c.label)).toEqual(["Start", "Done", "Cfg", "Hist", "Motor"]);
  });

  it("reads interfaces from SimaticML with offsets into the XML", () => {
    const xml = '<Document><SW.Blocks.FC ID="0"><AttributeList><Interface><Sections><Section Name="Input"><Member Name="a&amp;b" Datatype="Array[1..2] of &quot;U&quot;" /></Section><Section Name="Return"><Member Name="Ret_Val" Datatype="Int" /></Section></Sections></Interface><Name>Fc</Name></AttributeList></SW.Blocks.FC></Document>';
    const b = parseSimaticMl(xml).blocks[0]!;
    expect([b.kind, b.name, b.returnType, xml.slice(b.nameStart, b.nameEnd)]).toEqual(["FC", "Fc", "Int", "Fc"]);
    expect(b.vars.map((v) => [v.name, v.section, v.typeRef, v.isArray, xml.slice(v.start, v.end)])).toEqual([["a&b", "Input", "U", true, "a&amp;b"]]);
  });
});
