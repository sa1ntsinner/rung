// SPDX-License-Identifier: BUSL-1.1
// LAD blocks in SIMATIC SD text (.s7dcl): the interface goes through the SCL parser, operand references come
// from the networks, and the networks are translated to SCL statements so the simulator can run LAD blocks.
import { parse, type ParsedDocument, type Ref } from "./parser.js";
import { translateFlgNet, type NetworkTranslation } from "./flgnet.js";
import type { XmlNode } from "./simaticml.js";

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
    if (t.temps.length) block.ladTemps = t.temps;
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
    // wire#w1 names a wire; { S7_Language := "LAD" } pragmas and { … } templates hold no operands
    if (text.slice(start - 4, start) === "wire" || text.lastIndexOf("{", start) > text.lastIndexOf("}", start)) continue;
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
  /** `{ SrcType := Int; Card := 2 }` after the callee */
  templates: Record<string, string>;
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
  /** Bool temporaries the statements use (see NetworkTranslation.temps). */
  temps: string[];
}

/**
 * Translates the NETWORK … END_NETWORK text of a LAD block into SCL statements. Each network becomes the graph of
 * parts and wires TIA Portal keeps in SimaticML, and that one translation runs it: LAD reads the same in both forms.
 */
export function translateLad(networks: string): LadTranslation {
  const out: NetworkTranslation = { scl: "", unsupported: [], temps: [], refs: [], stl: [] };
  const lines: string[] = [];
  let n = 0;
  for (const m of networks.matchAll(/\bNETWORK\b([\s\S]*?)\bEND_NETWORK\b/g)) {
    n++;
    lines.push(`// network ${n}`);
    try {
      const graph = new Graph();
      const net = graph.build(parseRungs(m[1]!));
      const t = translateFlgNet(net, out);
      lines.push(...t.lines);
      for (const uid of t.missing.keys()) out.unsupported.push(graph.raw.get(uid) ?? t.missing.get(uid)!);
    } catch (e) {
      out.unsupported.push(`network ${n}: ${(e as Error).message}`);
    }
  }
  return { scl: lines.join("\n") + "\n", unsupported: out.unsupported, temps: out.temps };
}

function parseRungs(body: string): Rung[] {
  const rungs: Rung[] = [];
  const re = /\bRUNG\s+(wire#\w+)([\s\S]*?)\bEND_RUNG\b(?:[ \t]+(wire#\w+))?/g;
  for (const m of body.matchAll(re)) rungs.push({ from: m[1]!.slice(5), to: m[3]?.slice(5), items: parseItems(m[2]!) });
  if (!rungs.length && /\S/.test(body)) throw new Error("no RUNG found (FBD networks in SD are not simulated yet)");
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
      items.push({ kind: "wire", name: m[1]!, args: [], templates: {}, raw: m[0] });
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
    const templates: Record<string, string> = {};
    if (src[i] === "{") {
      const close = balanced(src, i, "{", "}");
      for (const t of src.slice(i + 1, close - 1).split(/[;,]/)) {
        const m = /^\s*(\w+)\s*:=\s*(.*?)\s*$/.exec(t);
        if (m) templates[m[1]!] = m[2]!;
      }
      i = close;
    }
    skipWs();
    let args: Item["args"] = [];
    if (src[i] === "(") {
      const close = balanced(src, i, "(", ")");
      args = splitArgs(src.slice(i + 1, close - 1));
      i = close;
    }
    if (!name) throw new Error(`cannot read "${src.slice(start, start + 20)}"`);
    items.push({ kind: "element", name, args, templates, raw: src.slice(start, i).replace(/\s+/g, " ") });
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

// ------------------------------------------------------------------------------ SD network → FlgNet graph

type End = { kind: "rail" } | { kind: "pin"; uid: number; pin: string } | { kind: "ident"; uid: number };

const node = (name: string, attrs: Record<string, string> = {}, children: XmlNode[] = [], text = ""): XmlNode => ({
  name,
  attrs: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { value: v, start: 0, rawLength: v.length }])),
  children,
  text,
  textStart: 0,
  textRawLength: text.length,
  start: 0,
  end: 0,
});

