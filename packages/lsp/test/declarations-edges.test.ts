// SPDX-License-Identifier: BUSL-1.1
// Edges of the declaration model and edits: STRUCT blocks, half-typed values, ids, comments next to code.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { declarationModel } from "../src/declarations.js";
import { planDeclarationEdit, type DeclOp } from "../src/declarationEdit.js";

const fb = (body: string) => `FUNCTION_BLOCK "F"\n VAR\n${body}\n END_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n`;
const model = (text: string) => declarationModel("file:///w/a.scl", 1, text, parse(text));
const applyIfAllowed = (text: string, op: DeclOp) => {
  const plan = planDeclarationEdit(text, model(text), op);
  if (!plan.ok) return text;
  return [...plan.edits].sort((a, b) => b.start - a.start).reduce((result, e) => result.slice(0, e.start) + e.text + result.slice(e.end), text);
};

describe("declarations: edges", () => {
  it.each([
    'TYPE "T"\n STRUCT\n  x : Int;\n END_STRUCT;\nEND_TYPE\n',
    'DATA_BLOCK "D"\n STRUCT\n  x : Int;\n END_STRUCT;\nBEGIN\nEND_DATA_BLOCK\n',
  ])("keeps the successfully parsed declarations of a STRUCT-style block", (text) => {
    expect(parse(text).diagnostics).toEqual([]);
    expect(parse(text).blocks[0]!.vars.map((v) => v.name)).toEqual(["x"]);
    expect(model(text).sections.flatMap((s) => s.rows).map((r) => r.name)).toEqual(["x"]);
  });

  it("never returns an inverted edit range for a half-typed initializer", () => {
    const text = fb("  a : Int :=");
    const plan = planDeclarationEdit(text, model(text), { op: "setStart", row: "a", value: "5" });
    if (plan.ok) for (const edit of plan.edits) expect(edit.start).toBeLessThanOrEqual(edit.end);
  });

  it("assigns distinct row IDs to a quoted slash name and a struct member", () => {
    const text = fb(' "a/b" : Int;\n a : Struct\n b : Int;\n END_STRUCT;');
    expect(parse(text).diagnostics).toEqual([]);
    const rows = model(text).sections[0]!.rows;
    const ids = [rows[0]!.id, rows[1]!.id, rows[1]!.children![0]!.id];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not swallow a following same-line declaration when adding a comment", () => {
    const text = fb("  a : Int; b : Int;");
    const out = applyIfAllowed(text, { op: "setComment", row: "a", value: "new comment" });
    expect(parse(out).blocks[0]!.vars.map((v) => v.name)).toEqual(["a", "b"]);
  });

  it("does not swallow a following declaration when replacing an inline block comment", () => {
    const text = fb("  a : Int; (* old comment *) b : Int;");
    const out = applyIfAllowed(text, { op: "setComment", row: "a", value: "new comment" });
    expect(parse(out).blocks[0]!.vars.map((v) => v.name)).toEqual(["a", "b"]);
  });
});
