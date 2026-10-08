// SPDX-License-Identifier: BUSL-1.1
// Formatting SCL as TIA Portal writes it. TIA Portal keeps a block's code as statements and writes the text anew on
// every export: one tab for the first level and four spaces for each level below, keywords in capitals, spaces
// around operators, one statement per line, a call of a block with several parameters one parameter per line
// (aligned after the bracket), a CASE label on its own line. Formatted that way, a file comes back from TIA Portal
// as it went in. Only code (after BEGIN) is formatted; declarations are TIA Portal's own already.
// Safe: the result must have the same tokens in the same order (comments included), or nothing is changed.
// Rules observed on TIA Portal V19 and V20 exports.
import { CONVERSION, STANDARD_BY_NAME } from "./catalog.js";
import { lex, type Token } from "./lexer.js";

const KEYWORDS = new Set(
  "IF THEN ELSIF ELSE END_IF CASE OF END_CASE FOR TO BY DO END_FOR WHILE END_WHILE REPEAT UNTIL END_REPEAT EXIT CONTINUE RETURN GOTO AND OR XOR NOT MOD TRUE FALSE REGION END_REGION".split(" "),
);
const WORD_OPS = new Set(["AND", "OR", "XOR", "MOD"]);
const BINARY = new Set([":=", "=>", "+", "-", "*", "/", "**", "=", "<>", "<", ">", "<=", ">=", "&"]);
const END_OF_BODY = /^END_(FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK)$/;

/** A standard instruction by name (conversions like INT_TO_REAL too): how TIA Portal writes it and its parameters. */
const standard = (upper: string): { name: string; params: { name: string }[] } | undefined =>
  STANDARD_BY_NAME.get(upper) ?? (CONVERSION.test(upper) ? { name: upper, params: [{ name: "IN" }] } : undefined);

/** The indent of a level of code (1 = the block's own statements). */
const indent = (level: number) => (level <= 0 ? "" : "\t" + "    ".repeat(level - 1));

type Ctx = { kind: "if" | "loop" | "repeat" | "region" } | { kind: "case"; labels: number };

/** Formats every block's code; `undefined` when the text has errors the formatter will not touch. */
export function formatScl(text: string): string | undefined {
  const r = formatSclOrWhy(text);
  return "text" in r ? r.text : undefined;
}

/** The formatted text, or why the text is left as it is. */
export function formatSclOrWhy(text: string): { text: string } | { reason: string } {
  const { tokens, errors } = lex(text);
  if (errors.length) return { reason: `a syntax error: ${errors[0]!.message}` };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = "";
  let last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "ident" || t.upper !== "BEGIN") continue;
    const end = tokens.findIndex((x, j) => j > i && x.kind === "ident" && END_OF_BODY.test(x.upper));
    if (end < 0) continue;
    const from = text.indexOf("\n", t.end) + 1; // the code starts on the line after BEGIN
    const to = text.lastIndexOf("\n", tokens[end]!.start - 1) + 1; // and ends before the END_… line
    if (from <= 0 || to < from || text.slice(t.end, from).trim()) continue; // code on BEGIN's own line: left alone
    const body = tokens.slice(i + 1, end).filter((x) => x.start >= from);
    const lines = formatBody(text, body, to);
    if (typeof lines === "string") return { reason: lines };
    out += text.slice(last, from) + lines.map((l) => l + eol).join("");
    last = to;
    i = end;
  }
  const result = out + text.slice(last);
  return sameTokens(text, result) ? { text: result } : { reason: "the result would not keep every token (a rung bug: please report this file)" };
}

function sameTokens(a: string, b: string): boolean {
  const ta = lex(a).tokens.filter((t) => t.kind !== "eof");
  const tb = lex(b).tokens.filter((t) => t.kind !== "eof");
  if (ta.length !== tb.length) return false;
  return ta.every((t, i) => {
    const u = tb[i]!;
    return t.kind === u.kind && (t.kind === "ident" ? t.upper === u.upper : t.text === u.text);
  });
}

