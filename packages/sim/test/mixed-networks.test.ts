// SPDX-License-Identifier: BUSL-1.1
// SimaticML blocks with SCL and STL networks between their LAD ones: the SCL text rebuilt from its tokens joins the
// translated networks, the STL runs through the STL interpreter in the block's frame, in network order.
// Fx_Mixed.xml is TIA Portal V20's own export; the other networks are built to the same structure.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex, parseSimaticMl } from "@rung/lsp";
import { runTestFile } from "../src/index.js";
import { Simulator, type Value } from "../src/runtime.js";

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
const literal = (type: string, value: string) => `<Access Scope="LiteralConstant"><Constant><ConstantType>${type}</ConstantType><ConstantValue>${value}</ConstantValue></Constant></Access>`;
const textOperand = (text: string) => `<Access Scope="Text">${text}</Access>`;
const sclSet = (name: string, value: string) => `${local(name)}<Token Text=":=" /><Token Text="${value}" /><Token Text=";" />`;
const ladSet = (id: number, name: string) =>
  `<SW.Blocks.CompileUnit ID="${id}" CompositionName="CompileUnits"><AttributeList><NetworkSource><FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4"><Parts>${local(name, ' UId="1"')}<Part Name="Coil" UId="2" /></Parts><Wires><Wire UId="3"><Powerrail /><NameCon UId="2" Name="in" /></Wire><Wire UId="4"><IdentCon UId="1" /><NameCon UId="2" Name="operand" /></Wire></Wires></FlgNet></NetworkSource><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList></SW.Blocks.CompileUnit>`;
const awl = (kind: "FUNCTION" | "FUNCTION_BLOCK", decl: string, networks: string[], ret = "Void") =>
  `${kind} "Fx_Awl"${kind === "FUNCTION" ? ` : ${ret}` : ""}\n${decl}\nBEGIN\n${networks.map((n) => `NETWORK\n${n}\n`).join("")}END_${kind}\n`;

function paired(xml: string, decl: string, networks: string[], ret?: string) {
  const sim = new Simulator(workspace({ "Fx_Test.xml": xml, "Fx_Awl.awl": awl(ret ? "FUNCTION" : "FUNCTION_BLOCK", decl, networks, ret) }));
  const target = ret ? "Fx_Test" : sim.newInstance("Fx_Test");
  const reference = ret ? "Fx_Awl" : sim.newInstance("Fx_Awl");
  return (inputs: Record<string, Value> = {}) => {
    const actual = sim.callBlock(target, inputs);
    expect(actual).toEqual(sim.callBlock(reference, inputs));
    return actual;
  };
}

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
    const yaml = "block: Fx_Mixed\ncases:\n  - name: case 1\n    steps:\n      - set: { a: 3, b: true }\n      - cycle: 1\n      - expect: { q: 6, s: true }\n      - set: { r: true }\n      - cycle: 1\n      - expect: { s: false }\n";
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
    const yaml = "block: Fx_Both\ncases:\n  - name: case 2\n    steps:\n      - set: { go: true }\n      - cycle: 1\n      - expect: { n1: 1, n2: 1 }\n      - set: { go: false }\n      - cycle: 1\n      - set: { go: true }\n      - cycle: 1\n      - expect: { n1: 2, n2: 2 }\n";
    const idx = workspace({ "Fx_Both.xml": xml });
    expect(await results(idx, yaml)).toEqual([undefined, [true, undefined, []]]);
    // their operands are references for the editor and the call graph
    const refs = parseSimaticMl(xml).blocks[0]!.refs.map((r) => `${r.kind} ${r.name}${r.members.length ? "." + r.members.map((m) => m.name).join(".") : ""} ${r.access}`);
    expect(refs).toEqual(expect.arrayContaining(["global Fx_Count_DB call", "local go read", "local n1 write", "local n2 write", "global Fx_Count_DB.n read"]));
  });

  it("runs an STL block kept as SimaticML network by network", async () => {
    const members = '<Section Name="Input"><Member Name="a" Datatype="Bool" /><Member Name="b" Datatype="Bool" /><Member Name="n" Datatype="Int" /></Section><Section Name="Output"><Member Name="q" Datatype="Bool" /><Member Name="m" Datatype="Int" /></Section>';
    const xml = fb("Fx_Stl", members, [unit(1, "STL", stl("A", local("a")) + stl("O", local("b")) + stl("Assign", local("q"))), unit(2, "STL", stl("L", local("n")) + stl("T", local("m")))], "STL");
    const yaml = "block: Fx_Stl\ncases:\n  - name: case 3\n    steps:\n      - set: { b: true, n: 7 }\n      - cycle: 1\n      - expect: { q: true, m: 7 }\n      - set: { b: false }\n      - cycle: 1\n      - expect: { q: false }\n";
    expect(await results(workspace({ "Fx_Stl.xml": xml }), yaml)).toEqual([undefined, [true, undefined, []]]);
  });

  it("refuses unsupported STL and an open string before a non-STL network", async () => {
    const members = '<Section Name="Output"><Member Name="q" Datatype="Bool" /><Member Name="x" Datatype="Bool" /></Section>';
    const refused = fb("Fx_Old", members, [unit(1, "STL", stl("A", local("q")) + stl("TAK") + stl("Assign", local("x")))]);
    const open = fb("Fx_Open", members, [unit(1, "STL", stl("A", local("q"))), unit(2, "SCL", sclSet("x", "TRUE"))]);
    const ladOpen = fb("Fx_LadOpen", members, [unit(1, "STL", stl("A", local("q"))), ladSet(2, "x")]);
    const last = fb("Fx_Last", members, [unit(1, "STL", stl("A", local("q")))]);
    const yaml = (b: string) => `block: ${b}\ncases:\n  - name: case 4\n    steps:\n      - cycle: 1\n`;
    const idx = workspace({ "Fx_Old.xml": refused, "Fx_Open.xml": open, "Fx_LadOpen.xml": ladOpen, "Fx_Last.xml": last });
    expect((await runTestFile(idx, "t.test.yaml", yaml("Fx_Old"))).cases[0]!.error).toBe('"Fx_Old" uses STL instructions the simulator does not run yet (network 1): TAK (in Fx_Old)');
    for (const name of ["Fx_Open", "Fx_LadOpen"]) expect((await runTestFile(idx, "t.test.yaml", yaml(name))).cases[0]!.error).toMatch(/^STL network 1: the logic string is still open at the end of the network and cannot continue in STL: not simulated/);
    // at the end of the block the string ends with it, as in an .awl block
    expect((await runTestFile(idx, "t.test.yaml", yaml("Fx_Last"))).cases[0]).toMatchObject({ passed: true });
  });
});

