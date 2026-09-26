// SPDX-License-Identifier: BUSL-1.1
// Error-tolerant structural parser for Siemens SCL sources (.scl, .db, .udt, and the interface of .awl).
// It builds what editor features need: blocks, interfaces, regions, references and structural diagnostics.
import { lex, type LexError, type Token } from "./lexer.js";

export type BlockKind = "FB" | "FC" | "OB" | "DB" | "UDT";
export type Section = "Input" | "Output" | "InOut" | "Static" | "Temp" | "Constant" | "Return" | "Member";

export interface VarDecl {
  name: string;
  start: number;
  end: number;
  section: Section;
  /** Type as written, e.g. `Bool`, `"Fx_Types"`, `Array[0..9] of Int`, `Struct`. */
  type: string;
  /** Named type this variable refers to: quoted name without quotes, or an identifier (TON_TIME). */
  typeRef?: string;
  isArray: boolean;
  members?: VarDecl[];
  init?: string;
  comment?: string;
}

export interface Ref {
  kind: "local" | "global" | "call";
  /** Name without # or quotes. */
  name: string;
  start: number;
  end: number;
  /** Member accesses after the name, each with its own range. */
  members: { name: string; start: number; end: number }[];
  /** How the statement uses it: assigned (`x :=`, `=> x`), called (`x(...)`) or read. */
  access: "read" | "write" | "call";
}

export interface Region {
  name: string;
  start: number;
  end: number;
}

export interface BlockModel {
  kind: BlockKind;
  name: string;
  nameStart: number;
  nameEnd: number;
  start: number;
  end: number;
  returnType?: string;
  vars: VarDecl[];
  /** DATA_BLOCK "X" of type "UDT"/"FB" (instance or typed DB). */
  dbOf?: string;
  regions: Region[];
  refs: Ref[];
  bodyStart?: number;
  comment?: string;
}

export interface ParseDiagnostic {
  message: string;
  start: number;
  end: number;
  severity: "error" | "warning";
}

export interface ParsedDocument {
  blocks: BlockModel[];
  diagnostics: ParseDiagnostic[];
  tokens: Token[];
}

const HEADERS: Record<string, { kind: BlockKind; end: string }> = {
  FUNCTION_BLOCK: { kind: "FB", end: "END_FUNCTION_BLOCK" },
  FUNCTION: { kind: "FC", end: "END_FUNCTION" },
  ORGANIZATION_BLOCK: { kind: "OB", end: "END_ORGANIZATION_BLOCK" },
  DATA_BLOCK: { kind: "DB", end: "END_DATA_BLOCK" },
  TYPE: { kind: "UDT", end: "END_TYPE" },
};

const SECTIONS: Record<string, Section> = {
  VAR_INPUT: "Input",
  VAR_OUTPUT: "Output",
  VAR_IN_OUT: "InOut",
  VAR: "Static",
  VAR_STAT: "Static",
  VAR_TEMP: "Temp",
};

/** Opening keyword → closing keyword for statements checked in bodies. */
const NESTING: Record<string, string> = { IF: "END_IF", CASE: "END_CASE", FOR: "END_FOR", WHILE: "END_WHILE", REPEAT: "END_REPEAT", REGION: "END_REGION" };
const CLOSERS = new Set(Object.values(NESTING));

export const unquote = (t: string) => (t.startsWith("#") ? t.slice(1) : t).replace(/^"|"$/g, "");

