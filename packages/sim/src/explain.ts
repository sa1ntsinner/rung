// SPDX-License-Identifier: BUSL-1.1
// "Why?" on a running PLC (or rung simulate): from the code, every statement of the block that writes the value,
// the IF/CASE branch each stands in, and their operands, with the values the PLC has now. A condition is worked
// out from those values, so the branch that holds shows. Unlike the debugger's Why? (which replays a test case and
// knows which write ran last), this is a snapshot: values read at one moment, several writers listed in code order.
import type { WorkspaceIndex } from "@rung/lsp";
import type { Expr, LRef, Stmt } from "./ast.js";
import { refsOf, refText, type WhyNode } from "./debug.js";
import { Simulator } from "./runtime.js";

/** A value as SCL shows it. */
function shown(v: unknown): string {
  if (v === undefined) return "—";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return `'${v}'`;
  return JSON.stringify(v);
}

/** Works out an expression from known values; undefined where a value or an operation is not known. */
function evaluate(e: Expr, value: (label: string) => unknown): unknown {
  switch (e.k) {
    case "lit":
      return e.value;
    case "ref":
      return value(refText(e.ref));
    case "un": {
      const x = evaluate(e.e, value);
      if (e.op === "NOT") return typeof x === "boolean" ? !x : undefined;
      return typeof x === "number" ? (e.op === "-" ? -x : x) : undefined;
    }
    case "bin": {
      const l = evaluate(e.l, value);
      const r = evaluate(e.r, value);
      if (l === undefined || r === undefined) return undefined;
      const op = e.op.toUpperCase();
      if (typeof l === "boolean" && typeof r === "boolean") {
        if (op === "AND" || op === "&") return l && r;
        if (op === "OR") return l || r;
        if (op === "XOR") return l !== r;
      }
      if (op === "=") return l === r;
      if (op === "<>") return l !== r;
      if (typeof l === "number" && typeof r === "number") {
        const n: Record<string, () => unknown> = { "<": () => l < r, ">": () => l > r, "<=": () => l <= r, ">=": () => l >= r, "+": () => l + r, "-": () => l - r, "*": () => l * r, "/": () => (r === 0 ? undefined : l / r) };
        return n[op]?.();
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

const norm = (s: string) => s.replace(/\s+/g, "").toUpperCase();

/**
 * Why `target` (#Running, "Line_DB".Speed) in the block of `uri` has its value: its writers in the code, each with
 * its operands and its branch, `depth` levels down. `value(label)` gives what the PLC has now, by the label the
 * code writes (#Running, "Start_PB"); none for a value that cannot be read (a temporary).
 */
export function explainStatic(index: WorkspaceIndex, uri: string, target: string, value: (label: string) => unknown, depth = 3): WhyNode {
  const doc = index.docs.get(uri);
  const block = doc?.parsed?.blocks[0];
  if (!doc || !block) throw new Error("this file holds no block to explain");
  const sim = new Simulator(index);
  const stmts = sim.statementsOf(block);
  const parents = sim.parentsOf(block);
  const lineOf = (s: Stmt) => doc.lines.position(s.at).line + 1;
  const lineText = (s: Stmt) => doc.text.split(/\r?\n/)[lineOf(s) - 1]?.trim() ?? "";
  const local = (name: string) => block.vars.some((v) => v.name.toUpperCase() === name.replace(/^#/, "").split(".")[0]!.toUpperCase());
  const label = (t: string) => (/^[A-Za-z_]/.test(t.trim()) && local(t.trim()) ? `#${t.trim()}` : t.trim());
  const written = (s: Stmt): LRef[] =>
    s.k === "assign" ? [s.target] : s.k === "for" ? [s.v] : s.k === "call" ? s.call.args.filter((a) => a.out && a.value.k === "ref").map((a) => (a.value as Extract<Expr, { k: "ref" }>).ref) : [];

  const explain = (name: string, levels: number, seen: Set<string>): WhyNode => {
    const node: WhyNode = { kind: "value", text: name, value: shown(value(name)), children: [] };
    const writers = stmts.filter((s) => written(s).some((r) => norm(refText(r)) === norm(name)));
    if (!writers.length) {
      // an input comes from the caller: nothing in this block to follow
      if (block.vars.some((v) => v.section === "Input" && `#${v.name}`.toUpperCase() === name.toUpperCase())) return node;
      node.children.push({ kind: "note", text: `not written in ${block.name}: an input, a value another block writes, or one a call writes inside`, children: [] });
      return node;
    }
    if (writers.length > 1) node.children.push({ kind: "note", text: `${writers.length} statements write it; of those that run in a cycle, the last one decides`, children: [] });
    const next = new Set([...seen, norm(name)]);
    for (const w of writers) {
      const write: WhyNode = { kind: "write", text: lineText(w), at: { uri, line: lineOf(w) }, children: [] };
      const exprs: Expr[] = w.k === "assign" ? [w.value] : w.k === "for" ? [w.from, w.to] : w.k === "call" ? w.call.args.filter((a) => !a.out).map((a) => a.value) : [];
      const operands = new Map<string, LRef>();
      for (const e of exprs) for (const o of refsOf(e)) operands.set(refText(o), o);
      for (const o of operands.keys()) write.children.push(levels > 1 && !next.has(norm(o)) ? explain(o, levels - 1, next) : { kind: "value", text: o, value: shown(value(o)), children: [] });
      // the branch it stands in, worked out from the values now
      for (let p = parents.get(w); p; p = parents.get(p.parent)) {
        const cond = p.parent.k === "if" && p.branch >= 0 ? p.parent.branches[p.branch]!.cond : p.parent.k === "while" ? p.parent.cond : p.parent.k === "case" ? p.parent.sel : undefined;
        const why: WhyNode = { kind: "condition", text: lineText(p.parent), at: { uri, line: lineOf(p.parent) }, children: [] };
        if (p.parent.k === "if" && p.branch < 0) {
          const all = p.parent.branches.map((b) => evaluate(b.cond, value));
          why.value = all.every((x) => x === false) ? "ELSE: every condition is FALSE now" : all.some((x) => x === true) ? "ELSE: a condition before it is TRUE now, so this does not run" : "ELSE";
        } else if (cond) {
          const v = evaluate(cond, value);
          if (v !== undefined) why.value = p.parent.k === "case" ? `${shown(v)} now` : `${shown(v)} now`;
          for (const o of new Map([...refsOf(cond)].map((x) => [refText(x), x])).keys()) why.children.push({ kind: "value", text: o, value: shown(value(o)), children: [] });
        }
        write.children.push(why);
      }
      node.children.push(write);
    }
    return node;
  };
  return explain(label(target), depth, new Set());
}