describe("SimaticML STL networks agree with an AWL block", () => {
  const members = '<Section Name="Input"><Member Name="a" Datatype="Bool" /><Member Name="b" Datatype="Bool" /><Member Name="n" Datatype="Int" /></Section><Section Name="Output"><Member Name="q" Datatype="Bool" /><Member Name="r" Datatype="Bool" /><Member Name="m" Datatype="Int" /></Section>';
  const decl = "VAR_INPUT\n a : Bool;\n b : Bool;\n n : Int;\nEND_VAR\nVAR_OUTPUT\n q : Bool;\n r : Bool;\n m : Int;\nEND_VAR";

  it.each(["STL", "SCL", "LAD"])("BEU skips a following %s network", (lang) => {
    const later = lang === "STL" ? unit(2, "STL", stl("SET") + stl("Assign", local("q"))) : lang === "SCL" ? unit(2, "SCL", sclSet("q", "TRUE")) : ladSet(2, "q");
    const call = paired(fb("Fx_Test", members, [unit(1, "STL", stl("BEU")), later]), decl, ["BEU;", "SET; = #q;"]);
    expect(call().outputs.Q).toBe(false);
  });

  it.each(["STL", "SCL", "LAD"])("BEU publishes FC outputs and RET_VAL before skipping %s", (lang) => {
    const first = stl("L", literal("Int", "7")) + stl("T", local("m")) + stl("T", local("RET_VAL")) + stl("BEU");
    const later = lang === "STL" ? unit(2, "STL", stl("SET") + stl("Assign", local("q"))) : lang === "SCL" ? unit(2, "SCL", sclSet("q", "TRUE")) : ladSet(2, "q");
    const xml = fb("Fx_Test", members + '<Section Name="Return"><Member Name="RET_VAL" Datatype="Int" /></Section>', [unit(1, "STL", first), later]).replaceAll("SW.Blocks.FB", "SW.Blocks.FC");
    const call = paired(xml, decl, ["L 7; T #m; T #RET_VAL; BEU;", "SET; = #q;"], "Int");
    expect(call()).toMatchObject({ returnValue: 7, outputs: { M: 7, Q: false } });
    const scl = 'FUNCTION "Fx_Return" : Int\n' + decl + '\nBEGIN\n#m := 7; #Fx_Return := 7; RETURN; #q := TRUE;\nEND_FUNCTION\n';
    const sim = new Simulator(workspace({ "Fx_Return.scl": scl }));
    expect(call()).toEqual(sim.callBlock("Fx_Return"));
    const caller = 'FUNCTION "Fx_Caller" : Int\nVAR_OUTPUT\n out : Int;\n q : Bool;\nEND_VAR\nBEGIN\n#Fx_Caller := "Fx_Test"(m => #out, q => #q);\nEND_FUNCTION\n';
    const bound = new Simulator(workspace({ "Fx_Test.xml": xml, "Fx_Caller.scl": caller }));
    expect(bound.callBlock("Fx_Caller")).toMatchObject({ returnValue: 7, outputs: { OUT: 7, Q: false } });
  });

  it("BE ends the block only on the conditional path that reaches it", () => {
    const first = stl("A", local("a")) + stl("JCN", textOperand("skip")) + stl("BE") + stl("skip: NOP", textOperand("0"));
    const call = paired(fb("Fx_Test", members, [unit(1, "STL", first), unit(2, "STL", stl("SET") + stl("Assign", local("q")))]), decl, ["A #a; JCN skip; BE; skip: NOP 0;", "SET; = #q;"]);
    expect(call({ a: true }).outputs.Q).toBe(false);
    expect(call({ a: false }).outputs.Q).toBe(true);
  });

  it("carries both accumulators and the ended RLO between consecutive networks", () => {
    const units = [
      unit(1, "STL", stl("L", local("n")) + stl("SET") + stl("Assign", local("q"))),
      unit(2, "STL", stl("T", local("m")) + stl("Assign", local("r"))),
      unit(3, "STL", stl("L", literal("Int", "2"))),
      unit(4, "STL", stl("+I") + stl("T", local("m"))),
    ];
    const call = paired(fb("Fx_Test", members, units), decl, ["L #n; SET; = #q;", "T #m; = #r;", "L 2;", "+I; T #m;"]);
    expect(call({ n: 7 })).toMatchObject({ outputs: { M: 9, Q: true, R: true } });
    const transfer = paired(fb("Fx_Test", members, [unit(1, "STL", stl("L", local("n"))), unit(2, "STL", stl("T", local("m")))]), decl, ["L #n;", "T #m;"]);
    expect(transfer({ n: 7 }).outputs.M).toBe(7);
  });

  it("continues an open logic string, OR term and nesting stack in the next STL network", () => {
    const splits = [
      [stl("A", local("a")), stl("A", local("b")) + stl("Assign", local("q")), "A #a;", "A #b; = #q;"],
      [stl("A", local("a")) + stl("O"), stl("A", local("b")) + stl("Assign", local("q")), "A #a; O;", "A #b; = #q;"],
      [stl("A", local("a")) + stl("A(") + stl("A", local("b")), stl(")") + stl("Assign", local("q")), "A #a; A(; A #b;", "); = #q;"],
    ];
    for (const [first, second, awlFirst, awlSecond] of splits) {
      const call = paired(fb("Fx_Test", members, [unit(1, "STL", first!), unit(2, "STL", second!)]), decl, [awlFirst!, awlSecond!]);
      for (const a of [false, true]) for (const b of [false, true]) call({ a, b });
    }
  });

  it.each(["SCL", "LAD"])("refuses undefined ACCUs and RLO after an intervening %s network", (lang) => {
    const middle = lang === "SCL" ? unit(2, "SCL", sclSet("q", "TRUE")) : ladSet(2, "q");
    for (const [last, error] of [
      [stl("T", local("m")), /ACCU 1 is undefined/],
      [stl("L", literal("Int", "2")) + stl("+I"), /ACCU 2 is undefined/],
      [stl("Assign", local("r")), /RLO is undefined/],
      [stl("NOT") + stl("Assign", local("r")), /RLO is undefined/],
    ] as const) {
      const xml = fb("Fx_Test", members, [unit(1, "STL", stl("L", local("n")) + stl("SET") + stl("Assign", local("r"))), middle, unit(3, "STL", last)]);
      const sim = new Simulator(workspace({ "Fx_Test.xml": xml }));
      expect(() => sim.callBlock(sim.newInstance("Fx_Test"), { n: 7 })).toThrow(error);
    }
    const last = stl("L", local("n")) + stl("L", literal("Int", "2")) + stl("+I") + stl("T", local("m")) + stl("A", local("a")) + stl("Assign", local("r"));
    const call = paired(fb("Fx_Test", members, [unit(1, "STL", stl("L", local("n"))), middle, unit(3, "STL", last)]), decl, ["L #n;", "SET; = #q;", "L #n; L 2; +I; T #m; A #a; = #r;"]);
    expect(call({ n: 7, a: true })).toMatchObject({ outputs: { M: 9, Q: true, R: true } });
  });

  it.each(["FB", "FC"])("starts each %s call with its own accumulators", (kind) => {
    const first = stl("A", local("a")) + stl("JCN", textOperand("skip")) + stl("L", local("n")) + stl("skip: NOP", textOperand("0"));
    let xml = fb("Fx_Test", members, [unit(1, "STL", first), unit(2, "STL", stl("T", local("m")))]);
    if (kind === "FC") xml = xml.replaceAll("SW.Blocks.FB", "SW.Blocks.FC");
    const call = paired(xml, decl, ["A #a; JCN skip; L #n; skip: NOP 0;", "T #m;"], kind === "FC" ? "Void" : undefined);
    expect(call({ a: true, n: 7 }).outputs.M).toBe(7);
    expect(call({ a: false, n: 9 }).outputs.M).toBe(0);
  });

  it("does not carry accumulator state into another FB instance", () => {
    const first = stl("A", local("a")) + stl("JCN", textOperand("skip")) + stl("L", local("n")) + stl("skip: NOP", textOperand("0"));
    const xml = fb("Fx_Test", members, [unit(1, "STL", first), unit(2, "STL", stl("T", local("m")))]);
    const sim = new Simulator(workspace({ "Fx_Test.xml": xml }));
    const one = sim.newInstance("Fx_Test");
    const two = sim.newInstance("Fx_Test");
    expect(sim.callBlock(one, { a: true, n: 7 }).outputs.M).toBe(7);
    expect(sim.callBlock(two, { a: false }).outputs.M).toBe(0);
  });

  it("keeps the caller's state during a recursive call of the same SimaticML FC", () => {
    const self = `<Access Scope="Call"><CallInfo Name="Fx_Test" BlockType="FC"><Parameter Name="a" Section="Input" Type="Bool">${literal("Bool", "FALSE")}</Parameter><Parameter Name="n" Section="Input" Type="Int">${literal("Int", "99")}</Parameter></CallInfo></Access>`;
    const first = stl("A", local("a")) + stl("JCN", textOperand("skip")) + stl("L", local("n")) + stl("CALL", self) + stl("skip: NOP", textOperand("0"));
    const second = stl("T", local("m")) + stl("L", literal("Int", "99"));
    const xml = fb("Fx_Test", members, [unit(1, "STL", first), unit(2, "STL", second)]).replaceAll("SW.Blocks.FB", "SW.Blocks.FC");
    const reference = awl("FUNCTION", decl, ['A #a; JCN skip; L #n; CALL "Fx_Awl" (a := FALSE, n := 99); skip: NOP 0;', 'T #m; L 99;']);
    const sim = new Simulator(workspace({ "Fx_Test.xml": xml, "Fx_Awl.awl": reference }));
    expect(sim.callBlock("Fx_Test", { a: true, n: 7 })).toEqual(sim.callBlock("Fx_Awl", { a: true, n: 7 }));
    expect(sim.callBlock("Fx_Test", { a: true, n: 7 }).outputs.M).toBe(7);
  });

  it("an FC called inside STL does not replace the caller's accumulators or RLO", () => {
    const inner = 'FUNCTION "Fx_Inner" : Void\nBEGIN\nL 99; CLR; BEU;\nEND_FUNCTION\n';
    const callAccess = '<Access Scope="Call"><CallInfo Name="Fx_Inner" BlockType="FC" /></Access>';
    const xml = fb("Fx_Test", members, [unit(1, "STL", stl("L", local("n")) + stl("SET") + stl("CALL", callAccess)), unit(2, "STL", stl("T", local("m")) + stl("Assign", local("r")))]);
    const sim = new Simulator(workspace({ "Fx_Test.xml": xml, "Fx_Inner.awl": inner, "Fx_Awl.awl": awl("FUNCTION_BLOCK", decl, ['L #n; SET; CALL "Fx_Inner";', 'T #m; = #r;']) }));
    const actual = sim.callBlock(sim.newInstance("Fx_Test"), { n: 7 });
    expect(actual).toEqual(sim.callBlock(sim.newInstance("Fx_Awl"), { n: 7 }));
    expect(actual.outputs).toMatchObject({ M: 7, R: true });
  });
});

