// SPDX-License-Identifier: BUSL-1.1
// A block's interface seen from its callers: the types in declarations, named arguments, renaming a parameter, and
// who writes a member of a data type handed to a block (the UDT-on-an-in/out pattern of most Siemens motor blocks).
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, codeActions, complete, definition, diagnostics, hover, references, rename, usagesAt } from "../src/index.js";

const u = (p: string) => `file:///w/plc/PLC_1/${p}`;
const UDT = 'TYPE "UDT_Motor"\nVERSION : 0.1\n   STRUCT\n      Running : Bool;\n      Speed : Real;\n   END_STRUCT;\nEND_TYPE\n';
const DB = 'DATA_BLOCK "Plant_DB"\nVERSION : 0.1\n   VAR\n      Pump : "UDT_Motor";\n      Fan : "UDT_Motor";\n      MaxSpeed : Real;\n   END_VAR\nBEGIN\n   MaxSpeed := 1450.0;\nEND_DATA_BLOCK\n';
const MOTOR = `FUNCTION_BLOCK "FB_Motor"
VERSION : 0.1
   VAR_INPUT
      Start : Bool;   // push button
   END_VAR
   VAR_OUTPUT
      Run : Bool;
   END_VAR
   VAR_IN_OUT
      Data : "UDT_Motor";
   END_VAR
BEGIN
   #Run := #Start;
   #Data.Running := #Run;
END_FUNCTION_BLOCK
`;
const LINE = `FUNCTION_BLOCK "FB_Line"
VERSION : 0.1
   VAR_INPUT
      Start : Bool;
   END_VAR
   VAR
      Pump : "FB_Motor";
   END_VAR
BEGIN
   #Pump(Start := #Start, Data := "Plant_DB".Pump);
   "Plant_DB".Fan.Running := FALSE;
END_FUNCTION_BLOCK
`;
const PUMP_DB = 'DATA_BLOCK "Pump_DB"\n"FB_Motor"\nBEGIN\n   Start := FALSE;\nEND_DATA_BLOCK\n';

function workspace(): WorkspaceIndex {
  const index = new WorkspaceIndex();
  index.set(u("types/UDT_Motor.udt"), UDT, 0);
  index.set(u("blocks/Plant_DB.db"), DB, 0);
  index.set(u("blocks/FB_Motor.scl"), MOTOR, 0);
  index.set(u("blocks/FB_Line.scl"), LINE, 0);
  index.set(u("blocks/Pump_DB.db"), PUMP_DB, 0);
  return index;
}

