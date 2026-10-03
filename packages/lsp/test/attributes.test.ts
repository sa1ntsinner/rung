// SPDX-License-Identifier: BUSL-1.1
// TIA attribute pragmas: entries with their exact spans, quotes and '' escapes respected.
import { describe, it, expect } from "vitest";
import { attrState, parseAttributes } from "../src/attributes.js";

describe("parseAttributes", () => {
  it("finds every entry with key and value spans", () => {
    const src = "x {InstructionName := 'TON_TIME'; LibVersion := '1.0'; S7_SetPoint := 'False'} : TON_TIME;";
    const s = src.indexOf("{");
    const list = parseAttributes(src, { start: s, end: src.indexOf("}") + 1 });
    expect(list.entries.map((e) => [e.key, e.value])).toEqual([
      ["InstructionName", "TON_TIME"],
      ["LibVersion", "1.0"],
      ["S7_SetPoint", "False"],
    ]);
    const sp = list.entries[2]!;
    expect(src.slice(sp.key_.start, sp.key_.end)).toBe("S7_SetPoint");
    expect(src.slice(sp.value_.start, sp.value_.end)).toBe("'False'");
  });

  it("does not split on ; or } inside quotes and reads '' as a quote", () => {
    const src = "{ Comment := 'a;b}c''d'; ExternalWritable := 'True' }";
    const list = parseAttributes(src, { start: 0, end: src.length });
    expect(list.entries.map((e) => e.value)).toEqual(["a;b}c'd", "True"]);
  });

  it("states: explicit values in any case; absent means TIA's default, marked as not explicit", () => {
    const src = "{ ExternalWritable := 'false'; S7_SetPoint := 'TRUE'}";
    const list = parseAttributes(src, { start: 0, end: src.length });
    expect(attrState(list, "ExternalWritable")).toEqual({ value: false, explicit: true });
    expect(attrState(list, "S7_SetPoint")).toEqual({ value: true, explicit: true });
    expect(attrState(list, "ExternalVisible")).toEqual({ value: true, explicit: false });
    expect(attrState(undefined, "S7_SetPoint")).toEqual({ value: false, explicit: false });
  });
});
