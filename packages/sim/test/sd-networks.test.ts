// SPDX-License-Identifier: BUSL-1.1
// LAD in SIMATIC SD runs through the same network translation as LAD in SimaticML: the samples TIA Portal wrote in
// both forms (packages/lsp/test/sd, tools/fixtures/xml/sim) must behave the same under the same tests.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile } from "../src/index.js";

const sd = (name: string) => readFileSync(fileURLToPath(new URL(`../../lsp/test/sd/${name}`, import.meta.url)), "utf8");
const xml = (name: string) => readFileSync(fileURLToPath(new URL(`../../../tools/fixtures/xml/sim/${name}`, import.meta.url)), "utf8");

function index(files: Record<string, string>) {
  const idx = new WorkspaceIndex();
  for (const [name, text] of Object.entries(files)) idx.set(`file:///w/plc/PLC_1/blocks/${name}`, text, 0);
  return idx;
}

async function run(idx: WorkspaceIndex, yaml: string) {
  const r = await runTestFile(idx, "t.test.yaml", yaml);
  return [r.error, ...r.cases.map((c) => [c.name, c.passed, c.error ?? (c.failures?.map((f) => JSON.stringify(f)).join("; ") || undefined)])];
}

const EDGES = `
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
`;

const BOXES = `
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
`;

describe("LAD in SIMATIC SD and in SimaticML behave the same", () => {
  for (const [form, edges, boxes] of [
    ["SD", { "Fx_LadEdges.s7dcl": sd("Fx_LadEdges.s7dcl") }, { "Fx_LadBoxes.s7dcl": sd("Fx_LadBoxes.s7dcl"), "Fx_LadHelper.scl": xml("Fx_LadHelper.scl") }],
    ["SimaticML", { "Fx_LadEdges.xml": xml("Fx_LadEdges.xml") }, { "Fx_LadBoxes.xml": xml("Fx_LadBoxes.xml"), "Fx_LadHelper.scl": xml("Fx_LadHelper.scl") }],
  ] as const) {
    it(`${form}: edges (P/N contacts and coils, P_TRIG), NOT, negated contacts and coils, branches, SR and RS`, async () => {
      expect(await run(index(edges), EDGES)).toEqual([undefined, ["edges of a, b and c", true, undefined]]);
    });
    it(`${form}: TON and CTU, compare, IN_RANGE, MOVE, ADD, CONVERT, an FC call with ENO`, async () => {
      expect(await run(index(boxes), BOXES)).toEqual([undefined, ["boxes", true, undefined]]);
    });
  }
});
