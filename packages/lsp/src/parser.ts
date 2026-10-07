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
  /** A local of one accessor of an IEC PROPERTY: visible only in its GET or its SET. */
  accessor?: "get" | "set";
  /** Exact source spans, for editors that change one field without touching the rest. */
  src?: DeclSource;
}

export interface Span {
  start: number;
  end: number;
}

/** Where each part of a declaration stands in the source (offsets into the parsed text). */
export interface DeclSource {
  /** name start .. end of the closing ';' (for a Struct: through END_STRUCT and its ';') */
  whole: Span;
  /** the name as written, quotes included ("30msPls") */
  name: Span;
  /** the { … } attribute pragma between name and ':', braces included */
  attrs?: Span;
  /** the type as written; for a Struct only its STRUCT keyword */
  type: Span;
  /** the start value after ':=' */
  init?: Span;
  /** the // comment token on the name's line */
  comment?: Span;
}

/** A VAR … END_VAR section of a block as written. */
export interface SectionSource {
  section: Section;
  /** the header keyword as written: VAR, VAR_INPUT, … */
  keyword: string;
  /** RETAIN, NON_RETAIN, DB_SPECIFIC, CONSTANT, in source order */
  modifiers: string[];
  /** header keyword .. END_VAR end */
  whole: Span;
  /** header keyword .. end of its last modifier */
  header: Span;
  /** after the header .. start of END_VAR: where new declarations go */
  body: Span;
}

/** The accessor of a PROPERTY block whose code holds `offset`, if any. */
export function accessorAt(block: BlockModel, offset: number): "get" | "set" | undefined {
  const p = block.property;
  if (p?.get && offset >= p.get.start && offset <= p.get.end) return "get";
  if (p?.set && offset >= p.set.start && offset <= p.set.end) return "set";
  return undefined;
}

