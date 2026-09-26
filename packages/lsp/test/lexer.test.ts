// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { lex, LineIndex } from "../src/lexer.js";

const kinds = (s: string) => lex(s).tokens.filter((t) => t.kind !== "eof").map((t) => [t.kind, t.text]);

describe("lex", () => {
  it("tokenizes locals, globals, members and assignments", () => {
    expect(kinds('#Latch := "Fx_Global".Station.Enabled;')).toEqual([
      ["local", "#Latch"],
      ["op", ":="],
      ["global", '"Fx_Global"'],
      ["op", "."],
      ["ident", "Station"],
      ["op", "."],
      ["ident", "Enabled"],
      ["op", ";"],
    ]);
  });

  it("keeps keyword case in text but offers an upper-cased form", () => {
    const t = lex("end_if").tokens[0]!;
    expect([t.kind, t.text, t.upper]).toEqual(["ident", "end_if", "END_IF"]);
  });

  it("recognizes typed literals, hex and times, and stops before ranges", () => {
    expect(kinds("T#1s 16#FF DINT#-5 LTIME#1d2h TOD#12:30:00 1.5e3 Array[0..9]")).toEqual([
      ["number", "T#1s"],
      ["number", "16#FF"],
      ["number", "DINT#-5"],
      ["number", "LTIME#1d2h"],
      ["number", "TOD#12:30:00"],
      ["number", "1.5e3"],
      ["ident", "Array"],
      ["op", "["],
      ["number", "0"],
      ["op", ".."],
      ["number", "9"],
      ["op", "]"],
    ]);
  });

  it("recognizes typed bit-string, based, S5TIME, string and date/time literals (QA-14)", () => {
    const lits = ["WORD#16#00FF", "W#16#FF", "BYTE#16#0F", "DWORD#16#DEAD_BEEF", "LWORD#16#1", "DW#16#0", "INT#2#1010", "DINT#-5", "S5T#1s", "S5TIME#10ms", "WSTRING#'x y'", "STRING#'it''s'", "CHAR#'a'", "WCHAR#'a'", "DATE#2024-01-31", "D#2024-01-31", "TOD#12:30:00.5", "LTOD#1:2:3", "DT#2024-01-31-12:30:00", "LDT#2024-01-31-12:30:00.000", "LTIME#1d2h3m", "REAL#1.5E-3", "BOOL#TRUE"];
    for (const l of lits) expect(kinds(`${l};`), l).toEqual([[l.includes("'") ? "string" : "number", l], ["op", ";"]]);
  });

  it("ends hex and typed CASE labels before the colon (QA-14)", () => {
    expect(kinds("16#8201: WORD#16#FF: 5:")).toEqual([
      ["number", "16#8201"],
      ["op", ":"],
      ["number", "WORD#16#FF"],
      ["op", ":"],
      ["number", "5"],
      ["op", ":"],
    ]);
    expect(kinds("TOD#12:30:00:=")[0]).toEqual(["number", "TOD#12:30:00"]);
  });

  it("lexes IEC wildcard addresses and nested comments in IEC mode (QA-23)", () => {
    expect(kinds("x AT %I* : BOOL; %MW10*2")).toEqual([
      ["ident", "x"],
      ["ident", "AT"],
      ["absolute", "%I*"],
      ["op", ":"],
      ["ident", "BOOL"],
      ["op", ";"],
      ["absolute", "%MW10"],
      ["op", "*"],
      ["number", "2"],
    ]);
    const nested = "(* a (* b *) c *) x";
    expect(lex(nested, { nestedComments: true }).tokens.map((t) => [t.kind, t.text]).slice(0, 2)).toEqual([
      ["comment", "(* a (* b *) c *)"],
      ["ident", "x"],
    ]);
  });

  it("handles absolute addresses, pragmas, comments and strings with escapes", () => {
    expect(kinds("%I0.0 %DB1.DBX0.0 { S7_Optimized_Access := 'TRUE' } // c\n(* block *) /* c */ 'it''s $'ok$''")).toEqual([
      ["absolute", "%I0.0"],
      ["absolute", "%DB1.DBX0.0"],
      ["pragma", "{ S7_Optimized_Access := 'TRUE' }"],
      ["comment", "// c"],
      ["comment", "(* block *)"],
      ["comment", "/* c */"],
      ["string", "'it''s $'ok$''"],
    ]);
  });

  it("supports #\"quoted locals\" and non-ASCII identifiers", () => {
    expect(kinds('#"my var" := Überwachung;').slice(0, 3)).toEqual([
      ["local", '#"my var"'],
      ["op", ":="],
      ["ident", "Überwachung"],
    ]);
  });

  it("reports unterminated constructs without crashing", () => {
    for (const s of ['"open', "'open", "(* open", "{ open", "#", "x := @@@;"]) {
      const r = lex(s);
      expect(r.tokens.at(-1)!.kind).toBe("eof");
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it("never throws or hangs on random input", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const alphabet = `abcXYZ019 #"'%{}()*/:=<>.;,\n\r\tÜ😀$`;
    for (let k = 0; k < 300; k++) {
      let s = "";
      const len = Math.floor(rand() * 80);
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      const r = lex(s);
      expect(r.tokens.at(-1)!.kind).toBe("eof");
      for (const t of r.tokens) expect(t.end).toBeGreaterThanOrEqual(t.start);
    }
  });
});

describe("LineIndex", () => {
  it("maps offsets to UTF-16 positions across CRLF and emoji", () => {
    const text = "a😀b\r\nsecond";
    const li = new LineIndex(text);
    expect(li.position(text.indexOf("b"))).toEqual({ line: 0, character: 3 }); // 😀 is 2 UTF-16 units
    expect(li.position(text.indexOf("s"))).toEqual({ line: 1, character: 0 });
    expect(li.offset(1, 2)).toBe(text.indexOf("c"));
    expect(li.offset(0, 99)).toBe(4); // clamped before \r
  });
});
