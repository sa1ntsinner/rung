// SPDX-License-Identifier: BUSL-1.1
// Statement/expression parser for SCL block bodies, producing an AST the simulator executes.
import { lex, type Token } from "@rung/lsp";

export type Expr =
  | { k: "lit"; value: boolean | number | string; type: "bool" | "int" | "real" | "time" | "string" }
  | { k: "ref"; ref: LRef }
  | { k: "un"; op: "NOT" | "-" | "+"; e: Expr }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "call"; callee: LRef; args: Arg[] };

export interface LRef {
  root: { kind: "local" | "global" | "ident"; name: string };
  path: ({ member: string } | { index: Expr[] })[];
  start: number;
}

export interface Arg {
  name?: string;
  out?: boolean;
  value: Expr;
}

export type Stmt =
  | { k: "assign"; target: LRef; value: Expr; at: number }
  | { k: "call"; call: Extract<Expr, { k: "call" }>; at: number }
  | { k: "if"; branches: { cond: Expr; body: Stmt[] }[]; else?: Stmt[]; at: number }
  | { k: "case"; sel: Expr; items: { labels: { lo: Expr; hi?: Expr }[]; body: Stmt[] }[]; else?: Stmt[]; at: number }
  | { k: "for"; v: LRef; from: Expr; to: Expr; by?: Expr; body: Stmt[]; at: number }
  | { k: "while"; cond: Expr; body: Stmt[]; at: number }
  | { k: "repeat"; body: Stmt[]; until: Expr; at: number }
  | { k: "exit" | "continue" | "return" | "empty"; at: number };

export class SclSyntaxError extends Error {
  constructor(
    message: string,
    public readonly offset: number,
  ) {
    super(message);
  }
}

/** Parses TIME/LTIME literal text (T#1s500ms, TIME#2h, LT#10ms) to milliseconds. */
export function parseTime(text: string): number {
  const body = text.slice(text.indexOf("#") + 1).replace(/_/g, "");
  const neg = body.startsWith("-");
  let ms = 0;
  for (const m of (neg ? body.slice(1) : body).matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|d|h|m|s)/gi)) {
    const v = parseFloat(m[1]!);
    const unit = m[2]!.toLowerCase();
    ms += unit === "d" ? v * 86_400_000 : unit === "h" ? v * 3_600_000 : unit === "m" ? v * 60_000 : unit === "s" ? v * 1000 : unit === "ms" ? v : unit === "us" ? v / 1000 : v / 1e6;
  }
  return neg ? -ms : ms;
}

function literal(t: Token): Extract<Expr, { k: "lit" }> {
  const text = t.text;
  const hash = text.indexOf("#");
  if (hash > 0) {
    const prefix = text.slice(0, hash).toUpperCase();
    const val = text.slice(hash + 1).replace(/_/g, "");
    if (/^(T|TIME|LT|LTIME)$/.test(prefix)) return { k: "lit", value: parseTime(text), type: "time" };
    if (/^(2|8|16)$/.test(prefix)) return { k: "lit", value: parseInt(val, Number(prefix)), type: "int" };
    if (/^(BOOL)$/.test(prefix)) return { k: "lit", value: /^(1|TRUE)$/i.test(val), type: "bool" };
    if (/REAL$/.test(prefix)) return { k: "lit", value: parseFloat(val), type: "real" };
    const based = /^(2|8|16)#(.+)$/.exec(val);
    if (based) return { k: "lit", value: parseInt(based[2]!, Number(based[1])), type: "int" };
    return { k: "lit", value: Number(val), type: /[.eE]/.test(val) ? "real" : "int" };
  }
  const clean = text.replace(/_/g, "");
  return { k: "lit", value: Number(clean), type: /[.eE]/.test(clean) ? "real" : "int" };
}

const BINARY: [string[], number][] = [
  [["OR"], 1],
  [["XOR"], 2],
  [["AND", "&"], 3],
  [["=", "<>"], 4],
  [["<", ">", "<=", ">="], 5],
  [["+", "-"], 6],
  [["*", "/", "MOD"], 7],
  [["**"], 8],
];
const PREC = new Map<string, number>(BINARY.flatMap(([ops, p]) => ops.map((o) => [o, p] as [string, number])));

