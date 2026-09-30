// SPDX-License-Identifier: BUSL-1.1
// LAD and FBD blocks kept as SimaticML (almost every real LAD block: SD text cannot hold network titles and
// comments) run on the simulator from their FlgNet networks. The blocks in tools/fixtures/xml/sim are TIA
// Portal V20's own exports.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex, parseSimaticMl } from "@rung/lsp";
import { runTestFile } from "../src/index.js";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../../tools/fixtures/xml/${name}`, import.meta.url)), "utf8");

function index(...names: string[]) {
  const idx = new WorkspaceIndex();
  for (const name of names) idx.set(`file:///w/plc/PLC_1/blocks/${name.split("/").pop()}`, fixture(name), 0);
  return idx;
}

/** A hand-made LAD network in TIA Portal's FlgNet form (parts, operands, wires). */
class Net {
  private uid = 21;
  readonly parts: string[] = [];
  readonly wires: string[] = [];
  local(name: string) {
    const u = this.uid++;
    this.parts.push(`<Access Scope="LocalVariable" UId="${u}"><Symbol><Component Name="${name}" /></Symbol></Access>`);
    return u;
  }
  part(name: string, templates: Record<string, string> = {}) {
    const u = this.uid++;
    const t = Object.entries(templates).map(([k, v]) => `<TemplateValue Name="${k}" Type="${k === "Card" ? "Cardinality" : "Type"}">${v}</TemplateValue>`);
    this.parts.push(`<Part Name="${name}" UId="${u}">${t.join("")}</Part>`);
    return u;
  }
  call(name: string, type: "FB" | "FC", params: [string, string, string][]) {
    const u = this.uid++;
    this.parts.push(`<Call UId="${u}"><CallInfo Name="${name}" BlockType="${type}">${params.map(([n, s, t]) => `<Parameter Name="${n}" Section="${s}" Type="${t}" />`).join("")}</CallInfo></Call>`);
    return u;
  }
  ident = (u: number) => `<IdentCon UId="${u}" />`;
  pin = (u: number, name: string) => `<NameCon UId="${u}" Name="${name}" />`;
  wire(...ends: string[]) {
    this.wires.push(`<Wire UId="${this.uid++}">${ends.join("")}</Wire>`);
  }
}

/** An FB with these statics and one LAD network per Net, in a workspace of its own. */
function block(name: string, members: [string, string][], ...nets: Net[]) {
  const units = nets.map(
    (n, i) =>
      `<SW.Blocks.CompileUnit ID="${i + 1}" CompositionName="CompileUnits"><AttributeList><NetworkSource><FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v5"><Parts>${n.parts.join("")}</Parts><Wires>${n.wires.join("")}</Wires></FlgNet></NetworkSource><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList></SW.Blocks.CompileUnit>`,
  );
  const xml = `<?xml version="1.0" encoding="utf-8"?><Document><SW.Blocks.FB ID="0"><AttributeList><Interface><Sections><Section Name="Static">${members.map(([m, t]) => `<Member Name="${m}" Datatype="${t}" />`).join("")}</Section></Sections></Interface><Name>${name}</Name><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList><ObjectList>${units.join("")}</ObjectList></SW.Blocks.FB></Document>`;
  const idx = new WorkspaceIndex();
  idx.set(`file:///w/plc/PLC_1/blocks/${name}.xml`, xml, 0);
  return idx;
}

async function run(idx: WorkspaceIndex, yaml: string) {
  const r = await runTestFile(idx, "t.test.yaml", yaml);
  return [r.error, ...r.cases.map((c) => [c.name, c.passed, c.error ?? (c.failures?.map((f) => JSON.stringify(f)).join("; ") || undefined)])];
}

