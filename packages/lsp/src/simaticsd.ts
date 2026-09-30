// SPDX-License-Identifier: BUSL-1.1
// LAD blocks in SIMATIC SD text (.s7dcl): the interface goes through the SCL parser, operand references come
// from the networks, and the networks are translated to SCL statements so the simulator can run LAD blocks.
import { parse, type ParsedDocument, type Ref } from "./parser.js";

const END = /\b(END_FUNCTION_BLOCK|END_FUNCTION|END_ORGANIZATION_BLOCK)\b/g;

/** Parses a .s7dcl LAD block: interface, operand references and `lad` (the networks as SCL). */
export function parseSd(text: string): ParsedDocument {
  const region = networkRegion(text);
  const blanked = blankForParser(text, region);
  const doc = parse(blanked);
  const block = doc.blocks[0];
  if (block && region) {
    block.refs.push(...operandRefs(text, region.start, region.end));
    const t = translateLad(text.slice(region.start, region.end));
    block.lad = t.scl;
    if (t.unsupported.length) block.ladUnsupported = t.unsupported;
  }
  return doc;
}

/** From the first network (or its language pragma) to the END_ keyword of the block. */
function networkRegion(text: string): { start: number; end: number } | undefined {
  // the block pragma before the header may name the language too; networks come after the header
  const header = /^[ \t]*(FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK)\b/m.exec(text);
  if (!header) return undefined;
  const re = /^[ \t]*\{\s*S7_Language\b|^[ \t]*NETWORK\b/gm;
  re.lastIndex = header.index + header[0].length;
  const first = re.exec(text);
  if (!first) return undefined;
  let end = -1;
  for (const m of text.matchAll(END)) end = m.index;
  if (end < first.index) return undefined;
  return { start: first.index, end };
}

/** Same length as the input: pragmas and networks become blanks, the networks start with BEGIN. */
function blankForParser(text: string, region: { start: number; end: number } | undefined): string {
  const chars = [...text];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
  };
  const limit = region?.start ?? text.length;
  // { … } pragmas (block attributes, instruction info) carry no interface
  for (let i = 0; i < limit; i++) {
    if (text[i] === "{") {
      const close = text.indexOf("}", i);
      if (close < 0 || close > limit) break;
      blank(i, close + 1);
      i = close;
    } else if (text[i] === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? limit : nl;
    }
  }
  if (region) {
    blank(region.start, region.end);
    chars.splice(region.start, 5, ..."BEGIN");
  }
  return chars.join("");
}

