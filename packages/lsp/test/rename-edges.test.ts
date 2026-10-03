// SPDX-License-Identifier: BUSL-1.1
// Quoted parameter names, STRUCT members, other PLCs, IEC sources, in/out handed on twice.
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, rename, usagesAt } from "../src/index.js";

const uri = (name: string, plc = "PLC_1") => `file:///w/plc/${plc}/blocks/${name}`;
const motor = 'FUNCTION_BLOCK "Motor"\nVAR_INPUT\n Start : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n';

describe("rename and who writes this: the edges", () => {
  it("renames a quoted named argument together with its parameter", () => {
    const index = new WorkspaceIndex();
    const fb = motor.replace("Start :", '"Start request" :');
    const caller = 'FUNCTION_BLOCK "Line"\nVAR\n m : "Motor";\nEND_VAR\nBEGIN\n #m("Start request" := TRUE);\nEND_FUNCTION_BLOCK\n';
    index.set(uri("Motor.scl"), fb, 0);
    index.set(uri("Line.scl"), caller, 0);
    const edits = rename(index, uri("Motor.scl"), fb.indexOf("Start request"), "StartPb");
    expect(edits).toContainEqual({ uri: uri("Line.scl"), start: caller.indexOf('"Start request"'), end: caller.indexOf('"Start request"') + '"Start request"'.length, newText: "StartPb" });
  });

  it("renames uses of a temporary STRUCT member", () => {
    const index = new WorkspaceIndex();
    const text = 'FUNCTION "F" : Void\nVAR_TEMP\n Data : Struct\n  Ready : Bool;\n END_STRUCT;\nEND_VAR\nBEGIN\n #Data.Ready := TRUE;\nEND_FUNCTION\n';
    index.set(uri("F.scl"), text, 0);
    expect(rename(index, uri("F.scl"), text.indexOf("Ready :"), "Running")).toContainEqual({ uri: uri("F.scl"), start: text.indexOf("Ready :="), end: text.indexOf("Ready :=") + 5, newText: "Running" });
  });

  it("does not let an unrelated PLC's LAD block prevent a parameter rename", () => {
    const index = new WorkspaceIndex();
    index.set(uri("Motor.scl"), motor, 0);
    index.set(uri("Motor.scl", "PLC_2"), motor, 0);
    index.set(uri("Lad.xml", "PLC_2"), '<Document><SW.Blocks.FB ID="0"><AttributeList><Interface><Sections><Section Name="Static"><Member Name="m" Datatype="&quot;Motor&quot;" /></Section></Sections></Interface><Name>Lad</Name><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList></SW.Blocks.FB></Document>', 0);
    expect(Array.isArray(rename(index, uri("Motor.scl"), motor.indexOf("Start :"), "StartPb"))).toBe(true);
  });

  it("still renames an IEC FB's input in its editable .st source", () => {
    const index = new WorkspaceIndex();
    const text = 'FUNCTION_BLOCK F\nVAR_INPUT\n Start : BOOL;\nEND_VAR\nIF Start THEN\nEND_IF;\nEND_FUNCTION_BLOCK\n';
    index.set("file:///w/F.st", text, 0);
    expect(Array.isArray(rename(index, "file:///w/F.st", text.indexOf("Start :"), "StartPb"))).toBe(true);
  });

  it("follows a scalar IN_OUT through a second call to the actual writer", () => {
    const index = new WorkspaceIndex();
    const db = 'DATA_BLOCK "Plant"\nVAR\n Value : Int;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n';
    const hop = 'FUNCTION "Hop" : Void\nVAR_IN_OUT\n N : Int;\nEND_VAR\nBEGIN\n "Increment"(N := #N);\nEND_FUNCTION\n';
    const increment = 'FUNCTION "Increment" : Void\nVAR_IN_OUT\n N : Int;\nEND_VAR\nBEGIN\n #N := #N + 1;\nEND_FUNCTION\n';
    const main = 'ORGANIZATION_BLOCK "Main"\nBEGIN\n "Hop"(N := "Plant".Value);\nEND_ORGANIZATION_BLOCK\n';
    for (const [name, text] of [["Plant.db", db], ["Hop.scl", hop], ["Increment.scl", increment], ["Main.scl", main]]) index.set(uri(name!), text!, 0);
    const usages = usagesAt(index, uri("Plant.db"), db.indexOf("Value"));
    expect(usages.writes.map((w) => w.block)).toContain("Increment");
    expect(usages.reads.map((r) => r.block)).toContain("Increment");
  });
});
