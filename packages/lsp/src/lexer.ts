// SPDX-License-Identifier: BUSL-1.1
// Error-tolerant lexer for Siemens SCL (and the declaration part of STL sources).
// Offsets are JavaScript string indices, i.e. UTF-16 code units, which is what LSP positions use.

export type TokenKind =
  | "ident" // plain identifier or keyword (see `upper`)
  | "local" // #name
  | "global" // "Name"
  | "string" // 'text'
  | "number" // 12, 1.5e3, 16#FF, T#1s, DINT#5, ...
  | "absolute" // %I0.0, %DB1.DBX0.0, %MW10
  | "op" // := => <= >= <> ** .. and single-character operators/punctuation
  | "pragma" // { ... } attribute list
  | "comment"
  | "eof";

export interface Token {
  kind: TokenKind;
  text: string;
  /** Upper-cased text for identifiers (SCL keywords and identifiers are case-insensitive). */
  upper: string;
  start: number;
  end: number;
}

export interface LexError {
  message: string;
  start: number;
  end: number;
}

const IDENT_START = /[A-Za-z_À-￿]/;
const IDENT_PART = /[A-Za-z0-9_À-￿]/;
const TWO_CHAR = new Set([":=", "=>", "<=", ">=", "<>", "**", ".."]);
const SINGLE = new Set([...";:,.()[]+-*/=<>&^"]);
/** Prefixes that start typed literals: T#1s, DINT#5, 16#FF, LTIME#..., DTL#... */
const TYPED_PREFIX = /^(?:[0-9]+|[A-Za-z_]+)$/;

export function lex(src: string): { tokens: Token[]; errors: LexError[] } {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  const n = src.length;
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number) => {
    const text = src.slice(start, end);
    tokens.push({ kind, text, upper: kind === "ident" ? text.toUpperCase() : text, start, end });
  };
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "﻿") {
      i++;
      continue;
    }
    const start = i;
    // comments
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      push("comment", start, i);
      continue;
    }
    if ((c === "(" && src[i + 1] === "*") || (c === "/" && src[i + 1] === "*")) {
      const close = c === "(" ? "*)" : "*/";
      const endAt = src.indexOf(close, i + 2);
      if (endAt < 0) {
        errors.push({ message: "Unterminated comment", start, end: n });
        i = n;
      } else i = endAt + 2;
      push("comment", start, i);
      continue;
    }
    if (c === "{") {
      // attribute pragma; may contain quoted strings with '}' inside
      i++;
      while (i < n && src[i] !== "}") {
        if (src[i] === "'") {
          i++;
          while (i < n && src[i] !== "'") i++;
        }
        i++;
      }
      if (i >= n) errors.push({ message: "Unterminated attribute list", start, end: n });
      else i++;
      push("pragma", start, Math.min(i, n));
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"' && src[i] !== "\n") i++;
      if (src[i] !== '"') errors.push({ message: "Unterminated quoted name", start, end: i });
      else i++;
      push("global", start, i);
      continue;
    }
    if (c === "'") {
      i++;
      for (;;) {
        if (i >= n || src[i] === "\n") {
          errors.push({ message: "Unterminated string", start, end: i });
          break;
        }
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (src[i] === "$") i++; // $' $$ $N ... escapes
        i++;
      }
      push("string", start, i);
      continue;
    }
    if (c === "#") {
      i++;
      if (src[i] === '"') {
        // #"name with spaces"
        i++;
        while (i < n && src[i] !== '"' && src[i] !== "\n") i++;
        if (src[i] === '"') i++;
        else errors.push({ message: "Unterminated quoted name", start, end: i });
      } else while (i < n && IDENT_PART.test(src[i]!)) i++;
      if (i === start + 1) errors.push({ message: "Expected a name after #", start, end: i });
      push("local", start, i);
      continue;
    }
    if (c === "%") {
      i++;
      while (i < n && /[A-Za-z0-9_.]/.test(src[i]!)) i++;
      push("absolute", start, i);
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[0-9_]/.test(src[i]!)) i++;
      if (src[i] === "#") {
        typed();
        continue;
      }
      if (src[i] === "." && /[0-9]/.test(src[i + 1] ?? "")) {
        i++;
        while (i < n && /[0-9_]/.test(src[i]!)) i++;
      }
      if (/[eE]/.test(src[i] ?? "") && /[-+0-9]/.test(src[i + 1] ?? "")) {
        i += 2;
        while (i < n && /[0-9]/.test(src[i]!)) i++;
      }
      push("number", start, i);
      continue;
    }
    if (IDENT_START.test(c)) {
      while (i < n && IDENT_PART.test(src[i]!)) i++;
      if (src[i] === "#" && TYPED_PREFIX.test(src.slice(start, i))) {
        typed();
        continue;
      }
      push("ident", start, i);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      i += 2;
      push("op", start, i);
      continue;
    }
    if (SINGLE.has(c)) {
      i++;
      push("op", start, i);
      continue;
    }
    errors.push({ message: `Unexpected character ${JSON.stringify(c)}`, start, end: i + 1 });
    i++;

    function typed(): void {
      // consume "#" and the literal value: digits, letters, '_', '.', ':', '-' (dates, times, hex)
      i++;
      if (src[i] === "-" || src[i] === "+") i++;
      while (i < n && /[A-Za-z0-9_.:\-+]/.test(src[i]!)) {
        // stop before '..' ranges and before ':=' assignments
        if (src[i] === "." && src[i + 1] === ".") break;
        if (src[i] === ":" && src[i + 1] === "=") break;
        i++;
      }
      push("number", start, i);
    }
  }
  tokens.push({ kind: "eof", text: "", upper: "", start: n, end: n });
  return { tokens, errors };
}

/** Converts string offsets to LSP line/character positions (UTF-16), honouring CRLF. */
export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") this.starts.push(i + 1);
  }
  position(offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    let character = offset - this.starts[lo]!;
    // a position between \r and \n belongs to the end of the line
    if (character > 0 && this.text[offset - 1] === "\r" && this.text[offset] === "\n") character--;
    return { line: lo, character };
  }
  offset(line: number, character: number): number {
    const start = this.starts[Math.min(line, this.starts.length - 1)] ?? 0;
    const next = this.starts[line + 1] ?? this.text.length + 1;
    let end = next - 1;
    if (this.text[end - 1] === "\r") end--;
    return Math.min(start + character, Math.max(start, end));
  }
}
