// SPDX-License-Identifier: BUSL-1.1
// SimaticML blocks with SCL and STL networks between their LAD ones: the SCL text rebuilt from its tokens joins the
// translated networks, the STL runs through the STL interpreter in the block's frame, in network order.
// Fx_Mixed.xml is TIA Portal V20's own export; the other networks are built to the same structure.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex, parseSimaticMl } from "@rung/lsp";
import { runTestFile } from "../src/index.js";

const MIXED = readFileSync(fileURLToPath(new URL("../../../tools/fixtures/xml/sim/Fx_Mixed.xml", import.meta.url)), "utf8");

const COUNT = 'FUNCTION_BLOCK "Fx_Count"\nVAR_INPUT\n  up : Bool;\nEND_VAR\nVAR_OUTPUT\n  n : Int;\nEND_VAR\nVAR\n  last : Bool;\nEND_VAR\nBEGIN\n  IF #up AND NOT #last THEN\n    #n := #n + 1;\n  END_IF;\n  #last := #up;\nEND_FUNCTION_BLOCK\n';
const local = (name: string, uid = "") => `<Access Scope="LocalVariable"${uid}><Symbol><Component Name="${name}" /></Symbol></Access>`;
const global = (db: string, member?: string) => `<Access Scope="GlobalVariable"><Symbol><Component Name="${db}" />${member ? `<Component Name="${member}" />` : ""}</Symbol></Access>`;
const unit = (id: number, lang: "STL" | "SCL", body: string) =>
  `<SW.Blocks.CompileUnit ID="${id}" CompositionName="CompileUnits"><AttributeList><NetworkSource>${
    lang === "STL" ? `<StatementList xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/StatementList/v5">${body}</StatementList>` : `<StructuredText xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/StructuredText/v4">${body}</StructuredText>`
  }</NetworkSource><ProgrammingLanguage>${lang}</ProgrammingLanguage></AttributeList></SW.Blocks.CompileUnit>`;
const fb = (name: string, members: string, units: string[], lang = "LAD") =>
  `<?xml version="1.0" encoding="utf-8"?><Document><Engineering version="V20" /><SW.Blocks.FB ID="0"><AttributeList><Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">${members}</Sections></Interface><Name>${name}</Name><ProgrammingLanguage>${lang}</ProgrammingLanguage></AttributeList><ObjectList>${units.join("")}</ObjectList></SW.Blocks.FB></Document>`;
const stl = (token: string, access = "") => `<StlStatement><StlToken Text="${token}" />${access}</StlStatement>`;

function workspace(files: Record<string, string>) {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/plc/P/blocks/Fx_Count.scl", COUNT, 0);
  idx.set("file:///w/plc/P/blocks/Fx_Count_DB.db", 'DATA_BLOCK "Fx_Count_DB"\n"Fx_Count"\nBEGIN\nEND_DATA_BLOCK\n', 0);
  for (const [k, v] of Object.entries(files)) idx.set(`file:///w/plc/P/blocks/${k}`, v, 0);
  return idx;
}
const results = async (idx: WorkspaceIndex, yaml: string) => {
  const r = await runTestFile(idx, "t.test.yaml", yaml);
  return [r.error, ...r.cases.map((c) => [c.passed, c.error, c.failures])];
};

