// SPDX-License-Identifier: MIT
// A planned edit is applied only to the text it was planned against: same version, same old text under every range.
import { describe, it, expect } from "vitest";
import { checkPlan, type TextSnapshot } from "../src/declarations/edits";

const doc = (text: string, version = 4): TextSnapshot => {
  const lines = text.split("\n");
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  return { version, getText: (r) => text.slice(offset(r.start), offset(r.end)) };
};
const at = (line: number, a: number, b = a) => ({ start: { line, character: a }, end: { line, character: b } });

describe("checkPlan", () => {
  const text = "VAR\n   a : Int;\nEND_VAR\n";
  it("passes edits whose version and old text match", () => {
    const r = checkPlan(doc(text), { ok: true, version: 4, edits: [{ range: at(1, 7, 10), old: "Int", newText: "DInt" }] });
    expect(r).toEqual({ ok: true, edits: [{ range: at(1, 7, 10), newText: "DInt" }] });
  });
  it("refuses another version", () => {
    expect(checkPlan(doc(text, 5), { ok: true, version: 4, edits: [] })).toEqual({ ok: false, reason: "The file changed. Review this value again." });
  });
  it("refuses an edit whose text is no longer there", () => {
    expect(checkPlan(doc(text), { ok: true, version: 4, edits: [{ range: at(1, 7, 10), old: "Bool", newText: "DInt" }] })).toEqual({ ok: false, reason: "The file changed. Review this value again." });
  });
  it("passes the server's refusal on", () => {
    expect(checkPlan(doc(text), { ok: false, reason: "No declaration x" })).toEqual({ ok: false, reason: "No declaration x" });
  });
  it("an empty plan is ok and changes nothing", () => {
    expect(checkPlan(doc(text), { ok: true, version: 4, edits: [] })).toEqual({ ok: true, edits: [] });
  });
});
