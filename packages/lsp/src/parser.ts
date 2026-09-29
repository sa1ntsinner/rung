// SPDX-License-Identifier: BUSL-1.1
// Error-tolerant structural parser for Siemens SCL sources (.scl, .db, .udt, and the interface of .awl).
// It builds what editor features need: blocks, interfaces, regions, references and structural diagnostics.
import { lex, type LexError, type Token } from "./lexer.js";

export type BlockKind = "FB" | "FC" | "OB" | "DB" | "UDT" | "PRG" | "GVL";
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
  /** Address of a located variable (`x AT %I0.0 : Bool`). */
  at?: string;
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
  /** IEC METHOD: the function block it belongs to (the method body sees the FB's variables). */
  owner?: string;
  /** STL (.awl) body: not analysed, only the interface is indexed. */
  stl?: boolean;
  /** Read from a SimaticML (XML) export: interface only, the body is LAD/FBD/GRAPH or not present. */
  xml?: boolean;
  /** LAD block in SIMATIC SD text: its networks translated to SCL statements (for the simulator). */
  lad?: string;
  /** LAD elements the translation does not cover; the simulator refuses the block with this list. */
  ladUnsupported?: string[];
  /** IEC enumeration type: its values in order, and the default when it is not the first. */
  enumValues?: { name: string; value: number }[];
  enumDefault?: string;
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

/** IEC 61131-3 ST as used by TwinCAT/CODESYS: POUs without BEGIN, METHODs, programs, global variable lists. */
const HEADERS_IEC: Record<string, { kind: BlockKind; end: string }> = {
  FUNCTION_BLOCK: { kind: "FB", end: "END_FUNCTION_BLOCK" },
  FUNCTION: { kind: "FC", end: "END_FUNCTION" },
  PROGRAM: { kind: "PRG", end: "END_PROGRAM" },
  METHOD: { kind: "FC", end: "END_METHOD" },
  TYPE: { kind: "UDT", end: "END_TYPE" },
};

const KEYWORDS_IEC = new Set(["IF", "THEN", "ELSIF", "ELSE", "END_IF", "CASE", "OF", "END_CASE", "FOR", "TO", "BY", "DO", "END_FOR", "WHILE", "END_WHILE", "REPEAT", "UNTIL", "END_REPEAT", "EXIT", "CONTINUE", "RETURN", "AND", "OR", "XOR", "NOT", "MOD", "TRUE", "FALSE", "THIS", "SUPER", "AND_THEN", "OR_ELSE", "JMP"]);

const SECTIONS: Record<string, Section> = {
  VAR_INPUT: "Input",
  VAR_OUTPUT: "Output",
  VAR_IN_OUT: "InOut",
  VAR: "Static",
  VAR_STAT: "Static",
  VAR_TEMP: "Temp",
  VAR_INST: "Static",
  VAR_GLOBAL: "Static",
};

/** Opening keyword → closing keyword for statements checked in bodies. */
const NESTING: Record<string, string> = { IF: "END_IF", CASE: "END_CASE", FOR: "END_FOR", WHILE: "END_WHILE", REPEAT: "END_REPEAT", REGION: "END_REGION" };
const CLOSERS = new Set(Object.values(NESTING));

export const unquote = (t: string) => (t.startsWith("#") ? t.slice(1) : t).replace(/^"|"$/g, "");

export interface ParseOptions {
  /** `stl`: SCL-style header and interface with an STL body (.awl) that is skipped. */
  dialect?: "scl" | "iec" | "stl";
  /** Name for a header-less global variable list (TwinCAT GVL). */
  unitName?: string;
}

