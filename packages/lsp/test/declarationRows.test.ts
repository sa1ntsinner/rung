// SPDX-License-Identifier: BUSL-1.1
// Edits that change a declaration's shape: its type, new declarations, removed ones. Written as TIA exports them.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { declarationModel } from "../src/declarations.js";
import { planDeclarationEdit, type DeclOp } from "../src/declarationEdit.js";

const SRC = [
  'FUNCTION_BLOCK "Fx_Motor"',
  "   VAR_INPUT",
  "      Enable : Bool;   // run request",
  "   END_VAR",
  "   VAR",
  "      Speed : Real := 1500.0;",
  "      Fb : Struct",
  "         a : Int;",
  "         b : Bool;",
  "      END_STRUCT;",
  "      Delay : Time;",
  "   END_VAR",
  "   VAR_TEMP",
  "   END_VAR",
  "BEGIN",
  "END_FUNCTION_BLOCK",
  "",
].join("\n");

const plan = (src: string, op: DeclOp) => planDeclarationEdit(src, declarationModel("file:///w/a.scl", 1, src, parse(src)), op);
const apply = (src: string, op: DeclOp) => {
  const p = plan(src, op);
  if (!p.ok) throw new Error(p.reason);
  let out = src;
  for (const e of [...p.edits].sort((a, b) => b.start - a.start)) {
    expect(out.slice(e.start, e.end)).toBe(e.old);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
};
const section = (src: string, n: number) => declarationModel("u", 1, src, parse(src)).sections[n]!.id;

describe("setType", () => {
  it("replaces only the type", () => {
    expect(apply(SRC, { op: "setType", row: "Speed", type: "LReal" })).toBe(SRC.replace("Speed : Real :=", "Speed : LReal :="));
    expect(apply(SRC, { op: "setType", row: "Fb/a", type: "DInt" })).toBe(SRC.replace("a : Int;", "a : DInt;"));
  });
  it("refuses a struct and an empty type", () => {
    expect(plan(SRC, { op: "setType", row: "Fb", type: "Int" })).toMatchObject({ ok: false });
    expect(plan(SRC, { op: "setType", row: "Speed", type: "  " })).toMatchObject({ ok: false });
  });
});

describe("insertRows", () => {
  it("after a plain row, with the row's indent, start value and comment", () => {
    expect(apply(SRC, { op: "insertRows", after: "Speed", rows: [{ name: "Accel", type: "Real", start: "2.5", comment: "ramp" }] })).toBe(
      SRC.replace("      Speed : Real := 1500.0;\n", "      Speed : Real := 1500.0;\n      Accel : Real := 2.5;   // ramp\n"),
    );
  });
  it("after a struct: below its END_STRUCT, at the struct's level", () => {
    expect(apply(SRC, { op: "insertRows", after: "Fb", rows: [{ name: "x", type: "Int" }] })).toBe(SRC.replace("      END_STRUCT;\n", "      END_STRUCT;\n      x : Int;\n"));
  });
  it("after a row with a trailing comment: below the comment", () => {
    expect(apply(SRC, { op: "insertRows", after: "Enable", rows: [{ name: "Reset", type: "Bool" }] })).toBe(SRC.replace("// run request\n", "// run request\n      Reset : Bool;\n"));
  });
  it("into an empty section: one level deeper than its header", () => {
    expect(apply(SRC, { op: "insertRows", section: section(SRC, 2), rows: [{ name: "t", type: "Int" }] })).toBe(SRC.replace("   VAR_TEMP\n", "   VAR_TEMP\n      t : Int;\n"));
  });
  it("at the end of a section", () => {
    expect(apply(SRC, { op: "insertRows", section: section(SRC, 1), rows: [{ name: "z", type: "Bool" }, { name: "y", type: "Bool" }] })).toBe(
      SRC.replace("      Delay : Time;\n", "      Delay : Time;\n      z : Bool;\n      y : Bool;\n"),
    );
  });
  it("into a struct: at its end, with its members' indent", () => {
    expect(apply(SRC, { op: "insertRows", into: "Fb", rows: [{ name: "c", type: "Word" }] })).toBe(SRC.replace("         b : Bool;\n", "         b : Bool;\n         c : Word;\n"));
  });
  it("quotes a name TIA quotes, keeps CRLF", () => {
    const crlf = SRC.replace(/\n/g, "\r\n");
    const out = apply(crlf, { op: "insertRows", after: "Speed", rows: [{ name: "30ms Pls", type: "Bool" }, { name: "ok", type: "Bool" }] });
    expect(out).toContain('Speed : Real := 1500.0;\r\n      "30ms Pls" : Bool;\r\n      ok : Bool;\r\n');
    expect(/[^\r]\n/.test(out)).toBe(false);
  });
  it("quotes a name SCL reserves (a keyword or a data type), as TIA requires", () => {
    const out = apply(SRC, { op: "insertRows", after: "Speed", rows: [{ name: "Timer", type: "TON_TIME" }, { name: "time", type: "Time" }, { name: "Counter", type: "Int" }, { name: "Begin", type: "Int" }] });
    expect(out).toContain('      "Timer" {InstructionName := \'TON_TIME\'; LibVersion := \'1.0\'} : TON_TIME;\n      "time" : Time;\n      "Counter" : Int;\n      "Begin" : Int;\n');
  });
  it("writes an instruction instance as TIA exports it: the full type name and its InstructionName", () => {
    const out = apply(SRC, { op: "insertRows", after: "Speed", rows: [{ name: "t1", type: "ton" }, { name: "c1", type: "CTU_DINT" }, { name: "e1", type: "R_TRIG" }] });
    expect(out).toContain(
      "      t1 {InstructionName := 'TON_TIME'; LibVersion := '1.0'} : TON_TIME;\n      c1 {InstructionName := 'CTU_DINT'; LibVersion := '1.0'} : CTU_DINT;\n      e1 {InstructionName := 'R_TRIG'; LibVersion := '1.0'} : R_TRIG;\n",
    );
  });
  it("setType to and from an instruction adds and removes its InstructionName", () => {
    const timer = apply(SRC, { op: "setType", row: "Delay", type: "TOF" });
    expect(timer).toContain("      Delay {InstructionName := 'TOF_TIME'; LibVersion := '1.0'} : TOF_TIME;\n");
    expect(apply(timer, { op: "setType", row: "Delay", type: "TP_LTIME" })).toContain("      Delay {InstructionName := 'TP_LTIME'; LibVersion := '1.0'} : TP_LTIME;\n");
    expect(apply(timer, { op: "setType", row: "Delay", type: "Time" })).toContain("      Delay : Time;\n");
    const kept = SRC.replace("Delay : Time;", "Delay { S7_SetPoint := 'True'} : Time;");
    expect(apply(apply(kept, { op: "setType", row: "Delay", type: "TON" }), { op: "setType", row: "Delay", type: "Time" })).toBe(kept);
  });
  it("refuses a name the block already has, twice in one paste, an empty name or type", () => {
    expect(plan(SRC, { op: "insertRows", after: "Speed", rows: [{ name: "enable", type: "Bool" }] })).toEqual({ ok: false, reason: 'The block already has "enable".' });
    expect(plan(SRC, { op: "insertRows", after: "Speed", rows: [{ name: "q", type: "Bool" }, { name: "Q", type: "Int" }] })).toMatchObject({ ok: false });
    expect(plan(SRC, { op: "insertRows", after: "Speed", rows: [{ name: "", type: "Bool" }] })).toMatchObject({ ok: false });
    expect(plan(SRC, { op: "insertRows", after: "Speed", rows: [{ name: "w", type: "" }] })).toMatchObject({ ok: false });
    // a member's name is only unique inside its struct
    expect(plan(SRC, { op: "insertRows", into: "Fb", rows: [{ name: "Speed", type: "Int" }] })).toMatchObject({ ok: true });
    expect(plan(SRC, { op: "insertRows", into: "Fb", rows: [{ name: "A", type: "Int" }] })).toMatchObject({ ok: false });
  });
  it("refuses a value that would break the line", () => {
    expect(plan(SRC, { op: "insertRows", after: "Speed", rows: [{ name: "w", type: "Int", comment: "two\nlines" }] })).toMatchObject({ ok: false });
    expect(plan(SRC, { op: "insertRows", after: "Speed", rows: [{ name: "w", type: "Int; x : Int" }] })).toMatchObject({ ok: false });
  });
});

describe("values TIA would not accept are refused, never written", () => {
  const CONST = SRC.replace("   VAR_TEMP\n   END_VAR\n", "   VAR_TEMP\n      t : Int;\n   END_VAR\n   VAR CONSTANT\n      K : Int := 3;\n   END_VAR\n");
  it("a default value that would end the declaration or comment out the line", () => {
    expect(plan(SRC, { op: "setStart", row: "Speed", value: "1; extra : Bool" })).toMatchObject({ ok: false });
    expect(plan(SRC, { op: "setStart", row: "Speed", value: "1 // x" })).toMatchObject({ ok: false });
    expect(plan(SRC, { op: "setStart", row: "Speed", value: "1\n2" })).toMatchObject({ ok: false });
    // inside a string literal it is text
    expect(apply(SRC, { op: "setStart", row: "Speed", value: "'a;b'" })).toContain("Speed : Real := 'a;b';");
  });
  it("a comment over two lines, or one that closes a block comment", () => {
    expect(plan(SRC, { op: "setComment", row: "Speed", value: "one\ntwo" })).toMatchObject({ ok: false });
    const block = SRC.replace("Delay : Time;", "Delay : Time; (* old *)");
    expect(plan(block, { op: "setComment", row: "Delay", value: "a *) b" })).toMatchObject({ ok: false });
  });
  it("a temporary has no default value; a constant keeps its value", () => {
    expect(plan(CONST, { op: "setStart", row: "t", value: "1" })).toEqual({ ok: false, reason: "Temporary variables have no default value." });
    expect(plan(CONST, { op: "setStart", row: "K", value: null })).toEqual({ ok: false, reason: "A constant needs a value." });
    expect(plan(CONST, { op: "insertRows", after: "K", rows: [{ name: "L", type: "Int" }] })).toEqual({ ok: false, reason: "A constant needs a value." });
    expect(plan(CONST, { op: "insertRows", after: "t", rows: [{ name: "u", type: "Int", start: "1" }] })).toEqual({ ok: false, reason: "Temporary variables have no default value." });
  });
  it("an FC's parameters have no default value", () => {
    const FC = 'FUNCTION "Calc" : Int\n   VAR_INPUT\n      a : Int;\n   END_VAR\nBEGIN\nEND_FUNCTION\n';
    expect(plan(FC, { op: "setStart", row: "a", value: "1" })).toEqual({ ok: false, reason: "A function's parameters have no default value." });
  });
});

describe("deleteRow", () => {
  it("removes the whole lines with the comment", () => {
    expect(apply(SRC, { op: "deleteRow", row: "Enable" })).toBe(SRC.replace("      Enable : Bool;   // run request\n", ""));
  });
  it("removes a struct with its members, and a member", () => {
    expect(apply(SRC, { op: "deleteRow", row: "Fb" })).toBe(SRC.replace("      Fb : Struct\n         a : Int;\n         b : Bool;\n      END_STRUCT;\n", ""));
    expect(apply(SRC, { op: "deleteRow", row: "Fb/a" })).toBe(SRC.replace("         a : Int;\n", ""));
  });
  it("keeps the section when its last declaration goes, and CRLF", () => {
    const crlf = SRC.replace(/\n/g, "\r\n");
    expect(apply(crlf, { op: "deleteRow", row: "Enable" })).toBe(crlf.replace("      Enable : Bool;   // run request\r\n", ""));
  });
  it("on a line with another declaration removes only its own text", () => {
    const two = SRC.replace("      Delay : Time;\n", "      Delay : Time; Other : Int;\n");
    expect(apply(two, { op: "deleteRow", row: "Delay" })).toBe(SRC.replace("      Delay : Time;\n", "      Other : Int;\n"));
    expect(apply(two, { op: "deleteRow", row: "Other" })).toBe(SRC);
  });
});