describe("LAD and FBD blocks in SimaticML", () => {
  it("runs a LAD FC: contacts in series into a coil", async () => {
    expect(
      await run(index("Fx_LadInterlock.xml"), `
block: Fx_LadInterlock
cases:
  - name: both inputs
    steps:
      - { set: { Enable: true, Guard: true }, cycle: 1, expect: { Out: true } }
      - { set: { Guard: false }, cycle: 1, expect: { Out: false } }
`),
    ).toEqual([undefined, ["both inputs", true, undefined]]);
  });

  it("LAD edges, NOT, negated contacts and coils, branches, SR and RS, set and reset coils", async () => {
    expect(
      await run(index("sim/Fx_LadEdges.xml"), `
block: Fx_LadEdges
cases:
  - name: edges of a, b and c
    steps:
      - { set: { a: true }, cycle: 1, expect: { pe: true, ne: false, notOut: false, inv: false, orOut: true, split1: true, split2: false, latch1: true, latch2: true, held: false } }
      - { cycle: 1, expect: { pe: false, latch1: true } }
      - { set: { a: false }, cycle: 1, expect: { ne: true, notOut: true, orOut: false, split1: false, latch1: true } }
      - { cycle: 1, expect: { ne: false } }
      - { set: { b: true }, cycle: 1, expect: { pc: true, nc: false, inv: true, orOut: true, split2: false, latch1: false, latch2: false } }
      - { cycle: 1, expect: { pc: false } }
      - { set: { b: false }, cycle: 1, expect: { nc: true, inv: false, latch2: false } }
      - { set: { c: true }, cycle: 1, expect: { trig: true, held: true } }
      - { cycle: 1, expect: { trig: false, held: true } }
      - { set: { a: true, b: true }, cycle: 1, expect: { split2: true, latch1: false, latch2: true, held: false } }
`),
    ).toEqual([undefined, ["edges of a, b and c", true, undefined]]);
  });

  it("LAD boxes: TON and CTU on multi-instances, compare, IN_RANGE, MOVE, ADD, CONVERT, an FC call with ENO", async () => {
    expect(
      await run(index("sim/Fx_LadBoxes.xml", "sim/Fx_LadHelper.scl"), `
block: Fx_LadBoxes
cycle: 10ms
cases:
  - name: boxes
    steps:
      - { set: { go: true, n: 7, x: 2 }, cycle: 1, expect: { big: true, within: true, m1: 7, m2: 7, sum: 10, real: 7.0, ret: 14, done: true, count: 1, full: false, late: false } }
      - { advance: 60ms, expect: { late: true, elapsed: "T#50ms", count: 1 } }
      - { set: { go: false }, cycle: 1, expect: { late: false, big: false } }
      - { set: { go: true }, cycle: 1 }
      - { set: { go: false }, cycle: 1 }
      - { set: { go: true }, cycle: 1, expect: { count: 3, full: true } }
      - { set: { rst: true, n: 11 }, cycle: 1, expect: { count: 0, full: false, within: false } }
`),
    ).toEqual([undefined, ["boxes", true, undefined]]);
  });

  it("FBD: AND with a negated input, OR, XOR, nesting, set/reset, compare, TON, SR", async () => {
    expect(
      await run(index("sim/Fx_FbdLogic.xml"), `
block: Fx_FbdLogic
cycle: 10ms
cases:
  - name: logic
    steps:
      - { set: { a: true, n: 6 }, cycle: 1, expect: { and_: true, or_: true, xor_: true, mix: true, held: true, big: true, late: false, latch: true } }
      - { advance: 60ms, expect: { late: true } }
      - { set: { b: true }, cycle: 1, expect: { and_: false, xor_: false, held: false, latch: false } }
      - { set: { a: false, b: false, c: true }, cycle: 1, expect: { or_: true, mix: false, late: false, latch: false } }
`),
    ).toEqual([undefined, ["logic", true, undefined]]);
  });

  it("takes the power flow where a branch splits before a coil on one branch changes it", async () => {
    // a ─┬─(R a)
    //    └─( b )     b gets the flow a had at the split, not a after the reset
    const n = new Net();
    const [a1, a2, b] = [n.local("a"), n.local("a"), n.local("b")];
    const c = n.part("Contact");
    const r = n.part("RCoil");
    const q = n.part("Coil");
    n.wire("<Powerrail />", n.pin(c, "in"));
    n.wire(n.ident(a1), n.pin(c, "operand"));
    n.wire(n.pin(c, "out"), n.pin(r, "in"), n.pin(q, "in"));
    n.wire(n.ident(a2), n.pin(r, "operand"));
    n.wire(n.ident(b), n.pin(q, "operand"));
    expect(
      await run(block("Fx_Split", [["a", "Bool"], ["b", "Bool"]], n), `
block: Fx_Split
cases:
  - name: split
    steps:
      - { set: { a: true }, cycle: 1, expect: { a: false, b: true } }
      - { cycle: 1, expect: { a: false, b: false } }
`),
    ).toEqual([undefined, ["split", true, undefined]]);
  });

  it("clears ENO where Siemens does: an overflow, a division by 0, a conversion that does not fit", async () => {
    // box(in1, in2) → OUT, ENO → coil; one network per box
    const nets = (["Add", "Div", "Convert"] as const).map((box) => {
      const n = new Net();
      const [x, y, out, ok] = [n.local("x"), n.local("y"), n.local(`${box.toLowerCase()}Out`), n.local(`${box.toLowerCase()}Ok`)];
      const p = n.part(box, box === "Convert" ? { SrcType: "Int", DestType: "SInt" } : { Card: "2", SrcType: "Int" });
      const q = n.part("Coil");
      n.wire("<Powerrail />", n.pin(p, "en"));
      if (box === "Convert") n.wire(n.ident(x), n.pin(p, "in"));
      else {
        n.wire(n.ident(x), n.pin(p, "in1"));
        n.wire(n.ident(y), n.pin(p, "in2"));
      }
      n.wire(n.pin(p, "out"), n.ident(out));
      n.wire(n.pin(p, "eno"), n.pin(q, "in"));
      n.wire(n.ident(ok), n.pin(q, "operand"));
      return n;
    });
    const idx = block("Fx_Eno", [["x", "Int"], ["y", "Int"], ["addOut", "Int"], ["addOk", "Bool"], ["divOut", "Int"], ["divOk", "Bool"], ["convertOut", "SInt"], ["convertOk", "Bool"]], ...nets);
    expect(
      await run(idx, `
block: Fx_Eno
cases:
  - name: in range
    steps:
      - { set: { x: 100, y: 7 }, cycle: 1, expect: { addOut: 107, addOk: true, divOut: 14, divOk: true, convertOut: 100, convertOk: true } }
  - name: out of range, and a division by 0
    steps:
      - { set: { x: 32767, y: 0 }, cycle: 1, expect: { addOut: 32767, addOk: true, divOk: false, divOut: 0, convertOk: false } }
      - { set: { y: 1 }, cycle: 1, expect: { addOut: -32768, addOk: false, divOut: 32767, divOk: true } }
`),
    ).toEqual([undefined, ["in range", true, undefined], ["out of range, and a division by 0", true, undefined]]);
  });

  it("an FC's in/out writes the operand wired to it: the call graph and the editor see a write", () => {
    const n = new Net();
    const count = n.local("count");
    const f = n.call("Fx_Bump", "FC", [["c", "InOut", "Int"]]);
    n.wire("<Powerrail />", n.pin(f, "en"));
    n.wire(n.ident(count), n.pin(f, "c"));
    const b = [...block("Fx_Caller", [["count", "Int"]], n).docs.values()][0]!.parsed!.blocks[0]!;
    expect(b.refs.filter((r) => r.name === "count").map((r) => r.access)).toEqual(["write"]);
  });

  it("names what it does not run, network by network", async () => {
    const xml = fixture("sim/Fx_LadBoxes.xml").replace('<Part Name="InRange"', '<Part Name="Calculate"');
    const b = parseSimaticMl(xml).blocks[0]!;
    expect(b.ladUnsupported).toEqual(["network 4: Calculate"]);
  });

  it("gives the editor and the call graph the operands of the networks", () => {
    const b = parseSimaticMl(fixture("sim/Fx_LadBoxes.xml")).blocks[0]!;
    const seen = (name: string) => b.refs.filter((r) => r.name === name).map((r) => `${r.kind}:${r.access}`);
    expect(seen("go")).toEqual(["local:read", "local:read", "local:read", "local:read"]);
    expect(seen("sum")).toEqual(["local:write"]);
    expect(seen("delay")).toEqual(["local:call"]);
    expect(seen("Fx_LadHelper")).toEqual(["global:call"]);
    expect(seen("done")).toEqual(["local:write"]);
  });
});
