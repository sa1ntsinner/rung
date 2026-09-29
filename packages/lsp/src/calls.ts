// SPDX-License-Identifier: BUSL-1.1
// Block calls against the block they call, like TIA Portal's "Update block call": an argument the callee no
// longer has, and parameters an FC call leaves out (TIA wants every input and in/out of an FC supplied).
import { STANDARD_BY_NAME } from "./catalog.js";
import type { Token } from "./lexer.js";
import type { BlockModel, Ref } from "./parser.js";
import { scopedTo, type WorkspaceIndex } from "./workspace.js";

export interface CallParam {
  name: string;
  section: "Input" | "Output" | "InOut";
  type: string;
}

export interface CallArg {
  name?: string;
  nameStart?: number;
  nameEnd?: number;
  out?: boolean;
  /** The whole argument, `Name := value` */
  start: number;
  end: number;
}

export interface CallSite {
  ref: Ref;
  callee: { name: string; kind: "FC" | "FB" | "std"; params: CallParam[] };
  /** Offset of the closing parenthesis. */
  close: number;
  args: CallArg[];
}

const SECTIONS = new Set(["Input", "Output", "InOut"]);
const ALWAYS = new Set(["EN", "ENO"]);

function paramsOf(index: WorkspaceIndex, typeName: string): CallSite["callee"] | undefined {
  const g = index.global(typeName);
  const b: BlockModel | undefined = g?.block;
  if (b && (b.kind === "FC" || b.kind === "FB"))
    return { name: b.name, kind: b.kind, params: b.vars.filter((v) => SECTIONS.has(v.section)).map((v) => ({ name: v.name, section: v.section as CallParam["section"], type: v.type })) };
  const std = STANDARD_BY_NAME.get(typeName.toUpperCase());
  if (std)
    return { name: std.name, kind: "std", params: std.params.map((p) => ({ name: p.name, section: p.dir === "in" ? "Input" : p.dir === "out" ? "Output" : "InOut", type: p.type })) };
  return undefined;
}

function calleeOf(index: WorkspaceIndex, block: BlockModel, ref: Ref, decl: (name: string) => { type: string; typeRef?: string } | undefined): CallSite["callee"] | undefined {
  if (ref.members.length) return undefined;
  if (ref.kind === "global") {
    const g = index.global(ref.name)?.block;
    if (g?.kind === "FC") return paramsOf(index, g.name);
    if (g?.kind === "DB" && g.dbOf) return paramsOf(index, g.dbOf); // "Motor_DB"(...): the FB of the instance DB
    return undefined;
  }
  if (ref.kind === "local") {
    const d = decl(ref.name); // #inst(...): a multi-instance
    const t = d && (d.typeRef ?? d.type).replace(/^"|"$/g, "");
    return t ? paramsOf(index, t) : undefined;
  }
  return STANDARD_BY_NAME.get(ref.name.toUpperCase())?.kind === "function" ? paramsOf(index, ref.name) : undefined;
}

/** The argument list after a call reference, split at top-level commas. */
function argsAfter(tokens: Token[], from: number): { close: number; args: CallArg[] } | undefined {
  let i = tokens.findIndex((t) => t.start >= from);
  if (i < 0 || tokens[i]!.text !== "(") return undefined;
  const args: CallArg[] = [];
  let depth = 0;
  let cur: CallArg | undefined;
  let prevEnd = tokens[i]!.end;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.text === "(" || t.text === "[") {
      depth++;
      if (depth === 1) {
        prevEnd = t.end;
        continue;
      }
    } else if (t.text === ")" || t.text === "]") {
      depth--;
      if (depth === 0) {
        if (cur) args.push({ ...cur, end: prevEnd });
        return { close: t.start, args };
      }
    } else if (depth === 1 && t.text === ",") {
      if (cur) args.push({ ...cur, end: prevEnd });
      cur = undefined;
      prevEnd = t.end;
      continue;
    }
    if (depth >= 1) {
      if (!cur) {
        cur = { start: t.start, end: t.end };
        const next = tokens[i + 1];
        if (depth === 1 && t.kind === "ident" && (next?.text === ":=" || next?.text === "=>")) Object.assign(cur, { name: t.text, nameStart: t.start, nameEnd: t.end, out: next.text === "=>" });
      }
      prevEnd = t.end;
    }
  }
  return undefined;
}

export function callSites(index: WorkspaceIndex, uri: string, decl: (block: BlockModel, name: string) => { type: string; typeRef?: string } | undefined): CallSite[] {
  index = scopedTo(index, uri); // names mean the objects of this file's PLC
  const doc = index.docs.get(uri);
  if (!doc?.parsed || !/\.scl$/i.test(uri)) return [];
  const tokens = doc.parsed.tokens.filter((t) => t.kind !== "comment" && t.kind !== "pragma");
  const out: CallSite[] = [];
  for (const block of doc.parsed.blocks)
    for (const ref of block.refs) {
      if (ref.access !== "call") continue;
      const callee = calleeOf(index, block, ref, (n) => decl(block, n));
      if (!callee) continue;
      const a = argsAfter(tokens, ref.end);
      if (a) out.push({ ref, callee, close: a.close, args: a.args });
    }
  return out;
}

/** Parameters an FC call must supply but does not (named calls only; a positional call is left alone). */
export function missingParams(site: CallSite): CallParam[] {
  if (site.callee.kind !== "FC" || site.args.some((a) => !a.name)) return [];
  const given = new Set(site.args.map((a) => a.name!.toUpperCase()));
  return site.callee.params.filter((p) => (p.section === "Input" || p.section === "InOut") && !given.has(p.name.toUpperCase()));
}

export function unknownArgs(site: CallSite): CallArg[] {
  const known = new Set(site.callee.params.map((p) => p.name.toUpperCase()));
  // CONCAT, MIN, MAX, MUX, ... take as many inputs as the call names: IN1, IN2, IN3, ...
  const extensible = (n: string) => site.callee.kind === "std" && /^IN\d+$/i.test(n);
  return site.args.filter((a) => a.name && !known.has(a.name.toUpperCase()) && !ALWAYS.has(a.name.toUpperCase()) && !extensible(a.name));
}

/** A value that compiles for a new input: FALSE, 0, 0.0, T#0s, ''; for anything else a variable to declare. */
export function defaultArgument(p: CallParam): string {
  const t = p.type.replace(/^"|"$/g, "").toUpperCase();
  if (p.section === "InOut") return `#${p.name}`;
  if (t === "BOOL") return "FALSE";
  if (/^(U?S?INT|U?D?INT|U?LINT|BYTE|WORD|DWORD|LWORD)$/.test(t)) return "0";
  if (/^L?REAL$/.test(t)) return "0.0";
  if (t === "TIME") return "T#0s";
  if (t === "LTIME") return "LT#0s";
  if (/^W?STRING/.test(t)) return "''";
  return `#${p.name}`;
}