export function parse(src: string, opts: ParseOptions = {}): ParsedDocument {
  const iec = opts.dialect === "iec";
  const headers = iec ? HEADERS_IEC : HEADERS;
  /** IEC POU/METHOD headers start a line; used to end header-less blocks. */
  const isHeaderAt = (tok: Token) => {
    if (tok.kind !== "ident" || !headers[tok.upper]) return false;
    const lineStart = src.lastIndexOf("\n", tok.start - 1) + 1;
    return /^\s*$/.test(src.slice(lineStart, tok.start));
  };
  const { tokens: all, errors } = lex(src, { nestedComments: iec });
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
    if (isKw(t, "REF_TO") || (isKw(t, "POINTER", "REFERENCE") && isKw(peek(1), "TO"))) {
      // REF_TO Int, POINTER TO INT, REFERENCE TO ST_X
      next();
      if (isKw(peek(), "TO")) next();
      const inner = parseType();
      return { type: src.slice(t.start, tokens[i - 1]!.end), ...(inner.typeRef ? { typeRef: inner.typeRef } : {}), isArray: inner.isArray, ...(inner.members ? { members: inner.members } : {}) };
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
      let at: string | undefined;
      if (isKw(peek(), "AT")) {
        next();
        at = next().text; // %I0.0, %IX0.1, %Q* (located variable)
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
      vars.push({ name: unquote(t.text), start: t.start, end: t.end, section: local, ...ty, ...(at ? { at } : {}), ...(init !== undefined ? { init } : {}), ...(lineComment(t.end) ? { comment: lineComment(t.end)! } : {}) });
    }
    return vars;
  }

  function collectRef(t: Token, block: BlockModel, prev?: Token, as?: "local" | "global") {
    const kind: Ref["kind"] = as ?? (t.kind === "local" ? "local" : t.kind === "global" ? "global" : "call");
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
    else if (peek().text === ":=" || peek().text === "?=" || prev?.text === "=>") ref.access = "write";
    else if (["+", "-", "*", "/"].includes(peek().text) && peek(1).text === "=" && peek(1).start === peek().end) ref.access = "write"; // x += 1
    block.refs.push(ref);
  }

  /** Text after REGION / END_REGION up to the end of the line is a free-form name, not code. */
  const freeText: [number, number][] = [];
  function skipLine(t: Token) {
    const eol = src.indexOf("\n", t.end);
    const stop = eol < 0 ? src.length : eol;
    freeText.push([t.end, stop]);
    while (peek().kind !== "eof" && peek().start < stop) next();
  }

  /** Variables of the FB that owns the METHOD being parsed. */
  let ownerVars: VarDecl[] | undefined;

  function parseBody(block: BlockModel, endKw: string) {
    const stack: { kw: string; tok: Token }[] = [];
    let parens = 0;
    while (peek().kind !== "eof" && !isKw(peek(), endKw) && !(iec && isHeaderAt(peek()))) {
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
      if (iec && parens > 0 && (peek().text === ":=" || peek().text === "=>")) continue; // named call argument
      if (iec && /^(S|R|REF)$/.test(t.upper) && src[t.end] === "=" && peek().text === "=") continue; // x S= cond; x R= cond; p REF= x;
      if (iec && !KEYWORDS_IEC.has(t.upper) && tokens[i - 2]?.text !== ".") {
        // plain identifiers are locals when declared in the POU (or the FB owning a METHOD), otherwise globals
        const declared = block.vars.some((v) => v.name.toUpperCase() === t.upper) || t.upper === block.name.toUpperCase() || !!ownerVars?.some((v) => v.name.toUpperCase() === t.upper);
        collectRef(t, block, tokens[i - 2], declared ? "local" : "global");
        continue;
      }
      if (block.kind === "DB" && (tokens[i - 2]?.text === ";" || isKw(tokens[i - 2]!, "BEGIN"))) {
        // DB start values: `Counter := 0;`, `Plug.Delay := S5T#1s;`, `T1.PT := T#2s;` refer to the DB's own
        // variables (or the interface of the FB/UDT for instance and typed DBs)
        collectRef(t, block, undefined, "local");
        const r = block.refs[block.refs.length - 1]!;
        if (peek().text === ":=") r.access = "write";
        continue;
      }
      if (t.upper === "REGION") {
        const eol = src.indexOf("\n", t.end);
        const name = src.slice(t.end, eol < 0 ? src.length : eol).trim();
        stack.push({ kw: "REGION", tok: t });
        block.regions.push({ name, start: t.start, end: t.end });
        skipLine(t);
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
        if (t.upper === "END_REGION") skipLine(t); // END_REGION <name>
      }
    }
    for (const open of stack) err(`${open.kw} is not closed (missing ${NESTING[open.kw]})`, open.tok);
    if (parens > 0) err("Missing ')'", peek());
  }

  while (peek().kind !== "eof") {
    const t = next();
    if (iec && t.kind === "ident" && t.upper === "VAR_GLOBAL") {
      // TwinCAT GVL: a header-less VAR_GLOBAL list named after its file; several sections form one list
      const name = opts.unitName ?? "GVL";
      const existing = blocks.find((b) => b.kind === "GVL" && b.name === name);
      const gvl: BlockModel = existing ?? { kind: "GVL", name, nameStart: t.start, nameEnd: t.end, start: t.start, end: t.end, vars: [], regions: [], refs: [] };
      let section: Section = "Static";
      while (peek().kind !== "eof" && isKw(peek(), "CONSTANT", "RETAIN", "PERSISTENT")) if (next().upper === "CONSTANT") section = "Constant";
      gvl.vars.push(...parseDecls(section));
      if (isKw(peek(), "END_VAR")) gvl.end = next().end;
      if (!existing) blocks.push(gvl);
      continue;
    }
    const h = t.kind === "ident" ? headers[t.upper] : undefined;
    if (!h) {
      if (t.kind !== "pragma") err(`Expected ${iec ? "FUNCTION_BLOCK, FUNCTION, PROGRAM, METHOD or TYPE" : "FUNCTION_BLOCK, FUNCTION, ORGANIZATION_BLOCK, DATA_BLOCK or TYPE"}, found ${t.text}`, t);
      // resynchronize at the next header
      while (peek().kind !== "eof" && !(peek().kind === "ident" && (headers[peek().upper] || (iec && peek().upper === "VAR_GLOBAL")))) next();
      continue;
    }
    const nameTok = next();
    if (nameTok.kind !== "global" && nameTok.kind !== "ident") err("Expected a block name", nameTok);
    const block: BlockModel = { kind: h.kind, name: unquote(nameTok.text), nameStart: nameTok.start, nameEnd: nameTok.end, start: t.start, end: t.end, vars: [], regions: [], refs: [] };
    ownerVars = undefined;
    if (iec && t.upper === "METHOD") {
      const owner = [...blocks].reverse().find((b) => b.kind === "FB" || b.kind === "PRG");
      if (owner) {
        block.owner = owner.name;
        ownerVars = owner.vars;
      }
    }
    const c = lineComment(nameTok.end);
    if (c) block.comment = c;
    if (iec) while (peek().kind === "ident" && /^(ABSTRACT|FINAL|PUBLIC|PRIVATE|PROTECTED|INTERNAL)$/.test(peek().upper)) next();
    if (h.kind === "FC" && peek().text === ":") {
      next();
      block.returnType = parseType().type;
    }
    if (iec && h.kind === "UDT" && peek().text === ":") next(); // TYPE ST_X : STRUCT ...
    if (iec && (isKw(peek(), "EXTENDS") || isKw(peek(), "IMPLEMENTS"))) {
      while (peek().kind !== "eof" && !(peek().kind === "ident" && (SECTIONS[peek().upper] || headers[peek().upper])) && peek().kind !== "pragma" && !/^(VAR|END_)/.test(peek().upper)) next();
    }
    while (peek().kind !== "eof" && !isKw(peek(), h.end) && !(iec && isHeaderAt(peek()))) {
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
      if (iec && h.kind === "UDT" && x.text === "(") {
        // enumeration: TYPE E_X : (A, B := 2, C) INT := A; END_TYPE; values count on from the last given one
        next();
        const values: { name: string; value: number }[] = [];
        let n = 0;
        while (peek().kind === "ident") {
          const id = next();
          if (peek().text === ":=") {
            next();
            const neg = peek().text === "-" ? (next(), -1) : 1;
            const lit = next().text.replace(/_/g, "");
            const based = /^(2|8|16)#(.+)$/.exec(lit.replace(/^[A-Za-z]+#/, ""));
            n = neg * (based ? parseInt(based[2]!, Number(based[1])) : Number(lit.replace(/^[A-Za-z]+#/, "")));
          }
          values.push({ name: id.text, value: n++ });
          if (peek().text === ",") next();
        }
        block.enumValues = values;
        while (peek().kind !== "eof" && !isKw(peek(), h.end)) {
          // a default after the base type: (A, B) INT := B;
          if (next().text === ":=" && peek().kind === "ident") block.enumDefault = next().text;
        }
        continue;
      }
      if (isKw(x, "STRUCT") && (h.kind === "UDT" || h.kind === "DB")) {
        // UDT, or a standard-access DB declared as STRUCT ... END_STRUCT
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
        if (opts.dialect === "stl" || isKw(peek(), "NETWORK")) {
          // STL body: skip it (the interface above is what editors and other blocks need)
          block.stl = true;
          while (peek().kind !== "eof" && !isKw(peek(), h.end)) next();
          continue;
        }
        parseBody(block, h.end);
        continue;
      }
      if (iec && h.kind !== "UDT") {
        // IEC POUs have no BEGIN: the body starts after the declarations
        block.bodyStart = x.start;
        parseBody(block, h.end);
        continue;
      }
      err(`Unexpected ${x.text}`, x);
      next();
    }
    if (isKw(peek(), h.end)) block.end = next().end;
    else if (iec) block.end = peek().kind === "eof" ? src.length : peek().start;
    else {
      err(`Missing ${h.end}`, t);
      block.end = src.length;
    }
    blocks.push(block);
  }
  // STL bodies are not SCL: drop lexer complaints about them
  const stl = blocks.filter((b) => b.stl);
  const kept = diagnostics.filter((d) => !stl.some((b) => d.start >= b.bodyStart! && d.start < b.end) && !freeText.some(([a, b]) => d.start >= a && d.start < b));
  return { blocks, diagnostics: kept, tokens: all };
}