describe("typed STL constants in SimaticML", () => {
  it.each([
    ["DInt", "-1", "L#-1", -1],
    ["DInt", "L#-1", "L#-1", -1],
    ["DInt", "DINT#-1", "L#-1", -1],
    ["Real", "1", "1.0", 1],
    ["Real", "1_000", "1_000.0", 1000],
    ["Real", "REAL#-1.5", "-1.5", -1.5],
    ["Time", "1s", "T#1s", 1000],
    ["Time", "T#1s", "T#1s", 1000],
    ["S5Time", "1s", "S5T#1s", 1000],
    ["S5Time", "S5T#1s", "S5T#1s", 1000],
    ["Word", "65535", "W#16#FFFF", 65535],
    ["Word", "W#16#FFFF", "W#16#FFFF", 65535],
    ["Word", "65_535", "W#16#FFFF", 65535],
    ["Word", "16#FFFF", "W#16#FFFF", 65535],
    ["DWord", "4294967295", "DW#16#FFFFFFFF", 4294967295],
    ["DWord", "DW#16#FFFFFFFF", "DW#16#FFFFFFFF", 4294967295],
    ["Byte", "255", "B#16#FF", 255],
    ["Byte", "B#16#FF", "B#16#FF", 255],
    ["Char", "A", "'A'", "A"],
    ["Char", "'_'", "'_'", "_"],
    ["Char", "CHAR#'A'", "'A'", "A"],
  ] as const)("loads %s %s with its declared type", (type, value, operand, expected) => {
    const members = `<Section Name="Output"><Member Name="out" Datatype="${type}" /></Section>`;
    const xml = fb("Fx_Test", members, [unit(1, "STL", stl("L", literal(type, value)) + stl("T", local("out")))]);
    expect(parseSimaticMl(xml).blocks[0]!.stlNetworks![0]!.source).toBe(`L ${operand};\nT #out;\n`);
    const call = paired(xml, `VAR_OUTPUT\n out : ${type};\nEND_VAR`, [`L ${operand}; T #out;`]);
    expect(call().outputs.OUT).toBe(expected);
  });

  it.each(["true", "1", "BOOL#TRUE", "false"])("uses a Bool constant %s as a bit operand", (value) => {
    const operand = value === "false" ? "FALSE" : "TRUE";
    const members = '<Section Name="Output"><Member Name="out" Datatype="Bool" /></Section>';
    const xml = fb("Fx_Test", members, [unit(1, "STL", stl("A", literal("Bool", value)) + stl("Assign", local("out")))]);
    const call = paired(xml, "VAR_OUTPUT\n out : Bool;\nEND_VAR", [`A ${operand}; = #out;`]);
    expect(call().outputs.OUT).toBe(operand === "TRUE");
  });

  it.each(["1.5", "LREAL#1.5"])("refuses LReal %s instead of silently loading a Real", (value) => {
    const members = '<Section Name="Output"><Member Name="out" Datatype="LReal" /></Section>';
    const xml = fb("Fx_Test", members, [unit(1, "STL", stl("L", literal("LReal", value)) + stl("T", local("out")))]);
    expect(parseSimaticMl(xml).blocks[0]!.stlNetworks![0]!.source).toContain("L LREAL#1.5;");
    const sim = new Simulator(workspace({ "Fx_Test.xml": xml }));
    expect(() => sim.callBlock(sim.newInstance("Fx_Test"))).toThrow(/L LREAL# constants/);
  });

  it.each(["-1", "L#-1"])("keeps the width of a DInt constant %s for +", (value) => {
    const members = '<Section Name="Output"><Member Name="out" Datatype="DInt" /></Section>';
    const source = stl("L", literal("DWord", "DW#16#10000")) + stl("Add", literal("DInt", value)) + stl("T", local("out"));
    const call = paired(fb("Fx_Test", members, [unit(1, "STL", source)]), "VAR_OUTPUT\n out : DInt;\nEND_VAR", ["L DW#16#10000; + L#-1; T #out;"]);
    expect(call().outputs.OUT).toBe(65535);
  });
});