/** The pin a LAD element takes its power flow at and gives it on at, as TIA Portal names them in SimaticML. */
const FLOW: Record<string, [string, string]> = {
  CONTACT: ["in", "out"],
  I_CONTACT: ["in", "out"],
  COIL: ["in", "out"],
  I_COIL: ["in", "out"],
  S_COIL: ["in", "out"],
  R_COIL: ["in", "out"],
  P_CONTACT: ["pre", "out"],
  N_CONTACT: ["pre", "out"],
  P_COIL: ["in", "out"],
  N_COIL: ["in", "out"],
  PBOX: ["in", "out"],
  NBOX: ["in", "out"],
  NOT: ["in", "out"],
  S_SR: ["s", "q"],
  S_RS: ["r", "q"],
};
const PART_OF: Record<string, string> = {
  CONTACT: "Contact",
  I_CONTACT: "Contact",
  COIL: "Coil",
  I_COIL: "Coil",
  S_COIL: "SCoil",
  R_COIL: "RCoil",
  P_CONTACT: "PContact",
  N_CONTACT: "NContact",
  P_COIL: "PCoil",
  N_COIL: "NCoil",
  PBOX: "PBox",
  NBOX: "NBox",
  NOT: "Not",
  S_SR: "Sr",
  S_RS: "Rs",
};
const IEC_FLOW: Record<string, [string, string]> = {
  TON: ["in", "q"],
  TOF: ["in", "q"],
  TP: ["in", "q"],
  TONR: ["in", "q"],
  CTU: ["cu", "q"],
  CTD: ["cd", "q"],
  CTUD: ["cu", "qu"],
  R_TRIG: ["clk", "q"],
  F_TRIG: ["clk", "q"],
};
const COMPARING = /^(EQ|NE|GT|GE|LT|LE|INRANGE|OUTRANGE)$/;

/** Where the last dot outside quotes is: "DB".FB_X → the dot before FB_X. */
function lastDot(name: string): number {
  let quote = false;
  let at = -1;
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '"') quote = !quote;
    else if (name[i] === "." && !quote) at = i;
  }
  return at;
}

class Graph {
  private uid = 21;
  private readonly parts: XmlNode[] = [];
  /** Wires by what drives them. */
  private readonly wires = new Map<string, { from: End; to: End[] }>();
  /** The SD text of each element, for "does not run yet". */
  readonly raw = new Map<string, string>();

  build(rungs: Rung[]): XmlNode {
    // rungs split into segments at the wires they pass through
    const segments: { from: string; to?: string; items: Item[] }[] = [];
    for (const r of rungs) {
      let seg: { from: string; to?: string; items: Item[] } = { from: r.from, items: [] };
      for (const it of r.items) {
        if (it.kind === "wire") {
          segments.push({ ...seg, to: it.name });
          seg = { from: it.name, items: [] };
        } else seg.items.push(it);
      }
      segments.push({ ...seg, ...(r.to ? { to: r.to } : {}) });
    }
    // the elements, each with the pin its flow enters and the one it leaves at
    const chains = segments.map((s) => ({ ...s, parts: s.items.map((it) => this.element(it)) }));
    // what drives each named wire: one segment, or several joined by an OR (a parallel branch)
    const drivers = new Map<string, End>([["powerrail", { kind: "rail" }]]);
    const resolving = new Set<string>();
    const driver = (w: string): End => {
      const hit = drivers.get(w);
      if (hit) return hit;
      if (resolving.has(w)) throw new Error(`wire#${w} leads into itself`);
      resolving.add(w);
      const ends = chains.filter((c) => c.to === w).map((c) => (c.parts.length ? { kind: "pin" as const, uid: c.parts.at(-1)!.uid, pin: c.parts.at(-1)!.out } : driver(c.from)));
      if (!ends.length) throw new Error(`wire#${w} is used but nothing leads into it (branches that never join)`);
      let end: End = ends[0]!;
      if (ends.length > 1) {
        const o = this.part("O", { Card: String(ends.length) });
        ends.forEach((e, i) => this.connect(e, { kind: "pin", uid: o, pin: `in${i + 1}` }));
        end = { kind: "pin", uid: o, pin: "out" };
      }
      drivers.set(w, end);
      return end;
    };
    for (const c of chains) {
      let prev = driver(c.from);
      for (const p of c.parts) {
        this.connect(prev, { kind: "pin", uid: p.uid, pin: p.in });
        for (const w of p.wired) this.connect(driver(w.wire), { kind: "pin", uid: p.uid, pin: w.pin });
        prev = { kind: "pin", uid: p.uid, pin: p.out };
      }
    }
    const endNode = (e: End) => (e.kind === "rail" ? node("Powerrail") : e.kind === "ident" ? node("IdentCon", { UId: String(e.uid) }) : node("NameCon", { UId: String(e.uid), Name: e.pin }));
    const wires = [...this.wires.values()].map((w) => node("Wire", {}, [endNode(w.from), ...w.to.map(endNode)]));
    return node("FlgNet", {}, [node("Parts", {}, this.parts), node("Wires", {}, wires)]);
  }

  private next = () => this.uid++;

  private connect(from: End, to: End) {
    const key = from.kind === "rail" ? "rail" : from.kind === "ident" ? `i${from.uid}` : `${from.uid}:${from.pin}`;
    const w = this.wires.get(key) ?? { from, to: [] };
    w.to.push(to);
    this.wires.set(key, w);
  }

