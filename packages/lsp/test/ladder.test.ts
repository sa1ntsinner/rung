// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { ladderOf, type LadderElement } from "../src/ladder.js";

const g = (uid: number, name: string) => `<Access Scope="GlobalVariable" UId="${uid}"><Symbol><Component Name="${name}" /></Symbol></Access>`;
const c = (uid: number, value: string, type = "Int") => `<Access Scope="LiteralConstant" UId="${uid}"><Constant><ConstantType>${type}</ConstantType><ConstantValue>${value}</ConstantValue></Constant></Access>`;
const part = (uid: number, name: string, inner = "") => `<Part Name="${name}" UId="${uid}">${inner}</Part>`;
const wire = (...ends: string[]) => `<Wire UId="0">${ends.join("")}</Wire>`;
const pin = (uid: number, name: string) => `<NameCon UId="${uid}" Name="${name}" />`;
const ident = (uid: number) => `<IdentCon UId="${uid}" />`;
const rail = "<Powerrail />";
const unit = (lang: string, source: string, title = "") =>
  `<SW.Blocks.CompileUnit ID="1" CompositionName="CompileUnits"><AttributeList><NetworkSource>${source}</NetworkSource><ProgrammingLanguage>${lang}</ProgrammingLanguage></AttributeList><ObjectList><MultilingualText CompositionName="Title"><ObjectList><MultilingualTextItem><AttributeList><Culture>en-US</Culture><Text>${title}</Text></AttributeList></MultilingualTextItem></ObjectList></MultilingualText></ObjectList></SW.Blocks.CompileUnit>`;
const flg = (parts: string, wires: string) => `<FlgNet xmlns="x"><Parts>${parts}</Parts><Wires>${wires}</Wires></FlgNet>`;
const block = (...units: string[]) =>
  `<?xml version="1.0"?><Document><SW.Blocks.OB ID="0"><AttributeList><Name>Main</Name><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList><ObjectList>${units.join("")}</ObjectList></SW.Blocks.OB></Document>`;

/** A compact picture of a rung: [A] contact, /[A] negated, (S A) coil, {A<=B} compare, <Box> box, OR(..|..), SPLIT(..|..). */
const show = (els: LadderElement[]): string =>
  els
    .map((e) =>
      e.k === "contact" ? `${e.negated ? "/" : ""}${e.edge ?? ""}[${e.operand}]`
      : e.k === "coil" ? `(${e.kind}${e.operand})`
      : e.k === "compare" ? `{${e.in1}${e.op}${e.in2}}`
      : e.k === "box" ? `<${e.name}${e.instance ? " " + e.instance : ""}>`
      : `${e.merge ? "OR" : "SPLIT"}(${e.branches.map(show).join(" | ")})`,
    )
    .join(" ");

const one = (source: string, lang = "LAD") => ladderOf(block(unit(lang, source, "net"))).networks[0]!;

