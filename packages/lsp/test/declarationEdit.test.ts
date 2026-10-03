// SPDX-License-Identifier: BUSL-1.1
// Edits a table makes: each changes only its own text, keeps CRLF and unrelated attributes.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { declarationModel } from "../src/declarations.js";
import { planDeclarationEdit, type DeclOp } from "../src/declarationEdit.js";
import { monitorServer } from "./monitorHarness.js";

const SRC = [
  'FUNCTION_BLOCK "Fx_Motor"',
  "   VAR",
  "      Speed { S7_SetPoint := 'True'; Foo := 'x'} : Real := 1500.0;   // rpm",
  "      Delay : Time;",
  "      Run { ExternalWritable := 'False'} : Bool;",
  "   END_VAR",
  "BEGIN",
  "END_FUNCTION_BLOCK",
  "",
].join("\n");

const apply = (src: string, op: DeclOp) => {
  const plan = planDeclarationEdit(src, declarationModel("file:///w/a.scl", 1, src, parse(src)), op);
  if (!plan.ok) throw new Error(plan.reason);
  let out = src;
  for (const e of [...plan.edits].sort((a, b) => b.start - a.start)) {
    expect(out.slice(e.start, e.end)).toBe(e.old);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
};
/** The lines that differ between two texts, as [before, after]. */
const changed = (a: string, b: string) => {
  const al = a.split("\n");
  const bl = b.split("\n");
  return al.map((l, i) => (l === bl[i] ? null : [l, bl[i]])).filter(Boolean);
};

describe("planDeclarationEdit", () => {
  it("setStart replaces only the value, adds and removes := cleanly", () => {
    expect(changed(SRC, apply(SRC, { op: "setStart", row: "Speed", value: "1200.0" }))).toEqual([
      ["      Speed { S7_SetPoint := 'True'; Foo := 'x'} : Real := 1500.0;   // rpm", "      Speed { S7_SetPoint := 'True'; Foo := 'x'} : Real := 1200.0;   // rpm"],
    ]);
    expect(apply(SRC, { op: "setStart", row: "Delay", value: "T#2s" })).toContain("      Delay : Time := T#2s;\n");
    expect(apply(SRC, { op: "setStart", row: "Speed", value: null })).toContain("Foo := 'x'} : Real;   // rpm");
  });

  it("setAttr writes what TIA writes: a value other than TIA's default is an entry, the default is no entry", () => {
    // S7_SetPoint defaults to False: setting it off removes the entry, leaving the unknown one
    expect(apply(SRC, { op: "setAttr", row: "Speed", key: "S7_SetPoint", state: "off" })).toContain("Speed { Foo := 'x'} : Real");
    expect(apply(SRC, { op: "setAttr", row: "Speed", key: "Foo", state: "default" })).toContain("Speed { S7_SetPoint := 'True'} : Real");
    // ExternalWritable defaults to True: on removes the only entry and its braces
    expect(apply(SRC, { op: "setAttr", row: "Run", key: "ExternalWritable", state: "on" })).toContain("      Run : Bool;\n");
    expect(apply(SRC, { op: "setAttr", row: "Delay", key: "ExternalVisible", state: "off" })).toContain("Delay { ExternalVisible := 'False'} : Time;");
    expect(apply(SRC, { op: "setAttr", row: "Speed", key: "ExternalWritable", state: "off" })).toContain("{ S7_SetPoint := 'True'; Foo := 'x'; ExternalWritable := 'False'}");
    expect(apply(SRC, { op: "setAttr", row: "Run", key: "S7_SetPoint", state: "on" })).toContain("Run { ExternalWritable := 'False'; S7_SetPoint := 'True'} : Bool;");
    // already as asked: no change at all
    expect(apply(SRC, { op: "setAttr", row: "Delay", key: "ExternalVisible", state: "on" })).toBe(SRC);
    expect(apply(SRC, { op: "setAttr", row: "Delay", key: "ExternalVisible", state: "default" })).toBe(SRC);
    expect(apply(SRC, { op: "setAttr", row: "Run", key: "ExternalWritable", state: "off" })).toBe(SRC);
  });

  it("setComment replaces or adds the line comment", () => {
    expect(apply(SRC, { op: "setComment", row: "Speed", value: "rated speed" })).toContain("1500.0;   // rated speed\n");
    expect(apply(SRC, { op: "setComment", row: "Delay", value: "start delay" })).toContain("Delay : Time;   // start delay\n");
    expect(apply(SRC, { op: "setComment", row: "Speed", value: null })).toContain(":= 1500.0;\n");
  });

  it("edit keeps CRLF", () => {
    const crlf = SRC.replace(/\n/g, "\r\n");
    const out = apply(crlf, { op: "setComment", row: "Speed", value: "rated speed" });
    expect(out).toContain("1500.0;   // rated speed\r\n");
    expect(out.split("\r\n").length).toBe(crlf.split("\r\n").length);
    expect(/[^\r]\n/.test(out)).toBe(false);
  });

  it("the language server returns ranged edits for the shown version and refuses a stale one", async () => {
    const s = await monitorServer();
    try {
      const ok = await s.client.sendRequest<{ ok: boolean; edits: { range: { start: { line: number; character: number } }; old: string; newText: string }[] }>("rung/declarationEdit", { textDocument: { uri: s.uri, version: 1 }, op: { op: "setStart", row: "count", value: "5" } });
      expect(ok).toMatchObject({ ok: true, edits: [{ range: { start: { line: 2, character: 14 } }, old: "", newText: " := 5" }] });
      const stale = await s.client.sendRequest("rung/declarationEdit", { textDocument: { uri: s.uri, version: 0 }, op: { op: "setStart", row: "count", value: "5" } });
      expect(stale).toEqual({ ok: false, reason: "The file changed. Review this value again." });
    } finally {
      await s.dispose();
    }
  });

  it("refuses a struct start value and an unknown row", () => {
    const S = 'FUNCTION_BLOCK "A"\n   VAR\n      S : Struct\n         x : Int;\n      END_STRUCT;\n   END_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n';
    const m = declarationModel("u", 1, S, parse(S));
    expect(planDeclarationEdit(S, m, { op: "setStart", row: "S", value: "1" })).toMatchObject({ ok: false });
    expect(planDeclarationEdit(S, m, { op: "setStart", row: "Nope", value: "1" })).toMatchObject({ ok: false });
    expect(planDeclarationEdit(S, m, { op: "setStart", row: "S/x", value: "5" })).toMatchObject({ ok: true });
  });
});
