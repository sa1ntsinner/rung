// SPDX-License-Identifier: BUSL-1.1
// Edits the test table makes: each changes only its own text, in the style the file already uses (flow or block
// maps), keeps comments and CRLF, and quotes only what YAML needs quoted.
import { describe, it, expect } from "vitest";
import { testModel } from "../src/testModel.js";
import { planTestEdit, type TestOp } from "../src/testEdit.js";

const SRC = [
  "block: Fx_Motor",
  "cases:",
  "  - name: starts",
  "    steps:",
  "      - set: { Start: true, Speed: 5 }   # go",
  "      - cycle: 1",
  "      # it runs",
  "      - expect:",
  "          Running: true",
  "          Count: 1",
  "  - name: stops",
  "    steps:",
  "      - { set: { Start: false }, advance: 2s }",
  "",
].join("\n");

const plan = (src: string, op: TestOp) => planTestEdit(src, testModel(src), op);
const apply = (src: string, op: TestOp) => {
  const p = plan(src, op);
  if (!p.ok) throw new Error(p.reason);
  let out = src;
  for (const e of [...p.edits].sort((a, b) => b.start - a.start)) {
    expect(out.slice(e.start, e.end)).toBe(e.old);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  // what the table writes is always YAML rung test reads
  expect(testModel(out).errors).toEqual([]);
  return out;
};

describe("planTestEdit: values and keys", () => {
  it("setValue replaces only the value, flow or block, comments kept", () => {
    expect(apply(SRC, { op: "setValue", case: 0, step: 0, part: "set", key: "Speed", value: "7.5" })).toBe(SRC.replace("Speed: 5 }   # go", "Speed: 7.5 }   # go"));
    expect(apply(SRC, { op: "setValue", case: 0, step: 2, part: "expect", key: "Count", value: "2" })).toBe(SRC.replace("Count: 1", "Count: 2"));
  });
  it("quotes only what YAML needs: a flow map's commas and brackets, a leading quote, ': '", () => {
    expect(apply(SRC, { op: "setValue", case: 0, step: 0, part: "set", key: "Speed", value: "a, b" })).toContain("Speed: 'a, b' }");
    expect(apply(SRC, { op: "setValue", case: 0, step: 2, part: "expect", key: "Count", value: "x: y" })).toContain("Count: 'x: y'");
    expect(apply(SRC, { op: "setValue", case: 0, step: 0, part: "set", key: "Speed", value: "T#500ms" })).toContain("Speed: T#500ms }");
    expect(apply(SRC, { op: "setValue", case: 0, step: 0, part: "set", key: "Speed", value: "-3" })).toContain("Speed: -3 }");
  });
  it("a quoted value or key keeps its quotes", () => {
    const q = SRC.replace("Count: 1", 'Elapsed: "T#0ms"').replace("Running: true", "'Label': 'idle'");
    expect(apply(q, { op: "setValue", case: 0, step: 2, part: "expect", key: "Elapsed", value: "T#5ms" })).toContain('Elapsed: "T#5ms"');
    expect(apply(q, { op: "setValue", case: 0, step: 2, part: "expect", key: "Label", value: "it's on" })).toContain("'Label': 'it''s on'");
    expect(apply(q, { op: "setKey", case: 0, step: 2, part: "expect", key: "Label", newKey: "Text" })).toContain("'Text': 'idle'");
  });
  it("every value of the example tests written back as it is changes nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const ex = readFileSync(new URL("../../../examples/conveyor/tests/conveyor.test.yaml", import.meta.url), "utf8");
    const m = (await import("../src/testModel.js")).testModel(ex);
    for (const c of m.cases)
      for (const s of c.steps)
        for (const part of ["set", "expect"] as const)
          for (const e of s[part]?.entries ?? []) {
            const p = planTestEdit(ex, m, { op: "setValue", case: c.index, step: s.index, part, key: e.key, value: e.value });
            if (!p.ok) throw new Error(p.reason);
            for (const x of p.edits) expect([e.key, x.text]).toEqual([e.key, x.old]);
          }
  });
  it("setKey renames a key, quoting a path YAML would misread", () => {
    expect(apply(SRC, { op: "setKey", case: 0, step: 0, part: "set", key: "Speed", newKey: "pts[2].x" })).toContain("{ Start: true, 'pts[2].x': 5 }");
    expect(apply(SRC, { op: "setKey", case: 0, step: 2, part: "expect", key: "Count", newKey: '"DB".Ready' })).toContain("\n          '\"DB\".Ready': 1\n");
  });
  it("addEntry: at the end of a flow map, as a new line in a block map, into {}", () => {
    expect(apply(SRC, { op: "addEntry", case: 0, step: 0, part: "set", key: "Reset", value: "false" })).toContain("{ Start: true, Speed: 5, Reset: false }   # go");
    expect(apply(SRC, { op: "addEntry", case: 0, step: 2, part: "expect", key: "Fault", value: "false" })).toContain("          Count: 1\n          Fault: false\n");
    const empty = SRC.replace("{ Start: true, Speed: 5 }", "{}");
    expect(apply(empty, { op: "addEntry", case: 0, step: 0, part: "set", key: "Start", value: "true" })).toContain("- set: { Start: true }   # go");
  });
  it("addEntry to a part the step does not have yet", () => {
    expect(apply(SRC, { op: "addEntry", case: 1, step: 0, part: "expect", key: "Running", value: "false" })).toContain("- { set: { Start: false }, advance: 2s, expect: { Running: false } }");
    expect(apply(SRC, { op: "addEntry", case: 0, step: 1, part: "expect", key: "Running", value: "true" })).toContain("      - cycle: 1\n        expect: { Running: true }\n");
  });
  it("removeEntry: its comma goes too; the last entry of a part takes the part with it", () => {
    expect(apply(SRC, { op: "removeEntry", case: 0, step: 0, part: "set", key: "Start" })).toContain("- set: { Speed: 5 }   # go");
    expect(apply(SRC, { op: "removeEntry", case: 0, step: 0, part: "set", key: "Speed" })).toContain("- set: { Start: true }   # go");
    expect(apply(SRC, { op: "removeEntry", case: 0, step: 2, part: "expect", key: "Running" })).toContain("      - expect:\n          Count: 1\n");
    expect(apply(SRC, { op: "removeEntry", case: 1, step: 0, part: "set", key: "Start" })).toContain("- { advance: 2s }");
    expect(plan(SRC.replace("{ Start: true, Speed: 5 }", "{ Start: true }"), { op: "removeEntry", case: 0, step: 0, part: "set", key: "Start" })).toMatchObject({ ok: false });
  });
  it("a duplicate key is refused", () => {
    expect(plan(SRC, { op: "addEntry", case: 0, step: 0, part: "set", key: "start", value: "1" })).toMatchObject({ ok: false });
  });
});