/** The variables of a block that code at `offset` sees (a PROPERTY's accessor sees its own locals, not the other's). */
export function varsAt(block: BlockModel, offset?: number): VarDecl[] {
  if (!block.property) return block.vars;
  const acc = offset === undefined ? undefined : accessorAt(block, offset);
  return block.vars.filter((v) => !v.accessor || v.accessor === acc || (acc === undefined && offset === undefined));
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
  /** Its VAR … END_VAR sections as written. */
  sections?: SectionSource[];
  /** DATA_BLOCK "X" of type "UDT"/"FB" (instance or typed DB). */
  dbOf?: string;
  regions: Region[];
  refs: Ref[];
  bodyStart?: number;
  comment?: string;
  /** IEC METHOD, PROPERTY or ACTION: the function block it belongs to (its body sees the FB's variables). */
  owner?: string;
  /** IEC ACTION: code of its function block, with no declarations of its own. */
  action?: boolean;
  /** IEC PROPERTY: the code of its GET and SET accessors (offsets); the property's name is its value in both. */
  property?: { get?: { start: number; end: number }; set?: { start: number; end: number } };
  /** STL (.awl) body: not analysed, only the interface is indexed. */
  stl?: boolean;
  /** Read from a SimaticML (XML) export: interface only, the body is LAD/FBD/GRAPH or not present. */
  xml?: boolean;
  /** LAD block in SIMATIC SD text, or LAD/FBD in SimaticML: its networks translated to SCL statements (for the simulator). */
  lad?: string;
  /** Network elements the translation does not cover; the simulator refuses the block with this list. */
  ladUnsupported?: string[];
  /** Bool temporaries the translated networks use besides the block's own. */
  ladTemps?: string[];
  /** The STL networks of a SimaticML block as STL text (`lad` calls __RUNG_STL(i) where network `network` runs). */
  stlNetworks?: { source: string; network: number; last: boolean }[];
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
  PROPERTY: { kind: "FC", end: "END_PROPERTY" },
  ACTION: { kind: "FC", end: "END_ACTION" },
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
/** Keywords a parenthesis may follow that call nothing: NOT (a > b), ELSIF (x), UNTIL (y) */
const NO_CALL = new Set(["NOT", "AND", "OR", "XOR", "MOD", "ELSIF", "UNTIL", "TO", "BY", "THEN", "DO", "OF", "ELSE", "RETURN", "EXIT"]);

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
  const lineCommentToken = (offset: number): Token | undefined => {
    const eol = src.indexOf("\n", offset);
    const lineEnd = eol < 0 ? src.length : eol;
    return comments.find((c) => c.start >= offset && c.start < lineEnd);
  };
  const lineComment = (offset: number): string | undefined => {
    const c = lineCommentToken(offset);
    return c ? c.text.replace(/^\/\/\s?|^\(\*\s?|\s?\*\)$|^\/\*\s?|\s?\*\/$/g, "").trim() : undefined;
  };
  /**
   * The keyword at peek(k) is the name of a declaration (`Begin AT %M0.0 : Bool;`, `Retain : Bool;`): what follows
   * it, after attributes, is its ':' or AT. TIA tag names are free text, and a tag table as text holds them unquoted.
   */
  const declared = (k = 0) => {
    let j = k + 1;
    while (peek(j).kind === "pragma") j++;
    return peek(j).text === ":" || isKw(peek(j), "AT");
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

  /** The section modifiers (RETAIN, CONSTANT, …) the last parseDecls call read before its first declaration. */
  let lastModifiers: Token[] = [];

  function parseDecls(section: Section, ...stop: string[]): VarDecl[] {
    const vars: VarDecl[] = [];
    let local = section;
    const modifiers: Token[] = [];
    while (peek().kind !== "eof" && !(isKw(peek(), ...stop, "END_VAR", "BEGIN", ...Object.values(HEADERS).map((h) => h.end)) && !declared())) {
      const t = peek();
      if (isKw(t, "CONSTANT") && !declared()) {
        if (!vars.length) modifiers.push(t);
        next();
        local = "Constant";
        continue;
      }
      if (isKw(t, "RETAIN", "NON_RETAIN", "DB_SPECIFIC") && !declared()) {
        if (!vars.length) modifiers.push(t);
        next();
        continue;
      }
      if (t.kind !== "ident" && t.kind !== "global") {
        err("Expected a variable name", t);
        skipStatement(...stop, "END_VAR");
        continue;
      }
      next();
      let attrs: Span | undefined;
      while (peek().kind === "pragma") {
        const p = next();
        attrs ??= { start: p.start, end: p.end };
      }
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
      const typeStart = peek().start;
      const ty = parseType();
      // a Struct's type is its STRUCT keyword (Struct and STRUCT are both six letters)
      const typeEnd = ty.type === "Struct" ? typeStart + 6 : tokens[i - 1]!.end;
      let init: string | undefined;
      let initSpan: Span | undefined;
      if (peek().text === ":=") {
        next();
        const s = peek().start;
        const before = i;
        while (peek().kind !== "eof" && peek().text !== ";" && !isKw(peek(), "END_VAR", "END_STRUCT")) next();
        // `a : Int :=` with nothing typed yet has no start value to replace
        if (i > before) {
          init = src.slice(s, tokens[i - 1]!.end);
          initSpan = { start: s, end: tokens[i - 1]!.end };
        }
      }
      const semi = peek();
      let wholeEnd = tokens[i - 1]!.end;
      if (semi.text === ";") wholeEnd = next().end;
      else err("Missing ';'", semi);
      const ct = lineCommentToken(t.end);
      const decl: DeclSource = {
        whole: { start: t.start, end: wholeEnd },
        name: { start: t.start, end: t.end },
        type: { start: typeStart, end: typeEnd },
        ...(attrs ? { attrs } : {}),
        ...(initSpan ? { init: initSpan } : {}),
        // a // comment ends before the line's CR in a CRLF file
        ...(ct ? { comment: { start: ct.start, end: src[ct.end - 1] === "\r" ? ct.end - 1 : ct.end } } : {}),
      };
      vars.push({ name: unquote(t.text), start: t.start, end: t.end, section: local, ...ty, ...(at ? { at } : {}), ...(init !== undefined ? { init } : {}), ...(ct ? { comment: lineComment(t.end)! } : {}), src: decl });
    }
    // set last: a Struct inside parses its members with its own call
    lastModifiers = modifiers;
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
      // A bit/slice access belongs to the base variable, not a structure member. Consume it so writes
      // such as w.3 := FALSE and #w.%X3 := FALSE are recorded as writes of w.
      if (peek().text === "." && ((iec && peek(1).kind === "number" && /^\d+$/.test(peek(1).text)) || (peek(1).kind === "absolute" && /^%[XBWD]\d+$/i.test(peek(1).text)))) {
        next();
        next();
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

  /** A token a statement can end with: a value, a name, a closing bracket, END_IF and its kin (TIA Portal wants END_IF;). */
  const endsValue = (x: Token | undefined) =>
    !!x && (x.kind === "local" || x.kind === "global" || x.kind === "number" || x.kind === "string" || x.kind === "absolute" || x.text === ")" || x.text === "]" || isKw(x, "TRUE", "FALSE", "END_IF", "END_CASE", "END_FOR", "END_WHILE", "END_REPEAT"));
  const STATEMENT = new Set(["IF", "CASE", "FOR", "WHILE", "REPEAT", "RETURN", "EXIT", "CONTINUE", "REGION", "GOTO"]);
  const lineOf = (offset: number) => src.slice(0, offset).split("\n").length;
  /** An integer CASE label: 7, 16#FF, 2#1010, 1_000. */
  const intOf = (text: string): number | undefined => {
    const m = /^(?:(2|8|16)#)?([0-9A-F_]+)$/i.exec(text);
    const n = m ? parseInt(m[2]!.replace(/_/g, ""), Number(m[1] ?? 10)) : NaN;
    return Number.isSafeInteger(n) ? n : undefined;
  };

  function parseBody(block: BlockModel, endKw: string) {
    const stack: { kw: string; tok: Token }[] = [];
    // the values each open CASE's labels took: TIA Portal refuses a value twice
    const labels = new Map<Token, { lo: number; hi: number; at: Token }[]>();
    let parens = 0;
    while (peek().kind !== "eof" && !isKw(peek(), endKw) && !(iec && isHeaderAt(peek()))) {
      const t = next();
      const before = tokens[i - 2];
      // a member name ends a value too: #Run := #Motor.Run
      const member = before?.kind === "ident" && tokens[i - 3]?.text === ".";
      if (!iec && parens === 0 && (endsValue(before) || member) && !freeText.some(([a, b]) => before!.start >= a && before!.start < b)) {
        // a statement without its ';': the next one starts on a new line, or a closing keyword follows
        const starts = (t.kind === "local" || t.kind === "global" || (t.kind === "ident" && STATEMENT.has(t.upper))) && src.lastIndexOf("\n", t.start) > before!.start;
        if (starts || isKw(t, "END_IF", "ELSIF", "ELSE", "END_CASE", "END_FOR", "END_WHILE", "UNTIL", "END_REGION")) diagnostics.push({ message: "Missing ';'", start: before!.start, end: before!.end, severity: "error" });
      }
      const open = stack[stack.length - 1];
      if (open?.kw === "CASE" && parens === 0 && t.kind === "number" && before && (isKw(before, "OF") || before.text === ";" || before.text === ",") && [":", ",", ".."].includes(peek().text)) {
        const lo = intOf(t.text);
        const hi = peek().text === ".." && peek(1).kind === "number" ? (next(), intOf(next().text)) : lo;
        if (lo !== undefined && hi !== undefined) {
          const seen = labels.get(open.tok) ?? (labels.set(open.tok, []), labels.get(open.tok)!);
          const clash = seen.find((s) => lo <= s.hi && s.lo <= hi);
          if (clash) err(`CASE label ${lo === hi ? lo : `${lo}..${hi}`} is already taken on line ${lineOf(clash.at.start)}`, t);
          seen.push({ lo, hi, at: t });
        }
        continue;
      }
      // a quoted parameter name in a call (#m("Start request" := TRUE)) names the callee's parameter, no global
      if (!iec && t.kind === "global" && parens > 0 && (peek().text === ":=" || peek().text === "=>") && (tokens[i - 2]?.text === "(" || tokens[i - 2]?.text === ",")) continue;
      if (t.kind === "local" || t.kind === "global") {
        // a DB's start value of a member with a quoted name ("Valve 1".Delay := T#2s;) is the DB's own, like Counter := 0;
        const dbStart = block.kind === "DB" && t.kind === "global" && (tokens[i - 2]?.text === ";" || isKw(tokens[i - 2]!, "BEGIN"));
        collectRef(t, block, tokens[i - 2], dbStart ? "local" : undefined);
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
      if (peek().text === "(" && !NESTING[t.upper] && !CLOSERS.has(t.upper) && !NO_CALL.has(t.upper)) {
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
      while (peek().kind !== "eof" && isKw(peek(), "CONSTANT", "RETAIN", "PERSISTENT") && !declared()) if (next().upper === "CONSTANT") section = "Constant";
      gvl.vars.push(...parseDecls(section));
      if (isKw(peek(), "END_VAR")) gvl.end = next().end;
      if (!existing) blocks.push(gvl);
      continue;
    }
    const h = t.kind === "ident" ? headers[t.upper] : undefined;
    if (!h) {
      if (t.kind !== "pragma") err(`Expected ${iec ? "FUNCTION_BLOCK, FUNCTION, PROGRAM, METHOD, PROPERTY, ACTION or TYPE" : "FUNCTION_BLOCK, FUNCTION, ORGANIZATION_BLOCK, DATA_BLOCK or TYPE"}, found ${t.text}`, t);
      // resynchronize at the next header
      while (peek().kind !== "eof" && !(peek().kind === "ident" && (headers[peek().upper] || (iec && peek().upper === "VAR_GLOBAL")))) next();
      continue;
    }
    // METHOD PUBLIC Reset, PROPERTY PROTECTED Speed: the access modifier stands before the name
    if (iec) while (peek().kind === "ident" && /^(ABSTRACT|FINAL|PUBLIC|PRIVATE|PROTECTED|INTERNAL)$/.test(peek().upper) && peek(1).kind === "ident") next();
    const nameTok = next();
    if (nameTok.kind !== "global" && nameTok.kind !== "ident") err("Expected a block name", nameTok);
    const block: BlockModel = { kind: h.kind, name: unquote(nameTok.text), nameStart: nameTok.start, nameEnd: nameTok.end, start: t.start, end: t.end, vars: [], regions: [], refs: [] };
    ownerVars = undefined;
    if (iec && (t.upper === "METHOD" || t.upper === "PROPERTY" || t.upper === "ACTION")) {
      const owner = [...blocks].reverse().find((b) => (b.kind === "FB" || b.kind === "PRG") && !b.owner);
      if (owner) {
        block.owner = owner.name;
        ownerVars = owner.vars;
      }
      if (t.upper === "PROPERTY") block.property = {};
      // ACTION Reset: code of the FB, without declarations and without a return value
      if (t.upper === "ACTION") {
        block.action = true;
        if (peek().text === ":") next();
      }
    }
    const c = lineComment(nameTok.end);
    if (c) block.comment = c;
    if (iec) while (peek().kind === "ident" && /^(ABSTRACT|FINAL|PUBLIC|PRIVATE|PROTECTED|INTERNAL)$/.test(peek().upper)) next();
    if (h.kind === "FC" && !block.action && peek().text === ":") {
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
        const vars = parseDecls(SECTIONS[x.upper]!);
        const mods = lastModifiers;
        const headerEnd = mods.length ? mods[mods.length - 1]!.end : x.end;
        block.vars.push(...vars);
        const endTok = peek();
        const closed = isKw(endTok, "END_VAR");
        if (closed) next();
        else err("Missing END_VAR", endTok);
        const section: Section = mods.some((m) => m.upper === "CONSTANT") ? "Constant" : SECTIONS[x.upper]!;
        (block.sections ??= []).push({
          section,
          keyword: x.text,
          modifiers: mods.map((m) => m.upper),
          whole: { start: x.start, end: closed ? endTok.end : endTok.start },
          header: { start: x.start, end: headerEnd },
          body: { start: headerEnd, end: endTok.start },
        });
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
        // UDT, or a standard-access DB declared as STRUCT ... END_STRUCT: its members are one section
        const ty = parseType();
        const members = ty.members ?? [];
        block.vars.push(...members);
        const endTok = tokens[i - 1]!;
        const closed = isKw(endTok, "END_STRUCT");
        (block.sections ??= []).push({
          section: "Static",
          keyword: x.text,
          modifiers: [],
          whole: { start: x.start, end: endTok.end },
          header: { start: x.start, end: x.end },
          body: { start: x.end, end: closed ? endTok.start : endTok.end },
        });
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
      if (block.property && isKw(x, "GET", "SET")) {
        // an accessor: its own VAR sections, then its code up to END_GET / END_SET
        next();
        const end = x.upper === "GET" ? "END_GET" : "END_SET";
        const accessor = x.upper === "GET" ? "get" : "set";
        while (peek().kind === "ident" && SECTIONS[peek().upper]) {
          // each accessor has locals of its own: GET's tmp is not SET's tmp
          block.vars.push(...parseDecls(SECTIONS[next().upper]!).map((v) => ({ ...v, accessor }) as VarDecl));
          if (isKw(peek(), "END_VAR")) next();
          else err("Missing END_VAR", peek());
        }
        const start = peek().start;
        block.bodyStart ??= start;
        parseBody(block, end);
        block.property[x.upper === "GET" ? "get" : "set"] = { start, end: peek().start };
        if (isKw(peek(), end)) next();
        else err(`Missing ${end}`, x);
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