export function parse(src: string): ParsedDocument {
  const { tokens: all, errors } = lex(src);
  const tokens = all.filter((t) => t.kind !== "comment");
  const comments = all.filter((t) => t.kind === "comment");
  const diagnostics: ParseDiagnostic[] = errors.map((e: LexError) => ({ ...e, severity: "error" as const }));
  const blocks: BlockModel[] = [];
  let i = 0;
  const peek = (k = 0) => tokens[Math.min(i + k, tokens.length - 1)]!;
  const next = () => tokens[Math.min(i++, tokens.length - 1)]!;
  const isKw = (t: Token, ...kw: string[]) => t.kind === "ident" && kw.includes(t.upper);
  const err = (message: string, t: Token, severity: "error" | "warning" = "error") => diagnostics.push({ message, start: t.start, end: Math.max(t.end, t.start + 1), severity });
  /** Trailing // comment on the same line as offset. */
  const lineComment = (offset: number): string | undefined => {
    const eol = src.indexOf("\n", offset);
    const lineEnd = eol < 0 ? src.length : eol;
    const c = comments.find((c) => c.start >= offset && c.start < lineEnd);
    return c ? c.text.replace(/^\/\/\s?|^\(\*\s?|\s?\*\)$|^\/\*\s?|\s?\*\/$/g, "").trim() : undefined;
  };
  /** Skips tokens up to and including the next ';' (or until a stop keyword). */
  const skipStatement = (...stop: string[]) => {
    while (peek().kind !== "eof" && !(peek().kind === "op" && peek().text === ";") && !isKw(peek(), ...stop)) next();
    if (peek().text === ";") next();
  };

  function parseType(): { type: string; typeRef?: string; isArray: boolean; members?: VarDecl[] } {
    const t = peek();
    if (isKw(t, "ARRAY")) {
      const startOff = t.start;
      next();
      if (peek().text === "[") {
        let depth = 0;
        do {
          const x = next();
          if (x.text === "[") depth++;
          else if (x.text === "]") depth--;
        } while (depth > 0 && peek().kind !== "eof");
      }
      if (isKw(peek(), "OF")) next();
      const inner = parseType();
      return { type: src.slice(startOff, tokens[i - 1]!.end), typeRef: inner.typeRef, isArray: true, members: inner.members };
    }
    if (isKw(t, "STRUCT")) {
      next();
      const members = parseDecls("Member", "END_STRUCT");
      if (isKw(peek(), "END_STRUCT")) next();
      else err("Missing END_STRUCT", peek());
      return { type: "Struct", isArray: false, members };
    }
    if (t.kind === "global") {
      next();
      return { type: t.text, typeRef: unquote(t.text), isArray: false };
    }
    if (t.kind === "ident") {
      next();
      let type = t.text;
      // String[20], WString[..]
      if (peek().text === "[") {
        while (peek().kind !== "eof" && peek().text !== "]") next();
        type = src.slice(t.start, next().end);
      }
      return { type, typeRef: t.text, isArray: false };
    }
    err("Expected a data type", t);
    return { type: "?", isArray: false };
  }

  function parseDecls(section: Section, ...stop: string[]): VarDecl[] {
    const vars: VarDecl[] = [];
    let local = section;
    while (peek().kind !== "eof" && !isKw(peek(), ...stop, "END_VAR", "BEGIN", ...Object.values(HEADERS).map((h) => h.end))) {
      const t = peek();
      if (isKw(t, "CONSTANT")) {
        next();
        local = "Constant";
        continue;
      }
      if (isKw(t, "RETAIN", "NON_RETAIN", "DB_SPECIFIC")) {
        next();
        continue;
      }
      if (t.kind !== "ident" && t.kind !== "global") {
        err("Expected a variable name", t);
        skipStatement(...stop, "END_VAR");
        continue;
      }
      next();
      while (peek().kind === "pragma") next();
      if (isKw(peek(), "AT")) {
        next();
        next(); // overlaid variable
      }
      if (peek().text !== ":") {
        err(`Expected ':' after ${t.text}`, peek());
        skipStatement(...stop, "END_VAR");
        continue;
      }
      next();
      const ty = parseType();
      let init: string | undefined;
      if (peek().text === ":=") {
        next();
        const s = peek().start;
        while (peek().kind !== "eof" && peek().text !== ";" && !isKw(peek(), "END_VAR", "END_STRUCT")) next();
        init = src.slice(s, tokens[i - 1]!.end);
      }
      const semi = peek();
      if (semi.text === ";") next();
      else err("Missing ';'", semi);
      vars.push({ name: unquote(t.text), start: t.start, end: t.end, section: local, ...ty, ...(init !== undefined ? { init } : {}), ...(lineComment(t.end) ? { comment: lineComment(t.end)! } : {}) });
    }
    return vars;
  }

  function collectRef(t: Token, block: BlockModel, prev?: Token) {
    const kind: Ref["kind"] = t.kind === "local" ? "local" : t.kind === "global" ? "global" : "call";
    const ref: Ref = { kind, name: unquote(t.text), start: t.start, end: t.end, members: [], access: "read" };
    for (;;) {
      if (peek().text === "[") {
        let depth = 0;
        do {
          const x = next();
          if (x.text === "[") depth++;
          else if (x.text === "]") depth--;
          else if (x.kind === "local" || x.kind === "global") collectRef(x, block, x);
        } while (depth > 0 && peek().kind !== "eof");
        continue;
      }
      if (peek().text === "." && (peek(1).kind === "ident" || peek(1).kind === "global" || peek(1).kind === "local")) {
        next();
        const m = next();
        ref.members.push({ name: unquote(m.text), start: m.start, end: m.end });
        continue;
      }
      break;
    }
    if (peek().text === "(") ref.access = "call";
    else if (peek().text === ":=" || prev?.text === "=>") ref.access = "write";
    block.refs.push(ref);
  }

  function parseBody(block: BlockModel, endKw: string) {
    const stack: { kw: string; tok: Token }[] = [];
    let parens = 0;
    while (peek().kind !== "eof" && !isKw(peek(), endKw)) {
      const t = next();
      if (t.kind === "local" || t.kind === "global") {
        collectRef(t, block, tokens[i - 2]);
        continue;
      }
      if (t.kind === "op") {
        if (t.text === "(") parens++;
        else if (t.text === ")") {
          if (--parens < 0) {
            err("Unbalanced ')'", t);
            parens = 0;
          }
        } else if (t.text === ";" && parens > 0) {
          err("Missing ')'", t);
          parens = 0;
        }
        continue;
      }
      if (t.kind !== "ident") continue;
      if (peek().text === "(" && !NESTING[t.upper] && !CLOSERS.has(t.upper)) {
        block.refs.push({ kind: "call", name: t.text, start: t.start, end: t.end, members: [], access: "call" });
        continue;
      }
      if (block.kind === "DB" && peek().text === ":=") {
        // DB start values: `Counter := 0;` refers to the DB's own variables
        block.refs.push({ kind: "local", name: t.text, start: t.start, end: t.end, members: [], access: "write" });
        continue;
      }
      if (t.upper === "REGION") {
        const eol = src.indexOf("\n", t.end);
        const name = src.slice(t.end, eol < 0 ? src.length : eol).trim();
        stack.push({ kw: "REGION", tok: t });
        block.regions.push({ name, start: t.start, end: t.end });
        while (peek().kind !== "eof" && peek().start < (eol < 0 ? src.length : eol)) next();
        continue;
      }
      if (NESTING[t.upper]) {
        // "END_IF" etc. are separate tokens; FOR/WHILE bodies close with END_FOR/END_WHILE
        stack.push({ kw: t.upper, tok: t });
        continue;
      }
      if (CLOSERS.has(t.upper)) {
        const top = stack.pop();
        if (!top) err(`${t.text} without matching opening statement`, t);
        else if (NESTING[top.kw] !== t.upper) {
          err(`Expected ${NESTING[top.kw]} (for ${top.kw} at offset ${top.tok.start}) but found ${t.text}`, t);
        } else if (top.kw === "REGION") {
          const r = [...block.regions].reverse().find((x) => x.start === top.tok.start);
          if (r) r.end = t.end;
        }
      }
    }
    for (const open of stack) err(`${open.kw} is not closed (missing ${NESTING[open.kw]})`, open.tok);
    if (parens > 0) err("Missing ')'", peek());
  }

  while (peek().kind !== "eof") {
    const t = next();
    const h = t.kind === "ident" ? HEADERS[t.upper] : undefined;
    if (!h) {
      if (t.kind !== "pragma") err(`Expected FUNCTION_BLOCK, FUNCTION, ORGANIZATION_BLOCK, DATA_BLOCK or TYPE, found ${t.text}`, t);
      // resynchronize at the next header
      while (peek().kind !== "eof" && !(peek().kind === "ident" && HEADERS[peek().upper])) next();
      continue;
    }
    const nameTok = next();
    if (nameTok.kind !== "global" && nameTok.kind !== "ident") err("Expected a block name", nameTok);
    const block: BlockModel = { kind: h.kind, name: unquote(nameTok.text), nameStart: nameTok.start, nameEnd: nameTok.end, start: t.start, end: t.end, vars: [], regions: [], refs: [] };
    const c = lineComment(nameTok.end);
    if (c) block.comment = c;
    if (h.kind === "FC" && peek().text === ":") {
      next();
      block.returnType = parseType().type;
    }
    while (peek().kind !== "eof" && !isKw(peek(), h.end)) {
      const x = peek();
      if (x.kind === "pragma") {
        next();
        continue;
      }
      if (isKw(x, "TITLE", "AUTHOR", "FAMILY", "NAME", "VERSION")) {
        // header attributes run to the end of the line
        const eol = src.indexOf("\n", x.end);
        while (peek().kind !== "eof" && peek().start < (eol < 0 ? src.length : eol)) next();
        continue;
      }
      if (isKw(x, "NON_RETAIN", "KNOW_HOW_PROTECT", "READ_ONLY", "UNLINKED", "S7_OPTIMIZED_ACCESS")) {
        next();
        continue;
      }
      if (x.kind === "ident" && SECTIONS[x.upper]) {
        next();
        block.vars.push(...parseDecls(SECTIONS[x.upper]!));
        if (isKw(peek(), "END_VAR")) next();
        else err("Missing END_VAR", peek());
        continue;
      }
      if (isKw(x, "STRUCT") && h.kind === "UDT") {
        const ty = parseType();
        block.vars.push(...(ty.members ?? []));
        if (peek().text === ";") next();
        continue;
      }
      if (x.kind === "global" && h.kind === "DB") {
        next();
        block.dbOf = unquote(x.text);
        continue;
      }
      if (isKw(x, "BEGIN")) {
        next();
        block.bodyStart = x.end;
        parseBody(block, h.end);
        continue;
      }
      err(`Unexpected ${x.text}`, x);
      next();
    }
    if (isKw(peek(), h.end)) block.end = next().end;
    else {
      err(`Missing ${h.end}`, t);
      block.end = src.length;
    }
    blocks.push(block);
  }
  return { blocks, diagnostics, tokens: all };
}