/** `#local.member`, `"Global".member` operands of the networks, with write access for coils and `=>` outputs. */
function operandRefs(text: string, from: number, to: number): Ref[] {
  const refs: Ref[] = [];
  const re = /(#[A-Za-z_][A-Za-z0-9_]*|"(?:[^"]|"")+")((?:\.(?:[A-Za-z_][A-Za-z0-9_]*|"(?:[^"]|"")+"))*)/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m && m.index < to; m = re.exec(text)) {
    const head = m[1]!;
    const start = m.index;
    const nameStart = head.startsWith("#") ? start + 1 : start + 1;
    const name = head.startsWith("#") ? head.slice(1) : head.slice(1, -1);
    const members: Ref["members"] = [];
    let at = start + head.length;
    for (const part of (m[2] ?? "").split(".").slice(1)) {
      at += 1;
      members.push({ name: part.replace(/^"|"$/g, ""), start: at, end: at + part.length });
      at += part.length;
    }
    const after = text.slice(m.index + m[0].length).match(/^\s*[{(]/);
    // #Delay.TON{…}( … ): the instance is called, TON is the instruction
    const call = after !== null;
    if (call && members.length) members.pop();
    const before = text.slice(Math.max(from, m.index - 12), m.index);
    const write = /=>\s*$/.test(before) || /\b[SRI]?_?Coil\(\s*$/.test(before) || /\bCoil\(\s*$/.test(before);
    refs.push({ kind: head.startsWith("#") ? "local" : "global", name, start: nameStart, end: nameStart + name.length, members, access: call ? "call" : write ? "write" : "read" });
  }
  return refs;
}

// ------------------------------------------------------------------------------------------ LAD → SCL

interface Item {
  kind: "wire" | "element";
  /** wire name, or the element's callee as written: Contact, #Delay.TON, "DB".FB_X */
  name: string;
  args: { pin?: string; dir?: ":=" | "=>"; expr: string }[];
  raw: string;
}

interface Rung {
  from: string;
  to?: string;
  items: Item[];
}

export interface LadTranslation {
  scl: string;
  unsupported: string[];
}

const COMPARE: Record<string, string> = { EQ: "=", NE: "<>", GT: ">", GE: ">=", LT: "<", LE: "<=" };
const IEC_BOX: Record<string, { input: string; output: string }> = {
  TON: { input: "IN", output: "Q" },
  TOF: { input: "IN", output: "Q" },
  TP: { input: "IN", output: "Q" },
  TONR: { input: "IN", output: "Q" },
  CTU: { input: "CU", output: "Q" },
  CTD: { input: "CD", output: "Q" },
  CTUD: { input: "CU", output: "QU" },
  R_TRIG: { input: "CLK", output: "Q" },
  F_TRIG: { input: "CLK", output: "Q" },
};
const MATH: Record<string, string> = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "MOD" };

/** Translates the NETWORK … END_NETWORK text of a LAD block into SCL statements. */
export function translateLad(networks: string): LadTranslation {
  const out: string[] = [];
  const unsupported: string[] = [];
  let n = 0;
  for (const m of networks.matchAll(/\bNETWORK\b([\s\S]*?)\bEND_NETWORK\b/g)) {
    n++;
    out.push(`// network ${n}`);
    try {
      out.push(...network(parseRungs(m[1]!), unsupported));
    } catch (e) {
      unsupported.push(`network ${n}: ${(e as Error).message}`);
    }
  }
  return { scl: out.join("\n") + "\n", unsupported };
}

function parseRungs(body: string): Rung[] {
  const rungs: Rung[] = [];
  const re = /\bRUNG\s+(wire#\w+)([\s\S]*?)\bEND_RUNG\b(?:[ \t]+(wire#\w+))?/g;
  for (const m of body.matchAll(re)) rungs.push({ from: m[1]!.slice(5), to: m[3]?.slice(5), items: parseItems(m[2]!) });
  if (!rungs.length && /\S/.test(body)) throw new Error("no RUNG found (FBD networks are not simulated yet)");
  return rungs;
}

function parseItems(src: string): Item[] {
  const items: Item[] = [];
  let i = 0;
  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  for (skipWs(); i < src.length; skipWs()) {
    const start = i;
    if (src.startsWith("wire#", i)) {
      const m = /^wire#(\w+)/.exec(src.slice(i))!;
      items.push({ kind: "wire", name: m[1]!, args: [], raw: m[0] });
      i += m[0].length;
      continue;
    }
    // callee: identifiers, #local, "quoted", joined by dots
    while (i < src.length && !/[{(\s]/.test(src[i]!)) {
      if (src[i] === '"') i = src.indexOf('"', i + 1) + 1 || src.length;
      else i++;
    }
    const name = src.slice(start, i);
    skipWs();
    if (src[i] === "{") i = balanced(src, i, "{", "}");
    skipWs();
    let args: Item["args"] = [];
    if (src[i] === "(") {
      const close = balanced(src, i, "(", ")");
      args = splitArgs(src.slice(i + 1, close - 1));
      i = close;
    }
    if (!name) throw new Error(`cannot read "${src.slice(start, start + 20)}"`);
    items.push({ kind: "element", name, args, raw: src.slice(start, i) });
  }
  return items;
}

/** Index after the bracket that closes the one at `at` (strings respected). */
function balanced(src: string, at: number, open: string, close: string): number {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = src.indexOf(c, i + 1);
      if (i < 0) break;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  throw new Error(`unbalanced ${open} ${close}`);
}

function splitArgs(s: string): Item["args"] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" || c === '"') {
      const j = s.indexOf(c, i + 1);
      cur += s.slice(i, j < 0 ? s.length : j + 1);
      i = j < 0 ? s.length : j;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const m = /^\s*([A-Za-z_]\w*)\s*(:=|=>)\s*([\s\S]*?)\s*$/.exec(p);
    return m ? { pin: m[1]!, dir: m[2] as ":=" | "=>", expr: m[3]! } : { expr: p.trim() };
  });
}

/** Whether the parenthesis opening `e` closes at its end: "(a OR b)" yes, "(a) AND (b)" no. */
function enclosed(e: string): boolean {
  if (!e.startsWith("(")) return false;
  let depth = 0;
  for (let i = 0; i < e.length; i++) {
    if (e[i] === "(") depth++;
    else if (e[i] === ")" && --depth === 0) return i === e.length - 1;
  }
  return false;
}
const wrap = (e: string) => (/^[#"%\w.[\]]+$/.test(e) || enclosed(e) ? e : `(${e})`);
/** OR / XOR outside any parentheses: such an expression needs parentheses as an AND operand. */
function looseOr(e: string): boolean {
  let depth = 0;
  for (let i = 0; i < e.length; i++) {
    if (e[i] === "(") depth++;
    else if (e[i] === ")") depth--;
    else if (depth === 0 && /^ (OR|XOR) /.test(e.slice(i, i + 5))) return true;
  }
  return false;
}
// the left side is usually the AND chain built so far: it only needs parentheses around a top-level OR
const and = (a: string, b: string) => (a === "TRUE" ? b : `${looseOr(a) ? `(${a})` : a} AND ${wrap(b)}`);
export { and as andFlow, wrap as wrapFlow };

function network(rungs: Rung[], unsupported: string[]): string[] {
  // split rungs into segments at the wires they pass through
  interface Segment {
    from: string;
    to?: string;
    items: Item[];
  }
  const segments: Segment[] = [];
  for (const r of rungs) {
    let seg: Segment = { from: r.from, items: [] };
    for (const it of r.items) {
      if (it.kind === "wire") {
        segments.push({ ...seg, to: it.name });
        seg = { from: it.name, items: [] };
      } else seg.items.push(it);
    }
    segments.push({ ...seg, ...(r.to ? { to: r.to } : {}) });
  }
  const incoming = new Map<string, number>();
  for (const s of segments) if (s.to) incoming.set(s.to, (incoming.get(s.to) ?? 0) + 1);
  const joined = new Map<string, string[]>();
  const value = new Map<string, string>([["powerrail", "TRUE"]]);
  const done = new Set<Segment>();
  const out: string[] = [];
  while (done.size < segments.length) {
    const next = segments.find((s) => !done.has(s) && value.has(s.from));
    if (!next) throw new Error("branches that never join (wire used before it is complete)");
    done.add(next);
    const flow = segmentFlow(value.get(next.from)!, next.items, out, unsupported);
    if (next.to) {
      const list = [...(joined.get(next.to) ?? []), flow];
      joined.set(next.to, list);
      if (list.length === incoming.get(next.to)) value.set(next.to, list.length === 1 ? list[0]! : `(${list.map(wrap).join(" OR ")})`);
    }
  }
  return out;
}

/** Emits the statements of one segment and returns the power flow at its end. */
function segmentFlow(start: string, items: Item[], out: string[], unsupported: string[]): string {
  let flow = start;
  const operand = (it: Item) => it.args[0]?.expr ?? "";
  const pin = (it: Item, name: string) => it.args.find((a) => a.pin?.toUpperCase() === name)?.expr;
  for (const it of items) {
    const callee = it.name;
    const upper = callee.toUpperCase();
    const leaf = upper.split(".").pop()!.replace(/"/g, "");
    switch (upper) {
      case "CONTACT":
        flow = and(flow, operand(it));
        continue;
      case "I_CONTACT":
        flow = and(flow, `NOT ${wrap(operand(it))}`);
        continue;
      case "NOT":
        flow = `NOT ${wrap(flow)}`;
        continue;
      case "COIL":
        out.push(`${operand(it)} := ${flow};`);
        continue;
      case "I_COIL":
        out.push(`${operand(it)} := NOT ${wrap(flow)};`);
        continue;
      case "S_COIL":
        out.push(`IF ${flow} THEN ${operand(it)} := TRUE; END_IF;`);
        continue;
      case "R_COIL":
        out.push(`IF ${flow} THEN ${operand(it)} := FALSE; END_IF;`);
        continue;
    }
    if (COMPARE[leaf] && !callee.includes(".")) {
      flow = and(flow, `${wrap(pin(it, "IN1") ?? "")} ${COMPARE[leaf]} ${wrap(pin(it, "IN2") ?? "")}`);
      continue;
    }
    if (leaf === "MOVE" && !callee.includes(".")) {
      const value = pin(it, "IN") ?? "";
      const targets = it.args.filter((a) => a.dir === "=>" && /^OUT\d*$/i.test(a.pin ?? "") && a.expr).map((a) => `${a.expr} := ${value};`);
      out.push(flow === "TRUE" ? targets.join(" ") : `IF ${flow} THEN ${targets.join(" ")} END_IF;`);
      continue;
    }
    if (MATH[leaf] && !callee.includes(".")) {
      const ins = it.args.filter((a) => /^IN\d+$/i.test(a.pin ?? "")).map((a) => wrap(a.expr));
      const target = pin(it, "OUT");
      if (target) out.push(`IF ${flow} THEN ${target} := ${ins.join(` ${MATH[leaf]} `)}; END_IF;`);
      continue;
    }
    const dot = callee.lastIndexOf(".");
    const iec = dot > 0 ? IEC_BOX[leaf] : undefined;
    if (iec) {
      // #Delay.TON(…) / "IEC_Timer_DB".TON(…): the rung drives the input pin, the output pin continues it
      const inst = callee.slice(0, dot);
      const params = [`${iec.input} := ${flow}`, ...it.args.filter((a) => a.pin && a.expr && a.pin.toUpperCase() !== iec.input).map((a) => `${a.pin} ${a.dir} ${a.expr}`)];
      out.push(`${inst}(${params.join(", ")});`);
      flow = `${inst}.${iec.output}`;
      continue;
    }
    if (dot > 0 || callee.startsWith('"')) {
      // an FB with its instance ("DB".FB_X, #Inst.FB_X) or an FC ("FC_X"): EN is the power flow, ENO continues it
      const target = dot > 0 ? callee.slice(0, dot) : callee;
      const params = it.args.filter((a) => a.pin && a.expr).map((a) => `${a.pin} ${a.dir} ${a.expr}`);
      out.push(flow === "TRUE" ? `${target}(${params.join(", ")});` : `IF ${flow} THEN ${target}(${params.join(", ")}); END_IF;`);
      continue;
    }
    unsupported.push(it.raw.replace(/\s+/g, " ").slice(0, 60));
  }
  return flow;
}