export function parseBody(src: string, from = 0, to = src.length): Stmt[] {
  const tokens = lex(src.slice(0, to)).tokens.filter((t) => t.kind !== "comment" && t.kind !== "pragma" && t.start >= from);
  let i = 0;
  const peek = (k = 0) => tokens[Math.min(i + k, tokens.length - 1)]!;
  const next = () => tokens[Math.min(i++, tokens.length - 1)]!;
  const kw = (t: Token, ...w: string[]) => t.kind === "ident" && w.includes(t.upper);
  const expectOp = (op: string) => {
    const t = next();
    if (t.text !== op) throw new SclSyntaxError(`Expected '${op}' but found '${t.text || "end of file"}'`, t.start);
  };
  const expectKw = (w: string) => {
    const t = next();
    if (!kw(t, w)) throw new SclSyntaxError(`Expected ${w} but found '${t.text || "end of file"}'`, t.start);
  };

  function lref(first: Token): LRef {
    const kind = first.kind === "local" ? "local" : first.kind === "global" ? "global" : "ident";
    const name = first.text.replace(/^#/, "").replace(/^"|"$/g, "");
    const r: LRef = { root: { kind, name }, path: [], start: first.start };
    for (;;) {
      if (peek().text === "." && ["ident", "global", "local"].includes(peek(1).kind)) {
        next();
        r.path.push({ member: next().text.replace(/^#/, "").replace(/^"|"$/g, "") });
      } else if (peek().text === "[") {
        next();
        const idx = [expr()];
        while (peek().text === ",") {
          next();
          idx.push(expr());
        }
        expectOp("]");
        r.path.push({ index: idx });
      } else break;
    }
    return r;
  }

  function args(): Arg[] {
    expectOp("(");
    const out: Arg[] = [];
    while (peek().text !== ")" && peek().kind !== "eof") {
      if (peek().kind === "ident" && (peek(1).text === ":=" || peek(1).text === "=>")) {
        const name = next().text;
        const op = next().text;
        out.push({ name, out: op === "=>", value: expr() });
      } else out.push({ value: expr() });
      if (peek().text === ",") next();
      else break;
    }
    expectOp(")");
    return out;
  }

  function primary(): Expr {
    const t = next();
    if (t.kind === "number") return literal(t);
    if (t.kind === "string") return { k: "lit", value: t.text.slice(1, -1).replace(/''/g, "'").replace(/\$(.)/g, (_, c: string) => (c === "N" || c === "L" ? "\n" : c === "T" ? "\t" : c)), type: "string" };
    if (kw(t, "TRUE", "FALSE")) return { k: "lit", value: t.upper === "TRUE", type: "bool" };
    if (t.text === "(") {
      const e = expr();
      expectOp(")");
      return e;
    }
    if (kw(t, "NOT")) return { k: "un", op: "NOT", e: unary() };
    if (t.kind === "local" || t.kind === "global" || t.kind === "ident") {
      const r = lref(t);
      if (peek().text === "(") return { k: "call", callee: r, args: args() };
      return { k: "ref", ref: r };
    }
    throw new SclSyntaxError(`Unexpected '${t.text || "end of file"}' in expression`, t.start);
  }

  function unary(): Expr {
    if (peek().text === "-" || peek().text === "+") {
      const op = next().text as "-" | "+";
      return { k: "un", op, e: unary() };
    }
    if (kw(peek(), "NOT")) {
      next();
      return { k: "un", op: "NOT", e: unary() };
    }
    return primary();
  }

  function binaryOp(t: Token): string | undefined {
    const op = t.kind === "ident" ? t.upper : t.kind === "op" ? t.text : undefined;
    return op !== undefined && PREC.has(op) ? op : undefined;
  }

  function expr(minPrec = 1): Expr {
    let left = unary();
    for (;;) {
      const op = binaryOp(peek());
      if (!op) break;
      const p = PREC.get(op)!;
      if (p < minPrec) break;
      next();
      const right = expr(op === "**" ? p : p + 1);
      left = { k: "bin", op, l: left, r: right };
    }
    return left;
  }

  function block(...until: string[]): Stmt[] {
    const out: Stmt[] = [];
    while (peek().kind !== "eof" && !kw(peek(), ...until)) out.push(stmt());
    return out;
  }

  function semicolon() {
    if (peek().text === ";") next();
  }

  function stmt(): Stmt {
    const t = peek();
    const at = t.start;
    if (t.text === ";") {
      next();
      return { k: "empty", at };
    }
    if (kw(t, "IF")) {
      next();
      const branches = [{ cond: expr(), body: [] as Stmt[] }];
      expectKw("THEN");
      branches[0]!.body = block("ELSIF", "ELSE", "END_IF");
      let elseBody: Stmt[] | undefined;
      while (kw(peek(), "ELSIF")) {
        next();
        const cond = expr();
        expectKw("THEN");
        branches.push({ cond, body: block("ELSIF", "ELSE", "END_IF") });
      }
      if (kw(peek(), "ELSE")) {
        next();
        elseBody = block("END_IF");
      }
      expectKw("END_IF");
      semicolon();
      return { k: "if", branches, ...(elseBody ? { else: elseBody } : {}), at };
    }
    if (kw(t, "CASE")) {
      next();
      const sel = expr();
      expectKw("OF");
      const items: { labels: { lo: Expr; hi?: Expr }[]; body: Stmt[] }[] = [];
      let elseBody: Stmt[] | undefined;
      while (!kw(peek(), "END_CASE", "ELSE") && peek().kind !== "eof") {
        const labels: { lo: Expr; hi?: Expr }[] = [];
        for (;;) {
          const lo = expr();
          if (peek().text === "..") {
            next();
            labels.push({ lo, hi: expr() });
          } else labels.push({ lo });
          if (peek().text === ",") next();
          else break;
        }
        expectOp(":");
        // statements until the next label ("<expr> :") or ELSE/END_CASE
        const body: Stmt[] = [];
        while (!kw(peek(), "END_CASE", "ELSE") && peek().kind !== "eof" && !looksLikeLabel()) body.push(stmt());
        items.push({ labels, body });
      }
      if (kw(peek(), "ELSE")) {
        next();
        elseBody = block("END_CASE");
      }
      expectKw("END_CASE");
      semicolon();
      return { k: "case", sel, items, ...(elseBody ? { else: elseBody } : {}), at };
    }
    if (kw(t, "FOR")) {
      next();
      const v = lref(next());
      expectOp(":=");
      const fromE = expr();
      expectKw("TO");
      const toE = expr();
      let by: Expr | undefined;
      if (kw(peek(), "BY")) {
        next();
        by = expr();
      }
      expectKw("DO");
      const body = block("END_FOR");
      expectKw("END_FOR");
      semicolon();
      return { k: "for", v, from: fromE, to: toE, ...(by ? { by } : {}), body, at };
    }
    if (kw(t, "WHILE")) {
      next();
      const cond = expr();
      expectKw("DO");
      const body = block("END_WHILE");
      expectKw("END_WHILE");
      semicolon();
      return { k: "while", cond, body, at };
    }
    if (kw(t, "REPEAT")) {
      next();
      const body = block("UNTIL");
      expectKw("UNTIL");
      const until = expr();
      expectKw("END_REPEAT");
      semicolon();
      return { k: "repeat", body, until, at };
    }
    if (kw(t, "EXIT", "CONTINUE", "RETURN")) {
      next();
      semicolon();
      return { k: t.upper.toLowerCase() as "exit" | "continue" | "return", at };
    }
    if (kw(t, "REGION")) {
      // REGION name ... END_REGION is transparent at runtime
      const eol = src.indexOf("\n", t.end);
      next();
      while (peek().kind !== "eof" && peek().start < (eol < 0 ? src.length : eol)) next();
      const body = block("END_REGION");
      expectKw("END_REGION");
      return { k: "if", branches: [{ cond: { k: "lit", value: true, type: "bool" }, body }], at };
    }
    if (t.kind === "local" || t.kind === "global" || t.kind === "ident") {
      next();
      const target = lref(t);
      if (peek().text === "(") {
        const call = { k: "call" as const, callee: target, args: args() };
        semicolon();
        return { k: "call", call, at };
      }
      expectOp(":=");
      const value = expr();
      semicolon();
      return { k: "assign", target, value, at };
    }
    throw new SclSyntaxError(`Unexpected '${t.text || "end of file"}'`, t.start);
  }

  /** At a CASE label: `<number|ident|range> :` (but not `x :=`). */
  function looksLikeLabel(): boolean {
    let j = i;
    if (tokens[j]?.text === "-") j++;
    const first = tokens[j];
    if (!first || !(first.kind === "number" || first.kind === "ident" || first.kind === "global")) return false;
    j++;
    while (tokens[j]?.text === "." && tokens[j + 1]?.kind === "ident") j += 2;
    if (tokens[j]?.text === "..") return true;
    if (tokens[j]?.text === ",") return true;
    return tokens[j]?.text === ":";
  }

  const out: Stmt[] = [];
  while (peek().kind !== "eof") {
    if (kw(peek(), "END_FUNCTION_BLOCK", "END_FUNCTION", "END_ORGANIZATION_BLOCK", "END_DATA_BLOCK")) break;
    out.push(stmt());
  }
  return out;
}