describe("a block's interface from its callers", () => {
  const index = workspace();
  const line = u("blocks/FB_Line.scl");
  const motor = u("blocks/FB_Motor.scl");

  it("goes to the data type or FB named in a declaration and in an instance DB's header", () => {
    expect(definition(index, motor, MOTOR.indexOf('"UDT_Motor"') + 3)).toMatchObject({ uri: u("types/UDT_Motor.udt") });
    expect(definition(index, line, LINE.indexOf('"FB_Motor"') + 3)).toMatchObject({ uri: motor });
    expect(definition(index, u("blocks/Pump_DB.db"), PUMP_DB.indexOf('"FB_Motor"') + 3)).toMatchObject({ uri: motor });
  });

  it("offers the parameters a call does not name yet where an argument's name goes", () => {
    const text = LINE.replace("#Pump(Start := #Start, Data := \"Plant_DB\".Pump);", "#Pump(Start := #Start, ");
    const index2 = workspace();
    index2.set(line, text, 0);
    const at = text.indexOf("#Pump(Start := #Start, ") + "#Pump(Start := #Start, ".length;
    const c = complete(index2, line, at);
    expect(c.map((x) => x.insertText)).toEqual(["Data := ", "Run => "]);
  });

  it("knows a named argument: hover, definition and references of the parameter", () => {
    const at = LINE.indexOf("Start :=") + 2;
    expect(hover(index, line, at)?.markdown).toMatch(/Start.*Bool.*push button[\s\S]*of FB_Motor/);
    expect(definition(index, line, at)).toEqual({ uri: motor, start: MOTOR.indexOf("Start :"), end: MOTOR.indexOf("Start :") + 5 });
    const refs = references(index, motor, MOTOR.indexOf("Start :") + 1).map((r) => [r.uri, r.start]);
    expect(refs).toContainEqual([line, LINE.indexOf("Start :=")]);
    expect(refs).toContainEqual([u("blocks/Pump_DB.db"), PUMP_DB.indexOf("Start :=")]);
  });

  it("renames a parameter in the block, in the calls and in the instance DBs, from either end", () => {
    for (const [uri, offset] of [[motor, MOTOR.indexOf("Start :") + 1], [line, LINE.indexOf("Start :=") + 1]] as const) {
      const edits = rename(index, uri, offset, "StartPb");
      expect(Array.isArray(edits)).toBe(true);
      const where = (edits as { uri: string; start: number; newText: string }[]).map((e) => [e.uri.split("/").at(-1), e.newText]).sort();
      expect(where).toEqual([["FB_Line.scl", "StartPb"], ["FB_Motor.scl", "#StartPb"], ["FB_Motor.scl", "StartPb"], ["Pump_DB.db", "StartPb"]]);
    }
    // FB_Line's own input of the same name is another variable
    expect((rename(index, motor, MOTOR.indexOf("Start :") + 1, "x") as { uri: string; start: number }[]).some((e) => e.uri === line && e.start === LINE.indexOf("#Start)"))).toBe(false);
  });

  it("refuses a rename that would leave a LAD block from XML behind", () => {
    const other = workspace();
    // a LAD block exported as SimaticML that calls FB_Motor: the editor does not edit its XML
    other.set(u("blocks/FB_Lad.xml"), '<Document><SW.Blocks.FB ID="0"><AttributeList><Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5"><Section Name="Static"><Member Name="M" Datatype="&quot;FB_Motor&quot;" /></Section></Sections></Interface><Name>FB_Lad</Name><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList></SW.Blocks.FB></Document>', 0);
    const r = rename(other, motor, MOTOR.indexOf("Start :") + 1, "StartPb");
    expect(r).toMatchObject({ error: expect.stringMatching(/FB_Lad.*rename it in TIA Portal/) });
  });

  it("follows a data type handed to an in/out: who writes \"Plant_DB\".Pump.Running", () => {
    // the whole Pump handed to an in/out: the call, and what FB_Motor writes into it
    const r = usagesAt(index, u("blocks/Plant_DB.db"), DB.indexOf("Pump :") + 1);
    expect(r.writes.map((w) => [w.block, w.start, w.through?.param])).toEqual([["FB_Line", LINE.indexOf("Pump);"), undefined], ["FB_Motor", MOTOR.indexOf("#Data.Running"), "Data"]]);
  });

  it("a member handed whole to an in/out: the write inside the block, reached through that call", () => {
    const index2 = workspace();
    index2.set(u("blocks/FB_Count.scl"), `FUNCTION_BLOCK "FB_Count"
   VAR_IN_OUT
      N : Real;
   END_VAR
BEGIN
   #N := #N + 1.0;
END_FUNCTION_BLOCK
`, 0);
    const main = `ORGANIZATION_BLOCK "Main"
   VAR_TEMP
      c : "FB_Count";
   END_VAR
BEGIN
   #c(N := "Plant_DB".MaxSpeed);
END_ORGANIZATION_BLOCK
`;
    index2.set(u("blocks/Main.scl"), main, 0);
    const r = usagesAt(index2, u("blocks/Main.scl"), main.indexOf("MaxSpeed"));
    expect(r.writes.map((w) => [w.block, w.through?.param])).toEqual([["Plant_DB", undefined], ["Main", undefined], ["FB_Count", "N"]]);
    expect(r.reads.map((x) => [x.block, x.through?.block])).toEqual([["FB_Count", "Main"]]);
  });

  it("finds the write of one DB's member inside the block it is handed to, not the other motor's", () => {
    const index2 = workspace();
    index2.set(u("blocks/Probe.scl"), 'FUNCTION "Probe" : Void\nBEGIN\n   IF "Plant_DB".Pump.Running THEN RETURN; END_IF;\nEND_FUNCTION\n', 0);
    const src = index2.docs.get(u("blocks/Probe.scl"))!.text;
    const r = usagesAt(index2, u("blocks/Probe.scl"), src.indexOf("Running"));
    expect(r.writes.map((w) => [w.block, w.through?.block, w.through?.param])).toEqual([["FB_Motor", "FB_Line", "Data"]]);
    expect(r.writes[0]!.start).toBe(MOTOR.indexOf("Running :="));
    expect(r.reads.map((x) => x.block)).toEqual(["Probe"]);
    // Fan.Running is written in FB_Line itself, and is another member
    const fan = usagesAt(index2, line, LINE.indexOf("Running := FALSE"));
    expect(fan.writes.map((w) => w.block)).toEqual(["FB_Line"]);
  });

  it("says where a writing block is called: the call, not the instance's declaration or an instance DB", () => {
    const main = 'ORGANIZATION_BLOCK "Main"\nBEGIN\n   "Line_DB"();\nEND_ORGANIZATION_BLOCK\n';
    const index2 = workspace();
    index2.set(u("blocks/Main.scl"), main, 0);
    index2.set(u("blocks/Line_DB.db"), 'DATA_BLOCK "Line_DB"\n"FB_Line"\nBEGIN\nEND_DATA_BLOCK\n', 0);
    const r = usagesAt(index2, motor, MOTOR.indexOf("#Run :=") + 1);
    expect(r.writes[0]!.calledFrom).toEqual([{ block: "FB_Line", uri: line, start: LINE.indexOf("#Pump(") }]);
    const fan = usagesAt(index2, line, LINE.indexOf("Running := FALSE"));
    expect(fan.writes[0]!.calledFrom).toEqual([{ block: "Main", uri: u("blocks/Main.scl"), start: main.indexOf('"Line_DB"') }]);
    // a DB's start value is not called from anywhere
    const start = usagesAt(index2, u("blocks/Plant_DB.db"), DB.indexOf("MaxSpeed := ") + 1);
    expect(start.writes.map((w) => [w.block, w.calledFrom])).toEqual([["Plant_DB", undefined]]);
  });
});