describe("LAD networks as ladders", () => {
  it("draws a latch: two contacts in parallel into a set coil", () => {
    const n = one(flg(
      g(21, "Start") + g(22, "HMI_Start") + g(23, "Run") + part(24, "Contact") + part(25, "Contact") + part(26, "O") + part(27, "SCoil"),
      wire(rail, pin(24, "in"), pin(25, "in")) + wire(ident(21), pin(24, "operand")) + wire(pin(24, "out"), pin(26, "in1")) + wire(ident(22), pin(25, "operand")) +
        wire(pin(25, "out"), pin(26, "in2")) + wire(pin(26, "out"), pin(27, "in")) + wire(ident(23), pin(27, "operand")),
    ));
    expect(n.title).toBe("net");
    expect(show(n.rung!)).toBe('OR(["Start"] | ["HMI_Start"]) (S"Run")');
  });

  it("draws contacts, a compare and a box in series, with the box's data pins", () => {
    const n = one(flg(
      g(21, "Pump") + g(22, "Level") + c(23, "95") + g(24, "Level") + c(25, "5") + g(26, "Level") + part(28, "Contact", '<Negated Name="operand" />') + part(30, "Le", '<TemplateValue Name="SrcType" Type="Type">Int</TemplateValue>') + part(31, "Add"),
      wire(rail, pin(28, "in")) + wire(ident(21), pin(28, "operand")) + wire(pin(28, "out"), pin(30, "pre")) + wire(ident(22), pin(30, "in1")) + wire(ident(23), pin(30, "in2")) +
        wire(pin(30, "out"), pin(31, "en")) + wire(ident(24), pin(31, "in1")) + wire(ident(25), pin(31, "in2")) + wire(pin(31, "out"), ident(26)),
    ));
    expect(show(n.rung!)).toBe('/["Pump"] {"Level"<=95} <Add>');
    expect(n.rung![1]).toMatchObject({ k: "compare", type: "Int" });
    expect(n.rung![2]).toMatchObject({ flowIn: "en", inputs: [{ pin: "in1", operand: '"Level"' }, { pin: "in2", operand: "5" }], outputs: [{ pin: "out", operand: '"Level"' }] });
  });

  it("draws a timer box with its instance, and coils in series and on a split", () => {
    const n = one(flg(
      g(21, "Go") + `<Access Scope="TypedConstant" UId="22"><Constant><ConstantValue>t#3s</ConstantValue></Constant></Access>` + g(23, "A") + g(24, "B") +
        part(25, "Contact") + part(26, "TON", '<Instance Scope="GlobalVariable" UId="27"><Component Name="Delay" /></Instance>') + part(28, "Coil") + part(29, "RCoil"),
      wire(rail, pin(25, "in")) + wire(ident(21), pin(25, "operand")) + wire(pin(25, "out"), pin(26, "IN")) + wire(ident(22), pin(26, "PT")) +
        wire(pin(26, "Q"), pin(28, "in"), pin(29, "in")) + wire(ident(23), pin(28, "operand")) + wire(ident(24), pin(29, "operand")) + wire(pin(26, "ET"), '<OpenCon UId="30" />'),
    ));
    expect(show(n.rung!)).toBe('["Go"] <TON "Delay"> SPLIT(("A") | (R"B"))');
    expect(n.rung![1]).toMatchObject({ flowIn: "IN", flowOut: "Q", inputs: [{ pin: "PT", operand: "t#3s" }], outputs: [{ pin: "ET", operand: "…" }] });
  });

  it("draws an OR nested in the branch of another OR", () => {
    // ((A OR B) AND C) OR D -> coil
    const n = one(flg(
      g(1, "A") + g(2, "B") + g(3, "C") + g(4, "D") + g(5, "Q") + part(11, "Contact") + part(12, "Contact") + part(13, "O") + part(14, "Contact") + part(15, "Contact") + part(16, "O") + part(17, "Coil"),
      wire(rail, pin(11, "in"), pin(12, "in"), pin(15, "in")) + wire(ident(1), pin(11, "operand")) + wire(ident(2), pin(12, "operand")) + wire(pin(11, "out"), pin(13, "in1")) + wire(pin(12, "out"), pin(13, "in2")) +
        wire(pin(13, "out"), pin(14, "in")) + wire(ident(3), pin(14, "operand")) + wire(pin(14, "out"), pin(16, "in1")) + wire(ident(4), pin(15, "operand")) + wire(pin(15, "out"), pin(16, "in2")) +
        wire(pin(16, "out"), pin(17, "in")) + wire(ident(5), pin(17, "operand")),
    ));
    expect(n.note).toBeUndefined();
    expect(show(n.rung!)).toBe('OR(OR(["A"] | ["B"]) ["C"] | ["D"]) ("Q")');
  });

  it("shows what is no ladder as text: a box fed by two power flows, an FBD network, an SCL network", () => {
    const sr = one(flg(
      g(1, "S") + g(2, "R") + g(3, "Q") + part(11, "Contact") + part(12, "Contact") + part(13, "SR"),
      wire(rail, pin(11, "in"), pin(12, "in")) + wire(ident(1), pin(11, "operand")) + wire(ident(2), pin(12, "operand")) + wire(pin(11, "out"), pin(13, "s")) + wire(pin(12, "out"), pin(13, "r1")) + wire(ident(3), pin(13, "operand")),
    ));
    expect(sr.rung).toBeUndefined();
    expect(sr.note).toMatch(/SR gets more than one power flow/);
    const fbd = one(flg(g(1, "A") + g(2, "Q") + part(11, "Coil"), wire(ident(1), pin(11, "in")) + wire(ident(2), pin(11, "operand"))), "FBD");
    expect(fbd.note).toBe("FBD network");
    const scl = one('<StructuredText xmlns="y"><Token Text="#a" /><Blank /><Token Text=":=" /><Blank /><Token Text="1" /><Token Text=";" /></StructuredText>', "SCL");
    expect(scl.text).toBe("#a := 1;");
  });
});