/** The lines of one block's code, or why it is left as written. */
function formatBody(src: string, tokens: Token[], to: number): string[] | string {
  const lines: string[] = [];
  const stack: Ctx[] = [];
  let level = 1;
  let i = 0;
  // the source line of the last token written, to keep a comment after a statement on its line
  let lastLine = -1;
  const lineOf = (offset: number) => {
    let n = 0;
    for (let k = 0; k < offset; k++) if (src.charCodeAt(k) === 10) n++;
    return n;
  };
  const push = (text: string, at: number, endTok: Token) => {
    lines.push(indent(at) + text);
    lastLine = lineOf(endTok.end);
  };
  const blankLinesBefore = (t: Token) => {
    if (!lines.length) return;
    const prev = tokens[tokens.indexOf(t) - 1];
    if (!prev) return;
    const gap = src.slice(prev.end, t.start);
    const n = (gap.match(/\n/g) ?? []).length - 1;
    for (let k = 0; k < n; k++) lines.push("\t");
  };
  const isKw = (t: Token | undefined, ...names: string[]) => !!t && t.kind === "ident" && names.includes(t.upper);
  /** Tokens up to (not including) the first token matching `stop` at bracket depth 0, comments left in place. */
  const until = (stop: (t: Token) => boolean): Token[] => {
    const part: Token[] = [];
    let depth = 0;
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (depth === 0 && t.kind !== "comment" && stop(t)) break;
      if (t.kind === "op" && (t.text === "(" || t.text === "[")) depth++;
      if (t.kind === "op" && (t.text === ")" || t.text === "]")) depth--;
      part.push(t);
      i++;
    }
    return part;
  };
  const ctx = () => stack[stack.length - 1];

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.kind === "comment") {
      // after a statement on the same line it stays there; else on its own line
      if (lines.length && lineOf(t.start) === lastLine) lines[lines.length - 1] += " " + t.text;
      else {
        blankLinesBefore(t);
        push(t.text, level, t);
      }
      i++;
      continue;
    }
    blankLinesBefore(t);
    const c = ctx();
    if (isKw(t, "IF", "ELSIF", "WHILE", "FOR", "CASE")) {
      const head = t.upper;
      if (head === "ELSIF") level--;
      i++;
      const closer = head === "IF" || head === "ELSIF" ? "THEN" : head === "CASE" ? "OF" : "DO";
      const cond = until((x) => isKw(x, closer));
      const kw = tokens[i];
      if (!isKw(kw, closer)) return `${head} without ${closer}`;
      i++;
      push(`${head} ${join(cond, src)} ${closer}`, level, kw!);
      if (head === "IF") stack.push({ kind: "if" });
      if (head === "WHILE" || head === "FOR") stack.push({ kind: "loop" });
      if (head === "CASE") stack.push({ kind: "case", labels: level + 1 });
      level++;
      continue;
    }
    if (isKw(t, "ELSE")) {
      i++;
      if (c?.kind === "case") {
        push("ELSE", c.labels, t);
        level = c.labels + 1;
      } else {
        push("ELSE", level - 1, t);
      }
      continue;
    }
    if (isKw(t, "END_IF", "END_FOR", "END_WHILE", "END_CASE", "END_REPEAT")) {
      const top = stack.pop();
      if (!top) return `${t.upper} without its start`;
      level = top.kind === "case" ? top.labels - 1 : top.kind === "repeat" ? level : level - 1;
      i++;
      let text = t.upper;
      if (tokens[i]?.kind === "op" && tokens[i]!.text === ";") {
        text += ";";
        i++;
      }
      push(text, level, tokens[i - 1]!);
      continue;
    }
    if (isKw(t, "REPEAT")) {
      i++;
      push("REPEAT", level, t);
      stack.push({ kind: "repeat" });
      level++;
      continue;
    }
    if (isKw(t, "UNTIL")) {
      i++;
      level--;
      const cond = until((x) => isKw(x, "END_REPEAT") || (x.kind === "op" && x.text === ";"));
      if (tokens[i]?.kind === "op" && tokens[i]!.text === ";") i++;
      push(`UNTIL ${join(cond, src)}`, level, cond[cond.length - 1] ?? t);
      continue;
    }
    if (isKw(t, "REGION", "END_REGION")) {
      // the rest of the line is the region's name, as written
      const eolAt = src.indexOf("\n", t.end);
      const rest = src.slice(t.end, eolAt < 0 ? src.length : eolAt).trim();
      if (t.upper === "REGION") {
        push(rest ? `REGION ${rest}` : "REGION", level, t);
        stack.push({ kind: "region" });
        level++;
      } else {
        if (stack.pop()?.kind !== "region") return "END_REGION without REGION";
        level--;
        push(rest ? `END_REGION ${rest}` : "END_REGION", level, t);
      }
      const stopAt = eolAt < 0 ? src.length : eolAt;
      while (i < tokens.length && tokens[i]!.start < stopAt) i++;
      continue;
    }
    // a CASE label: values up to ':' (not ':=') on a line of their own
    if (c?.kind === "case") {
      const save = i;
      const label = until((x) => x.kind === "op" && (x.text === ":" || x.text === ":=" || x.text === ";"));
      if (tokens[i]?.kind === "op" && tokens[i]!.text === ":") {
        i++;
        push(`${join(label, src)}:`, c.labels, tokens[i - 1]!);
        level = c.labels + 1;
        continue;
      }
      i = save;
    }
    // a statement, up to its ';'
    const stmt = until((x) => x.kind === "op" && x.text === ";");
    const semi = tokens[i];
    if (!(semi?.kind === "op" && semi.text === ";")) {
      // the last statement may go without ';' before END_…: kept as written
      if (!stmt.length) return "code the formatter does not know";
      push(join(stmt, src), level, stmt[stmt.length - 1]!);
      continue;
    }
    i++;
    for (const l of callLines(stmt, src, level)) lines.push(l);
    lastLine = lineOf(semi.end);
    if (stmt.some((x) => x.kind === "comment")) return "a comment inside a statement (left where it is, so the file is not formatted)";
  }
  // a block whose code is only ";": TIA Portal writes it one level in (seen in V19 and V20)
  if (lines.length === 1 && lines[0] === "\t;") lines[0] = "\t    ;";
  // blank lines before END_… stay, as TIA Portal keeps them
  const tail = tokens[tokens.length - 1];
  if (tail) for (let k = (src.slice(tail.end, to).match(/\n/g) ?? []).length - 1; k > 0; k--) lines.push("\t");
  return lines;
}