describe("planTestEdit: steps and cases", () => {
  it("setRun changes or adds a cycle count or a time", () => {
    expect(apply(SRC, { op: "setRun", case: 0, step: 1, kind: "cycle", value: "5" })).toContain("      - cycle: 5\n");
    expect(apply(SRC, { op: "setRun", case: 1, step: 0, kind: "advance", value: "500ms" })).toContain("advance: 500ms }");
    expect(apply(SRC, { op: "setRun", case: 1, step: 0, kind: "cycle", value: "2" })).toContain("advance: 2s, cycle: 2 }");
  });
  it("addStep after a step or at the end of the case, in the case's indentation", () => {
    expect(apply(SRC, { op: "addStep", case: 0, after: 1, kind: "cycle" })).toContain("      - cycle: 1\n      - cycle: 1\n      # it runs\n");
    expect(apply(SRC, { op: "addStep", case: 1, kind: "expect" })).toBe(SRC + "      - expect: {}\n");
    expect(apply(SRC, { op: "addStep", case: 1, kind: "set" })).toBe(SRC + "      - set: {}\n");
  });
  it("removeStep takes its lines and the comment above it", () => {
    expect(apply(SRC, { op: "removeStep", case: 0, step: 2 })).toBe(SRC.replace("      # it runs\n      - expect:\n          Running: true\n          Count: 1\n", ""));
    expect(plan(SRC, { op: "removeStep", case: 1, step: 0 })).toMatchObject({ ok: false });
  });
  it("moveStep swaps a step with its neighbour, each with its comment", () => {
    expect(apply(SRC, { op: "moveStep", case: 0, step: 2, by: -1 })).toBe(
      SRC.replace("      - cycle: 1\n      # it runs\n      - expect:\n          Running: true\n          Count: 1\n", "      # it runs\n      - expect:\n          Running: true\n          Count: 1\n      - cycle: 1\n"),
    );
  });
  it("cases: add, rename (unique, not empty), duplicate, remove (never the last)", () => {
    expect(apply(SRC, { op: "addCase", name: "resets" })).toBe(SRC + "  - name: resets\n    steps:\n      - cycle: 1\n");
    expect(apply(SRC, { op: "renameCase", case: 1, name: "stops: on demand" })).toContain("  - name: 'stops: on demand'\n");
    expect(plan(SRC, { op: "renameCase", case: 1, name: "STARTS" })).toMatchObject({ ok: false });
    expect(plan(SRC, { op: "renameCase", case: 1, name: " " })).toMatchObject({ ok: false });
    expect(apply(SRC, { op: "duplicateCase", case: 1, name: "stops again" })).toBe(SRC + "  - name: stops again\n    steps:\n      - { set: { Start: false }, advance: 2s }\n");
    expect(apply(SRC, { op: "removeCase", case: 0 })).toBe(SRC.replace(/ {2}- name: starts\n[\s\S]*?(?= {2}- name: stops)/, ""));
    expect(plan(SRC.replace(/ {2}- name: stops\n[\s\S]*$/, ""), { op: "removeCase", case: 0 })).toMatchObject({ ok: false });
  });
  it("keeps CRLF", () => {
    const crlf = SRC.replace(/\n/g, "\r\n");
    const out = apply(crlf, { op: "addCase", name: "x" });
    expect(out.endsWith("  - name: x\r\n    steps:\r\n      - cycle: 1\r\n")).toBe(true);
    expect(/[^\r]\n/.test(apply(crlf, { op: "addEntry", case: 0, step: 2, part: "expect", key: "F", value: "1" }))).toBe(false);
  });
});
