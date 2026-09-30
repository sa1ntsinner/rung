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