describe("SCL and STL networks in SimaticML blocks", () => {
  it("runs TIA Portal's LAD FB with an SCL and an STL network (Fx_Mixed)", async () => {
    const yaml = "block: Fx_Mixed\ncases:\n  - steps:\n      - set: { a: 3, b: true }\n      - cycle: 1\n      - expect: { q: 6, s: true }\n      - set: { r: true }\n      - cycle: 1\n      - expect: { s: false }\n";
    expect(await results(workspace({ "Fx_Mixed.xml": MIXED }), yaml)).toEqual([undefined, [true, undefined, []]]);
  });

  it("an STL network calls an FB with its instance DB and an SCL network with IF, a call and a member access", async () => {
    const members = '<Section Name="Input"><Member Name="go" Datatype="Bool" /></Section><Section Name="Output"><Member Name="n1" Datatype="Int" /><Member Name="n2" Datatype="Int" /></Section>';
    const call =
      '<Access Scope="Call"><CallInfo Name="Fx_Count" BlockType="FB"><Instance Scope="GlobalVariable"><Component Name="Fx_Count_DB" /></Instance>' +
      `<Parameter Name="up" Section="Input" Type="Bool">${local("go")}</Parameter><Parameter Name="n" Section="Output" Type="Int">${local("n1")}</Parameter></CallInfo></Access>`;
    const t = (text: string) => `<Token Text="${text}" />`;
    const b = "<Blank />";
    const nl = "<NewLine />";
    // // mirror the count\nIF #go THEN\n  "Fx_Count_DB"(up := #go);\n  #n2 := "Fx_Count_DB".n;\nEND_IF;
    const scl = [
      '<LineComment><Text>mirror the count</Text></LineComment>',
      nl,
      t("IF"), b, local("go"), b, t("THEN"), nl,
      '<Access Scope="Call"><CallInfo Name="Fx_Count" BlockType="FB"><Instance Scope="GlobalVariable"><Component Name="Fx_Count_DB" /></Instance>',
      t("("), `<Parameter Name="up" Section="Input" Type="Bool">${t(":=")}${b}${local("go")}</Parameter>`, t(")"), "</CallInfo></Access>", t(";"), nl,
      local("n2"), b, t(":="), b, global("Fx_Count_DB", "n"), t(";"), nl,
      t("END_IF"), t(";"),
    ].join("");
    const xml = fb("Fx_Both", members, [unit(1, "STL", stl("CALL", call) + stl("EMPTY_LINE")), unit(2, "SCL", scl)]);
    const yaml = "block: Fx_Both\ncases:\n  - steps:\n      - set: { go: true }\n      - cycle: 1\n      - expect: { n1: 1, n2: 1 }\n      - set: { go: false }\n      - cycle: 1\n      - set: { go: true }\n      - cycle: 1\n      - expect: { n1: 2, n2: 2 }\n";
    const idx = workspace({ "Fx_Both.xml": xml });
    expect(await results(idx, yaml)).toEqual([undefined, [true, undefined, []]]);
    // their operands are references for the editor and the call graph
    const refs = parseSimaticMl(xml).blocks[0]!.refs.map((r) => `${r.kind} ${r.name}${r.members.length ? "." + r.members.map((m) => m.name).join(".") : ""} ${r.access}`);
    expect(refs).toEqual(expect.arrayContaining(["global Fx_Count_DB call", "local go read", "local n1 write", "local n2 write", "global Fx_Count_DB.n read"]));
  });

  it("runs an STL block kept as SimaticML network by network", async () => {
    const members = '<Section Name="Input"><Member Name="a" Datatype="Bool" /><Member Name="b" Datatype="Bool" /><Member Name="n" Datatype="Int" /></Section><Section Name="Output"><Member Name="q" Datatype="Bool" /><Member Name="m" Datatype="Int" /></Section>';
    const xml = fb("Fx_Stl", members, [unit(1, "STL", stl("A", local("a")) + stl("O", local("b")) + stl("Assign", local("q"))), unit(2, "STL", stl("L", local("n")) + stl("T", local("m")))], "STL");
    const yaml = "block: Fx_Stl\ncases:\n  - steps:\n      - set: { b: true, n: 7 }\n      - cycle: 1\n      - expect: { q: true, m: 7 }\n      - set: { b: false }\n      - cycle: 1\n      - expect: { q: false }\n";
    expect(await results(workspace({ "Fx_Stl.xml": xml }), yaml)).toEqual([undefined, [true, undefined, []]]);
  });

  it("refuses an STL network the interpreter does not run before the block runs, and a string left open for the next network", async () => {
    const members = '<Section Name="Output"><Member Name="q" Datatype="Bool" /><Member Name="x" Datatype="Bool" /></Section>';
    const refused = fb("Fx_Old", members, [unit(1, "STL", stl("A", local("q")) + stl("TAK") + stl("Assign", local("x")))]);
    const open = fb("Fx_Open", members, [unit(1, "STL", stl("A", local("q"))), unit(2, "STL", stl("Assign", local("x")))]);
    const yaml = (b: string) => `block: ${b}\ncases:\n  - steps:\n      - cycle: 1\n`;
    const idx = workspace({ "Fx_Old.xml": refused, "Fx_Open.xml": open });
    expect((await runTestFile(idx, "t.test.yaml", yaml("Fx_Old"))).cases[0]!.error).toBe('"Fx_Old" uses STL instructions the simulator does not run yet (network 1): TAK (in Fx_Old)');
    expect((await runTestFile(idx, "t.test.yaml", yaml("Fx_Open"))).cases[0]!.error).toMatch(/^STL network 1: the logic string is still open at the end of the network \(on the PLC it goes on in the next one\): not simulated \(in Fx_Open/);
  });
});