describe("what TIA Portal would refuse, while typing", () => {
  const check = (body: string, vars = "      Out1 : Bool;\n      Count : Int;\n      Txt : String[10];\n") => {
    const index = workspace();
    const uri = u("blocks/FB_Bad.scl");
    index.set(uri, `FUNCTION_BLOCK "FB_Bad"\n   VAR\n${vars}   END_VAR\nBEGIN\n${body}END_FUNCTION_BLOCK\n`, 0);
    return { index, uri, text: index.docs.get(uri)!.text, found: diagnostics(index, uri) };
  };

  it("a statement without its ';'", () => {
    const { found, text } = check("   IF #Out1 THEN\n      #Out1 := TRUE\n   END_IF;\n   #Count := 1\n   #Out1 := FALSE;\n");
    expect(found.filter((d) => d.message === "Missing ';'").map((d) => text.slice(d.start, d.end))).toEqual(["TRUE", "1"]);
    // END_IF wants its ';' too in TIA Portal
    const endIf = check("   IF #Out1 THEN\n      #Count := 1;\n   END_IF\n   #Count := 2;\n");
    expect(endIf.found.filter((d) => d.message === "Missing ';'").map((d) => endIf.text.slice(d.start, d.end))).toEqual(["END_IF"]);
    // a statement that ends with a member: #Out1 := #m.Run
    const member = check('   #Out1 := "Plant_DB".Pump.Running\n   #Count := 2;\n');
    expect(member.found.filter((d) => d.message === "Missing ';'").map((d) => member.text.slice(d.start, d.end))).toEqual(["Running"]);
  });

  it("no false alarm on statements over several lines, calls, regions and CASE labels", () => {
    const { found } = check(
      "   REGION Step 2\n   #Count := #Count\n      + 1;\n   #Out1 := #Out1\n      AND #Out1;\n   \"FB_Motor\"(Start := #Out1,\n      Data := \"Plant_DB\".Pump);\n   END_REGION\n   CASE #Count OF\n      1:\n         #Out1 := TRUE;\n      2, 3:\n         ;\n      ELSE\n         #Out1 := FALSE;\n   END_CASE;\n",
    );
    expect(found.filter((d) => d.code === "SYNTAX")).toEqual([]);
  });

  it("a CASE label taken twice, also inside a range", () => {
    const { found } = check("   CASE #Count OF\n      1: #Out1 := TRUE;\n      2..4: #Out1 := FALSE;\n      3: ;\n      16#1: ;\n   END_CASE;\n");
    expect(found.filter((d) => d.code === "SYNTAX").map((d) => d.message)).toEqual(["CASE label 3 is already taken on line 10", "CASE label 1 is already taken on line 9"]);
  });

  it("text into a number and a number into text", () => {
    const { found } = check("   #Count := 'hello';\n   #Txt := 42;\n   #Txt := 'ok';\n   #Count := 42;\n");
    expect(found.filter((d) => d.code === "TYPE_MISMATCH").map((d) => d.message)).toEqual(["#Count is Int: 'hello' is text, TIA Portal does not convert it", "#Txt is String[10]: write the text in quotes, '42'"]);
    // one character is a Char: TIA Portal converts it into an integer or a bit string, not into a Bool
    const char = check("   #Count := 'A';\n   #Count := '$02';\n   #Out1 := 'A';\n");
    expect(char.found.filter((d) => d.code === "TYPE_MISMATCH").map((d) => d.message)).toEqual(["#Out1 is Bool: 'A' is text, TIA Portal does not convert it"]);
  });

  it("a /* */ comment, which TIA Portal's SCL does not know, and an FC call that leaves out an output", () => {
    const { found } = check('   #Out1 /* note */ := TRUE;\n   "FC_Out"(a := 1);\n');
    expect(found.filter((d) => d.code === "SYNTAX").map((d) => d.message)).toEqual(["TIA Portal's SCL has no /* */ comments: write (* *) or //"]);
    const index = workspace();
    index.set(u("blocks/FC_Out.scl"), 'FUNCTION "FC_Out" : Void\n   VAR_INPUT\n      a : Int;\n   END_VAR\n   VAR_OUTPUT\n      o : Bool;\n   END_VAR\nBEGIN\n   #o := #a > 0;\nEND_FUNCTION\n', 0);
    const uri = u("blocks/FB_Use.scl");
    index.set(uri, 'FUNCTION_BLOCK "FB_Use"\nBEGIN\n   "FC_Out"(a := 1);\nEND_FUNCTION_BLOCK\n', 0);
    expect(diagnostics(index, uri).find((d) => d.code === "MISSING_PARAMETER")?.message).toBe("This call of FC_Out leaves out o: an FC gets every input, in/out and output");
  });

  it("a misspelt member, with the name it meant and a quick fix", () => {
    const { found, index, uri } = check('   #Out1 := "Plant_DB".MaxSpeeed > 1.0;\n');
    const d = found.find((x) => x.code === "UNKNOWN_MEMBER")!;
    expect(d.message).toBe("MaxSpeeed is not a member of Plant_DB (did you mean MaxSpeed?)");
    const fix = codeActions(index, uri, d.start, d.end).find((f) => f.code === "UNKNOWN_MEMBER");
    expect(fix).toMatchObject({ title: "Change to MaxSpeed", edits: [{ start: d.start, end: d.end, newText: "MaxSpeed" }] });
  });

  it("an argument the callee no longer has: renaming it to the parameter it most likely was comes first", () => {
    const { found, index, uri } = check("   #m(Strt := #Out1, Data := \"Plant_DB\".Pump);\n", "      Out1 : Bool;\n      m : \"FB_Motor\";\n");
    const d = found.find((x) => x.code === "UNKNOWN_PARAMETER")!;
    const fixes = codeActions(index, uri, d.start, d.end).filter((f) => f.code === "UNKNOWN_PARAMETER");
    expect(fixes.map((f) => [f.title, !!f.preferred])).toEqual([["Rename the argument Strt to Start", true], ["Remove the argument Strt (FB_Motor has no such parameter)", false]]);
  });
});
