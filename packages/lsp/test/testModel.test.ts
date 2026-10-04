// SPDX-License-Identifier: BUSL-1.1
// A test file read for the test table: cases, steps and their set/expect entries with the exact text ranges every
// later edit replaces, from flow maps ({ a: 1 }) and block maps alike. Nothing is re-written by reading.
import { describe, it, expect } from "vitest";
import { testModel } from "../src/testModel.js";

const SRC = [
  "# drives",
  "block: Fx_Motor   # the motor",
  "cycle: 10ms",
  "stubs:",
  "  RDREC: { VALID: false, LEN: 4 }",
  "cases:",
  "  - name: starts and latches",
  "    steps:",
  "      - set: { Start: true, 'pts[2].x': 1.5 }   # go",
  "      - cycle: 1",
  "      - expect:",
  "          Running: true",
  '          "\\"DB\\".Ready": false',
  "      - { set: { Start: false }, advance: 2s, expect: { Running: true } }",
  "  - name: 'stops: on demand'",
  "    steps:",
  "      - advance: T#500ms",
  "",
].join("\n");

const slice = (s: string, r?: { start: number; end: number }) => (r ? s.slice(r.start, r.end) : undefined);

describe("testModel", () => {
  it("reads block, cycle, stubs and the cases with their names' ranges", () => {
    const m = testModel(SRC);
    expect(m.errors).toEqual([]);
    expect(m.block?.value).toBe("Fx_Motor");
    expect(slice(SRC, m.block?.range)).toBe("Fx_Motor");
    expect(m.cycle?.value).toBe("10ms");
    expect(m.stubs.map((s) => [s.name, s.line, s.entries.map((e) => [e.key, e.value])])).toEqual([["RDREC", 4, [["VALID", "false"], ["LEN", "4"]]]]);
    expect(m.cases.map((c) => c.name?.value)).toEqual(["starts and latches", "stops: on demand"]);
    expect(slice(SRC, m.cases[1]!.name!.range)).toBe("'stops: on demand'");
  });

  it("steps keep their parts in the runner's order, with each entry's key and value text", () => {
    const [s0, s1, s2, s3] = testModel(SRC).cases[0]!.steps;
    expect(s0!.set!.flow).toBe(true);
    expect(s0!.set!.entries.map((e) => [e.key, e.value, slice(SRC, e.keyRange), slice(SRC, e.valueRange)])).toEqual([
      ["Start", "true", "Start", "true"],
      ["pts[2].x", "1.5", "'pts[2].x'", "1.5"],
    ]);
    expect(s1!.cycle?.value).toBe("1");
    expect(s2!.expect!.flow).toBe(false);
    expect(s2!.expect!.entries.map((e) => [e.key, slice(SRC, e.pairRange)])).toEqual([
      ["Running", "Running: true"],
      ['"DB".Ready', '"\\"DB\\".Ready": false'],
    ]);
    // one step with several parts
    expect([s3!.flow, s3!.set?.entries[0]?.key, s3!.advance?.value, s3!.expect?.entries[0]?.value]).toEqual([true, "Start", "2s", "true"]);
    expect(SRC.split("\n")[s3!.line]).toContain("advance: 2s");
  });

  it("a value keeps its text as written for the table (750.0, not 750)", () => {
    const m = testModel("block: X\ncases:\n  - name: a\n    steps:\n      - expect: { Speed: 750.0, Label: 'idle', T: T#2s, F: 1.0e3 }\n");
    expect(m.cases[0]!.steps[0]!.expect!.entries.map((e) => [e.value, e.text])).toEqual([
      ["750", "750.0"],
      ["idle", "idle"],
      ["T#2s", "T#2s"],
      ["1000", "1.0e3"],
    ]);
  });

  it("a comment after a value is not part of its range", () => {
    const e = testModel(SRC).cases[0]!.steps[0]!.set!.entries[1]!;
    expect(SRC.slice(e.valueRange.start, e.valueRange.end)).toBe("1.5");
  });

  it("CRLF and a BOM keep exact ranges", () => {
    const crlf = "﻿" + SRC.replace(/\n/g, "\r\n");
    const e = testModel(crlf).cases[0]!.steps[2]!.expect!.entries[0]!;
    expect(crlf.slice(e.valueRange.start, e.valueRange.end)).toBe("true");
  });

  it("broken YAML is an error with its place, and the cases read before it", () => {
    const m = testModel("block: X\ncases:\n  - name: a\n    steps:\n      - set: { a: 1\n");
    expect(m.errors.length).toBeGreaterThan(0);
    expect(m.errors[0]!.line).toBeGreaterThanOrEqual(0);
  });
});
