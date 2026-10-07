// SPDX-License-Identifier: BUSL-1.1
// Checks for mistakes TIA Portal compiles without a word (seen on V20, 2026-10-06): a temporary read before the
// block writes it, an FC output the FC never writes, temporaries and constants nobody uses. And one TIA Portal
// refuses only when compiling: a function that never sets its return value. Conservative: a name handed to a
// call, a member or element written, counts as written, so what is flagged is wrong.
// `// rung-ignore` (or `// rung-ignore TEMP_READ_BEFORE_WRITE`) on the line or the line above silences one.
import type { Token } from "./lexer.js";
import type { BlockModel, Ref } from "./parser.js";

export interface Finding {
  start: number;
  end: number;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  code: string;
  /** Shown faded (unused code). */
  unnecessary?: true;
}

/** A name used as a call's argument (`f(x := #t)`, `f(#t)`, `=> #t`): the call may write it. */
function isArgument(tokens: Token[], at: number): boolean {
  const i = tokens.findIndex((t) => t.start === at);
  if (i <= 0) return false;
  const p = tokens[i - 1]!;
  if (p.kind === "op" && (p.text === "(" || p.text === "," || p.text === "=>")) return true;
  if (p.kind === "op" && p.text === ":=") {
    const pp = tokens[i - 2];
    const ppp = tokens[i - 3];
    return !!pp && pp.kind === "ident" && !!ppp && ppp.kind === "op" && (ppp.text === "(" || ppp.text === ",");
  }
  return false;
}

export function analyse(block: BlockModel, tokens: Token[], text: string): Finding[] {
  if (block.kind !== "FB" && block.kind !== "FC" && block.kind !== "OB") return [];
  if (block.bodyStart === undefined) return [];
  const out: Finding[] = [];
  const body = tokens.filter((t) => t.start >= block.bodyStart! && t.end <= block.end);
  const refs = [...block.refs].filter((r) => r.start >= block.bodyStart!).sort((a, b) => a.start - b.start);
  const upper = (s: string) => s.toUpperCase();
  // used anywhere in the block: its code, a declaration (Array[0..#MAX], String[LEN]), an AT overlay
  const name = (tk: Token) => tk.text.replace(/^#/, "").replace(/^"|"$/g, "").toUpperCase();
  const blockTokens = tokens.filter((tk) => tk.start >= block.start && tk.end <= block.end && (tk.kind === "local" || tk.kind === "ident"));
  const usedAt = (v: { name: string; start: number }) => blockTokens.some((tk) => name(tk) === upper(v.name) && !(tk.start >= v.start && tk.start < v.start + v.name.length + 1));
  // the code's loops: a read in a loop may see what the loop's last turn wrote
  const loops: { start: number; end: number }[] = [];
  const open: number[] = [];
  for (const tk of body) {
    if (tk.kind !== "ident") continue;
    if (tk.upper === "FOR" || tk.upper === "WHILE" || tk.upper === "REPEAT") open.push(tk.start);
    else if ((tk.upper === "END_FOR" || tk.upper === "END_WHILE" || tk.upper === "END_REPEAT") && open.length) loops.push({ start: open.pop()!, end: tk.end });
  }
  const written = (r: Ref) => r.access === "write" || r.access === "call" || r.members.length > 0 || isArgument(body, r.start) || text[r.end] === "[";

  // a temporary read before anything in the block writes it
  const temps = new Map(block.vars.filter((v) => v.section === "Temp").map((v) => [upper(v.name), v]));
  const set = new Set<string>();
  const flagged = new Set<string>();
  for (const r of refs) {
    if (r.kind !== "local") continue;
    const n = upper(r.name);
    if (!temps.has(n)) continue;
    if (written(r)) {
      if (r.access === "write" || r.access === "call" || isArgument(body, r.start)) set.add(n);
      else if (r.members.length || text[r.end] === "[") set.add(n); // a member or element: the rest may be set elsewhere
      continue;
    }
    const carried = loops.some((l) => r.start > l.start && r.start < l.end && refs.some((w) => upper(w.name) === n && w.start > l.start && w.start < l.end && written(w)));
    if (!set.has(n) && !flagged.has(n) && !carried) {
      flagged.add(n);
      out.push({ start: r.start, end: r.end, severity: "warning", code: "TEMP_READ_BEFORE_WRITE", message: `#${r.name} is read before ${block.name} writes it: a temporary keeps no value from the last call, so this reads a value nobody set` });
    }
  }

  // an FC output never written: the caller gets whatever was in that memory
  if (block.kind === "FC") {
    const writes = new Set(refs.filter((r) => r.kind === "local" && written(r)).map((r) => upper(r.name)));
    for (const v of block.vars.filter((x) => x.section === "Output")) {
      if (!writes.has(upper(v.name))) out.push({ start: v.start, end: v.start + v.name.length, severity: "warning", code: "OUTPUT_NEVER_WRITTEN", message: `${block.name} never writes its output ${v.name}: every call hands back an undefined value` });
    }
    const ret = block.returnType;
    if (ret && !/^void$/i.test(ret) && !refs.some((r) => upper(r.name) === upper(block.name) && r.access === "write")) {
      out.push({ start: block.nameStart, end: block.nameEnd, severity: "error", code: "NO_RETURN_VALUE", message: `${block.name} never sets its return value (#${block.name} := …): TIA Portal refuses it when compiling ("The function does not return a value")` });
    }
  }

  // temporaries and constants nobody uses: shown faded
  for (const v of block.vars) {
    if ((v.section === "Temp" || v.section === "Constant") && !usedAt(v)) {
      out.push({ start: v.start, end: v.start + v.name.length, severity: "hint", code: "UNUSED", unnecessary: true, message: `${v.name} is not used in ${block.name}` });
    }
  }

  // silenced by a comment on the line or the line above
  const ignores = tokens.filter((t) => t.kind === "comment" && /rung-ignore/i.test(t.text));
  if (!ignores.length) return out;
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
  return out.filter((f) => {
    const line = lineOf(f.start);
    return !ignores.some((c) => {
      const l = lineOf(c.start);
      const codes = /rung-ignore\s+([A-Z_ ,]+)/i.exec(c.text)?.[1]?.split(/[ ,]+/).filter(Boolean);
      return (l === line || l === line - 1) && (!codes?.length || codes.includes(f.code));
    });
  });
}