/**
 * A statement's lines: a call of a block with two or more parameters, one parameter per line aligned after the
 * bracket (as TIA Portal writes it); anything else on one line.
 */
function callLines(stmt: Token[], src: string, level: number): string[] {
  if (!stmt.length) return [indent(level) + ";"];
  const head = stmt[0];
  const open = stmt[1];
  const isCall = head && open && (head.kind === "local" || head.kind === "global" || head.kind === "ident") && open.kind === "op" && open.text === "(" && stmt[stmt.length - 1]?.text === ")";
  if (isCall) {
    const args: Token[][] = [[]];
    let depth = 0;
    for (const t of stmt.slice(2, -1)) {
      if (t.kind === "op" && (t.text === "(" || t.text === "[")) depth++;
      if (t.kind === "op" && (t.text === ")" || t.text === "]")) depth--;
      if (depth === 0 && t.kind === "op" && t.text === ",") args.push([]);
      else args[args.length - 1]!.push(t);
    }
    if (args.length >= 2 && args.every((a) => a.length)) {
      const callee = join([head], src);
      const pad = indent(level) + " ".repeat(callee.length + 1);
      const std = head.kind === "ident" ? standard(head.upper) : undefined;
      return args.map((a, k) => (k === 0 ? `${indent(level)}${callee}(` : pad) + join(a, src, std) + (k === args.length - 1 ? ");" : ","));
    }
  }
  return [indent(level) + join(stmt, src) + ";"];
}

/** Tokens of an expression or statement with TIA Portal's spacing and capitals. */
function join(tokens: Token[], src: string, std?: { params: { name: string }[] }): string {
  let s = "";
  // standard functions being called, innermost last: their parameter names are written in capitals
  const calls: ({ params: { name: string }[] } | undefined)[] = std ? [std] : [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    const p = tokens[k - 1];
    const next = tokens[k + 1];
    let text = t.text;
    if (t.kind === "ident") {
      const e = standard(t.upper);
      const call = calls[calls.length - 1];
      const param = call && next?.kind === "op" && (next.text === ":=" || next.text === "=>") ? call.params.find((x) => x.name.toUpperCase() === t.upper) : undefined;
      text = KEYWORDS.has(t.upper) ? t.upper : param ? param.name : e && next?.kind === "op" && next.text === "(" ? e.name : t.text;
    }
    if (t.kind === "op" && t.text === "(") calls.push(p?.kind === "ident" ? standard(p.upper) : undefined);
    if (t.kind === "op" && t.text === ")") calls.pop();
    if (p) s += spaceBetween(p, t, tokens[k - 2], src) ? " " : "";
    s += text;
  }
  return s;
}

const isOp = (t: Token | undefined, ...ops: string[]) => !!t && t.kind === "op" && ops.includes(t.text);
const isWordOp = (t: Token | undefined) => !!t && t.kind === "ident" && (WORD_OPS.has(t.upper) || t.upper === "NOT");
/** A '-' or '+' that is a sign: at the start, after an operator, a bracket, a comma or a keyword. */
const isSign = (t: Token, before: Token | undefined) => isOp(t, "-", "+") && (!before || (before.kind === "op" && !isOp(before, ")", "]")) || (before.kind === "ident" && KEYWORDS.has(before.upper)));

function spaceBetween(p: Token, t: Token, pp: Token | undefined, src: string): boolean {
  if (t.kind === "comment" || p.kind === "comment") return true;
  if (isOp(p, "(", "[", ".", "..") || isOp(t, ")", "]", ".", "..", ",", ";", "[")) return false;
  if (isOp(p, ",")) return true;
  if (isOp(t, "(")) return !(p.kind === "local" || p.kind === "global" || (p.kind === "ident" && !KEYWORDS.has(p.upper)) || isOp(p, "]"));
  // NOT keeps the space it had (TIA Portal writes NOT#b as it was typed)
  if (p.kind === "ident" && p.upper === "NOT") return /\s/.test(src.slice(p.end, t.start)) || t.kind === "ident";
  if (isSign(p, pp)) return t.kind !== "number"; // "- #a" but "-5", "* -1", "BY -1", as TIA Portal writes a sign
  if (isOp(t, ":") || isOp(p, ":")) return false;
  if ((t.kind === "op" && BINARY.has(t.text)) || (p.kind === "op" && BINARY.has(p.text))) return true;
  if (isWordOp(t) || isWordOp(p)) return true;
  return true;
}
