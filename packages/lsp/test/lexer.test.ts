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