  private part(name: string, templates: Record<string, string> = {}, extra: XmlNode[] = []): number {
    const uid = this.next();
    const t = Object.entries(templates).map(([k, v]) => node("TemplateValue", { Name: k, Type: k === "Card" ? "Cardinality" : "Type" }, [], v));
    this.parts.push(node("Part", { Name: name, UId: String(uid) }, [...extra, ...t]));
    return uid;
  }

  /** An operand written as SCL, as an Access of its own. */
  private operand(expr: string): End {
    const uid = this.next();
    this.parts.push(node("Access", { Scope: "Text", UId: String(uid) }, [], expr.trim()));
    return { kind: "ident", uid };
  }

  /** `pin := expr` (read) or `pin => target` (written); a wire#w as the value is a flow. */
  private arg(uid: number, pin: string, expr: string, written: boolean, wired: { pin: string; wire: string }[]) {
    const w = /^wire#(\w+)$/.exec(expr.trim());
    if (w) {
      wired.push({ pin, wire: w[1]! });
      return;
    }
    if (!expr.trim()) return; // ET => with nothing after it
    const op = this.operand(expr);
    if (written) this.connect({ kind: "pin", uid, pin }, op);
    else this.connect(op, { kind: "pin", uid, pin });
  }

  private element(it: Item): { uid: number; in: string; out: string; wired: { pin: string; wire: string }[] } {
    const upper = it.name.toUpperCase();
    const wired: { pin: string; wire: string }[] = [];
    const named = (pin: string, at: number) => it.args.find((a) => a.pin?.toUpperCase() === pin) ?? (it.args[at]?.pin ? undefined : it.args[at]);
    const done = (uid: number, flow: [string, string]) => {
      this.raw.set(String(uid), it.raw);
      return { uid, in: flow[0], out: flow[1], wired };
    };
    const part = PART_OF[upper];
    if (part) {
      const negated = upper === "I_CONTACT" || upper === "I_COIL" ? [node("Negated", { Name: "operand" })] : [];
      const uid = this.part(part, {}, negated);
      const top = named("TOP", 0);
      if (upper === "PBOX" || upper === "NBOX") this.arg(uid, "bit", it.args[0]?.expr ?? "", true, wired);
      else if (upper !== "NOT") this.arg(uid, "operand", top?.expr ?? "", false, wired);
      if (/^[PN]_(CONTACT|COIL)$/.test(upper)) this.arg(uid, "bit", named("BOTTOM", 1)?.expr ?? "", true, wired);
      if (upper === "S_SR") this.arg(uid, "r1", named("R1", 1)?.expr ?? "", false, wired);
      if (upper === "S_RS") this.arg(uid, "s1", named("S1", 1)?.expr ?? "", false, wired);
      return done(uid, FLOW[upper]!);
    }
    const dot = lastDot(it.name);
    const leaf = (dot > 0 ? it.name.slice(dot + 1) : it.name).replace(/"/g, "");
    const pins = (uid: number) => {
      for (const a of it.args) if (a.pin) this.arg(uid, a.pin.toLowerCase(), a.expr, a.dir === "=>", wired);
    };
    if (dot > 0 && IEC_FLOW[leaf.toUpperCase()]) {
      // #Delay.TON{ time_type := Time }(PT := T#3S, ET => #t): the instance, the rung drives IN
      const uid = this.part(leaf.toUpperCase(), it.templates, [node("Instance", { Scope: "Text" }, [], it.name.slice(0, dot))]);
      pins(uid);
      return done(uid, IEC_FLOW[leaf.toUpperCase()]!);
    }
    if (dot > 0 || it.name.startsWith('"')) {
      // an FB with its instance ("DB".FB_X, #Inst.FB_X) or an FC ("FC_X"): EN is the power flow, ENO goes on
      const fb = dot > 0;
      const params = it.args.filter((a) => a.pin).map((a) => node("Parameter", { Name: a.pin!, Section: a.dir === ":=" ? "Input" : /^ret_val$/i.test(a.pin!) ? "Return" : "Output" }));
      const info = node("CallInfo", { Name: fb ? leaf : it.name.replace(/"/g, ""), BlockType: fb ? "FB" : "FC" }, [...(fb ? [node("Instance", { Scope: "Text" }, [], it.name.slice(0, dot))] : []), ...params]);
      const uid = this.next();
      this.parts.push(node("Call", { UId: String(uid) }, [info]));
      pins(uid);
      return done(uid, ["en", "eno"]);
    }
    // a box by its name as TIA Portal writes it (Add, Gt, Move, Convert, InRange, …), templates and all
    const uid = this.part(it.name, it.templates);
    pins(uid);
    return done(uid, COMPARING.test(upper) ? ["pre", "out"] : ["en", "eno"]);
  }
}
