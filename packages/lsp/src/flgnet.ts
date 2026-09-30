// SPDX-License-Identifier: BUSL-1.1
// LAD and FBD networks in SimaticML (FlgNet: parts and the wires between their pins), read for two things: the
// operands the networks use (references for the editor and the call graph) and SCL statements, so the simulator
// runs these blocks the way it runs LAD in SIMATIC SD.
import type { Ref } from "./parser.js";
import type { XmlNode } from "./simaticml.js";
import { andFlow, wrapFlow } from "./simaticsd.js";

export interface NetworkTranslation {
  /** SCL statements of all networks, in order. */
  scl: string;
  /** What the translation does not cover, per network; the simulator refuses the block with this list. */
  unsupported: string[];
  /** Bool temporaries the statements use (the power flow where a branch splits, an edge): the simulator adds them. */
  temps: string[];
  refs: Ref[];
}

const kid = (n: XmlNode | undefined, name: string) => n?.children.find((c) => c.name === name);
const kids = (n: XmlNode | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? [];

/** The networks (compile units) of a SimaticML block: LAD and FBD translated, any other language listed. */
export function translateNetworks(block: XmlNode): NetworkTranslation {
  const out: NetworkTranslation = { scl: "", unsupported: [], temps: [], refs: [] };
  const lines: string[] = [];
  let n = 0;
  for (const unit of kids(kid(block, "ObjectList"), "SW.Blocks.CompileUnit")) {
    n++;
    const attrs = kid(unit, "AttributeList");
    const source = kid(attrs, "NetworkSource");
    const net = kid(source, "FlgNet");
    if (!net) {
      if (source?.children.length) out.unsupported.push(`network ${n}: ${kid(attrs, "ProgrammingLanguage")?.text.trim() || "a"} network`);
      continue;
    }
    const network = new Network(net, out);
    out.refs.push(...network.refs());
    lines.push(`// network ${n}`);
    try {
      lines.push(...network.translate());
      if (network.missing.size) out.unsupported.push(`network ${n}: ${[...new Set(network.missing.values())].join(", ")}`);
    } catch (e) {
      out.unsupported.push(`network ${n}: ${(e as Error).message}`);
    }
  }
  out.scl = lines.join("\n") + "\n";
  return out;
}

type End = { kind: "rail" } | { kind: "ident"; uid: string } | { kind: "pin"; uid: string; pin: string };
interface Node {
  ends: End[];
}

const COMPARE: Record<string, string> = { EQ: "=", NE: "<>", GT: ">", GE: ">=", LT: "<", LE: "<=" };
const MATH: Record<string, string> = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "MOD" };
const UNARY = new Set(["ABS", "SQRT", "SQR", "LN", "EXP", "SIN", "COS", "TAN", "ASIN", "ACOS", "ATAN"]);
/** IEC timers, counters and triggers: their inputs; everything else they have is an output. */
const IEC_INPUTS: Record<string, string[]> = {
  TON: ["IN", "PT"],
  TOF: ["IN", "PT"],
  TP: ["IN", "PT"],
  TONR: ["IN", "R", "PT"],
  CTU: ["CU", "R", "PV"],
  CTD: ["CD", "LD", "PV"],
  CTUD: ["CU", "CD", "R", "LD", "PV"],
  R_TRIG: ["CLK"],
  F_TRIG: ["CLK"],
};
/** Parts whose operand (and edge memory `bit`) they write. */
const WRITES: Record<string, string[]> = {
  COIL: ["operand"],
  SCOIL: ["operand"],
  RCOIL: ["operand"],
  PCOIL: ["operand", "bit"],
  NCOIL: ["operand", "bit"],
  PCONTACT: ["bit"],
  NCONTACT: ["bit"],
  PBOX: ["bit"],
  NBOX: ["bit"],
  SR: ["operand"],
  RS: ["operand"],
  INC: ["operand"],
  DEC: ["operand"],
};
const OUTPUT_PIN = /^(out\d*|eno|q|et|cv|qu|qd|ret_val)$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Network {
  /** Parts, calls and operands by UId. */
  private readonly items = new Map<string, XmlNode>();
  private readonly pins = new Map<string, Node>();
  private readonly idents = new Map<string, Node[]>();
  private readonly done = new Map<string, Record<string, string>>();
  private readonly visiting = new Set<string>();
  private readonly splits = new Map<string, string>();
  private readonly lines: string[] = [];
  /** Parts the translation does not know, by UId. */
  readonly missing = new Map<string, string>();

  constructor(
    private readonly net: XmlNode,
    private readonly out: NetworkTranslation,
  ) {
    for (const p of kid(net, "Parts")?.children ?? []) {
      const uid = p.attrs.UId?.value;
      if (uid) this.items.set(uid, p);
    }
    for (const w of kids(kid(net, "Wires"), "Wire")) {
      const node: Node = { ends: [] };
      for (const c of w.children) {
        const uid = c.attrs.UId?.value;
        if (c.name === "Powerrail") node.ends.push({ kind: "rail" });
        else if (c.name === "IdentCon" && uid) node.ends.push({ kind: "ident", uid });
        else if (c.name === "NameCon" && uid && c.attrs.Name) node.ends.push({ kind: "pin", uid, pin: c.attrs.Name.value.toLowerCase() });
      }
      for (const e of node.ends) {
        if (e.kind === "pin") this.pins.set(`${e.uid}:${e.pin}`, node);
        else if (e.kind === "ident") this.idents.set(e.uid, [...(this.idents.get(e.uid) ?? []), node]);
      }
    }
  }

  translate(): string[] {
    // parts in the order of the export; each one first runs what feeds it
    for (const [uid, p] of this.items) if (p.name === "Part" || p.name === "Call") this.eval(uid);
    return this.lines;
  }

  /** Operand references: written where a coil, an output pin or an edge memory takes them, else read. */
  refs(): Ref[] {
    const refs: Ref[] = [];
    for (const [uid, p] of this.items) {
      if (p.name === "Access") this.accessRefs(p, this.written(uid) ? "write" : "read", refs);
      else if (p.name === "Part") {
        const inst = kid(p, "Instance");
        if (inst) this.accessRefs(inst, "call", refs);
      } else if (p.name === "Call") {
        // as SCL has them: #inst(…) and "Inst_DB"(…) call the instance, "FC"(…) the function
        const info = kid(p, "CallInfo");
        const inst = kid(info, "Instance");
        const name = info?.attrs.Name;
        if (inst) this.accessRefs(inst, "call", refs);
        else if (name) refs.push({ kind: "global", name: name.value, start: name.start, end: name.start + name.rawLength, members: [], access: "call" });
      }
    }
    return refs;
  }

  private written(uid: string): boolean {
    for (const node of this.idents.get(uid) ?? [])
      for (const e of node.ends) {
        if (e.kind !== "pin") continue;
        if (this.isOutput(e.uid, e.pin)) return true;
        const part = this.items.get(e.uid);
        if (part?.name === "Part" && WRITES[(part.attrs.Name?.value ?? "").toUpperCase()]?.includes(e.pin)) return true;
      }
    return false;
  }

  private accessRefs(a: XmlNode, access: Ref["access"], refs: Ref[]) {
    const scope = a.attrs.Scope?.value ?? "";
    const comps = kids(kid(a, "Symbol") ?? a, "Component");
    const first = comps[0]?.attrs.Name;
    if ((scope === "LocalVariable" || scope === "GlobalVariable") && first) {
      const members = comps.slice(1).flatMap((c) => (c.attrs.Name ? [{ name: c.attrs.Name.value, start: c.attrs.Name.start, end: c.attrs.Name.start + c.attrs.Name.rawLength }] : []));
      refs.push({ kind: scope === "LocalVariable" ? "local" : "global", name: first.value, start: first.start, end: first.start + first.rawLength, members, access });
    } else if (scope === "LocalConstant" || scope === "GlobalConstant") {
      const c = kid(a, "Constant")?.attrs.Name;
      if (c) refs.push({ kind: scope === "LocalConstant" ? "local" : "global", name: c.value, start: c.start, end: c.start + c.rawLength, members: [], access: "read" });
    }
    // array indices are read
    for (const c of comps) for (const i of kids(c, "Access")) this.accessRefs(i, "read", refs);
  }

  // ------------------------------------------------------------------------------------ evaluation

  private isOutput(uid: string, pin: string): boolean {
    const p = this.items.get(uid);
    if (p?.name === "Call") {
      const param = kids(kid(p, "CallInfo"), "Parameter").find((x) => x.attrs.Name?.value.toLowerCase() === pin);
      if (param) return /^(Output|Return)$/.test(param.attrs.Section?.value ?? "");
    }
    return OUTPUT_PIN.test(pin);
  }

  /** What drives the wire a pin is on: the power rail, an output pin, else an operand. */
  private driver(node: Node): End | undefined {
    return node.ends.find((e) => e.kind === "rail") ?? node.ends.find((e) => e.kind === "pin" && this.isOutput(e.uid, e.pin)) ?? node.ends.find((e) => e.kind === "ident");
  }

  private negated(uid: string, pin: string): boolean {
    return kids(this.items.get(uid), "Negated").some((n) => n.attrs.Name?.value.toLowerCase() === pin);
  }

  /** The value at an input pin (negated if the pin is), or undefined when nothing is wired to it. */
  private input(uid: string, pin: string): string | undefined {
    const node = this.pins.get(`${uid}:${pin}`);
    const d = node && this.driver(node);
    let e: string | undefined;
    if (d?.kind === "rail") e = "TRUE";
    else if (d?.kind === "ident") e = this.operand(d.uid);
    else if (d?.kind === "pin" && !(d.uid === uid && d.pin === pin)) e = this.output(d.uid, d.pin);
    return e !== undefined && this.negated(uid, pin) ? `NOT ${wrapFlow(e)}` : e;
  }

  private need(uid: string, pin: string): string {
    const e = this.input(uid, pin);
    if (e === undefined) throw new Error(`${this.items.get(uid)?.attrs.Name?.value ?? "a part"} has nothing at ${pin}`);
    return e;
  }

  /** The operands an output pin writes to. */
  private targets(uid: string, pin: string): string[] {
    const node = this.pins.get(`${uid}:${pin}`);
    return node ? node.ends.flatMap((e) => (e.kind === "ident" ? [this.operand(e.uid)] : [])) : [];
  }

  private target(uid: string, pin: string): string {
    const t = this.targets(uid, pin)[0];
    if (!t) throw new Error(`${this.items.get(uid)?.attrs.Name?.value ?? "a part"} has no operand at ${pin}`);
    return t;
  }

  /** How many part inputs an output pin feeds. */
  private consumers(uid: string, pin: string): number {
    const node = this.pins.get(`${uid}:${pin}`);
    return node ? node.ends.filter((e) => e.kind === "pin" && !(e.uid === uid && e.pin === pin) && !this.isOutput(e.uid, e.pin)).length : 0;
  }

  private output(uid: string, pin: string): string {
    const outs = this.eval(uid);
    const e = outs[pin];
    if (e === undefined) {
      if (this.missing.has(uid)) return "FALSE";
      throw new Error(`${this.items.get(uid)?.attrs.Name?.value ?? "a part"} has no output ${pin} the simulator knows`);
    }
    // a branch splits here: the power flow is taken once, as the PLC does, not again for each branch
    if (this.consumers(uid, pin) > 1 && !simple(e)) {
      const key = `${uid}:${pin}`;
      let t = this.splits.get(key);
      if (!t) this.splits.set(key, (t = this.temp(e)));
      return t;
    }
    return e;
  }

  private temp(e: string): string {
    const name = `__rung${this.out.temps.length + 1}`;
    this.out.temps.push(name);
    this.lines.push(`#${name} := ${e};`);
    return `#${name}`;
  }

  /** A flow that goes on past a part with side effects is taken before them. */
  private pass(uid: string, pin: string, flow: string): string {
    return this.consumers(uid, pin) && !simple(flow) ? this.temp(flow) : flow;
  }

  private guarded(en: string, stmts: string[]) {
    if (!stmts.length) return;
    this.lines.push(en === "TRUE" ? stmts.join(" ") : `IF ${en} THEN ${stmts.join(" ")} END_IF;`);
  }

  private eval(uid: string): Record<string, string> {
    const hit = this.done.get(uid);
    if (hit) return hit;
    if (this.visiting.has(uid)) throw new Error("the network feeds back into itself");
    this.visiting.add(uid);
    const p = this.items.get(uid)!;
    const r = p.name === "Call" ? this.call(uid, p) : p.name === "Part" ? this.part(uid, p) : {};
    this.visiting.delete(uid);
    this.done.set(uid, r);
    return r;
  }

  private part(uid: string, p: XmlNode): Record<string, string> {
    const name = p.attrs.Name?.value ?? "";
    const P = name.toUpperCase();
    const card = Number(kids(p, "TemplateValue").find((t) => t.attrs.Name?.value === "Card")?.text.trim() || 2);
    const template = (n: string) => kids(p, "TemplateValue").find((t) => t.attrs.Name?.value === n)?.text.trim();
    const numbered = (prefix: string) => Array.from({ length: card }, (_, i) => `${prefix}${i + 1}`);
    const en = () => this.input(uid, "en") ?? "TRUE";
    switch (P) {
      case "CONTACT":
        return { out: andFlow(this.input(uid, "in") ?? "FALSE", this.need(uid, "operand")) };
      case "NOT":
        return { out: `NOT ${wrapFlow(this.input(uid, "in") ?? "FALSE")}` };
      case "O":
      case "A":
      case "X": {
        const ins = numbered("in").map((i) => this.input(uid, i) ?? (P === "A" ? "TRUE" : "FALSE"));
        return { out: ins.length === 1 ? ins[0]! : ins.map(wrapFlow).join(P === "O" ? " OR " : P === "A" ? " AND " : " XOR ") };
      }
      case "COIL":
      case "SCOIL":
      case "RCOIL": {
        const target = this.target(uid, "operand");
        const flow = this.pass(uid, "out", this.input(uid, "in") ?? "FALSE");
        if (P === "COIL") this.lines.push(`${target} := ${this.negated(uid, "operand") ? `NOT ${wrapFlow(flow)}` : flow};`);
        else this.lines.push(`IF ${flow} THEN ${target} := ${P === "SCOIL" ? "TRUE" : "FALSE"}; END_IF;`);
        return { out: flow };
      }
      case "PCONTACT":
      case "NCONTACT": {
        // the operand's edge since the last scan, whatever the power flow (at `pre` in LAD; FBD has none); the
        // edge memory keeps the operand
        const op = this.need(uid, "operand");
        const bit = this.target(uid, "bit");
        const edge = this.temp(P === "PCONTACT" ? `${wrapFlow(op)} AND NOT ${bit}` : `NOT ${wrapFlow(op)} AND ${bit}`);
        this.lines.push(`${bit} := ${op};`);
        return { out: andFlow(this.input(uid, "pre") ?? "TRUE", edge) };
      }
      case "PCOIL":
      case "NCOIL": {
        // the operand is TRUE for one cycle when the power flow rises (falls); the edge memory keeps the flow
        const flow = this.temp(this.input(uid, "in") ?? "FALSE");
        const bit = this.target(uid, "bit");
        this.lines.push(`${this.target(uid, "operand")} := ${P === "PCOIL" ? `${flow} AND NOT ${bit}` : `NOT ${flow} AND ${bit}`};`, `${bit} := ${flow};`);
        return { out: flow };
      }
      case "PBOX":
      case "NBOX": {
        // P_TRIG / N_TRIG: the edge of the power flow
        const flow = this.temp(this.input(uid, "in") ?? this.input(uid, "clk") ?? "FALSE");
        const bit = this.target(uid, "bit");
        const edge = this.temp(P === "PBOX" ? `${flow} AND NOT ${bit}` : `NOT ${flow} AND ${bit}`);
        this.lines.push(`${bit} := ${flow};`);
        return { out: edge, q: edge };
      }
      case "SR":
      case "RS": {
        // SR: reset wins; RS: set wins
        const target = this.target(uid, "operand");
        const set = this.input(uid, P === "SR" ? "s" : "s1") ?? "FALSE";
        const reset = this.input(uid, P === "SR" ? "r1" : "r") ?? "FALSE";
        const s = `IF ${set} THEN ${target} := TRUE; END_IF;`;
        const r = `IF ${reset} THEN ${target} := FALSE; END_IF;`;
        this.lines.push(...(P === "SR" ? [s, r] : [r, s]));
        return { q: target };
      }
      case "INRANGE":
      case "OUTRANGE": {
        const v = wrapFlow(this.need(uid, "in"));
        const inside = `${wrapFlow(this.need(uid, "min"))} <= ${v} AND ${v} <= ${wrapFlow(this.need(uid, "max"))}`;
        return { out: andFlow(this.input(uid, "pre") ?? "TRUE", P === "INRANGE" ? inside : `NOT (${inside})`) };
      }
      case "MOVE": {
        const flow = en();
        const eno = this.pass(uid, "eno", flow);
        const v = this.need(uid, "in");
        this.guarded(eno, numbered("out").flatMap((o) => this.targets(uid, o).map((t) => `${t} := ${v};`)));
        return { eno };
      }
      case "INC":
      case "DEC": {
        const eno = this.pass(uid, "eno", en());
        const t = this.target(uid, "operand");
        this.guarded(eno, [`${t} := ${t} ${P === "INC" ? "+" : "-"} 1;`]);
        return { eno };
      }
    }
    if (COMPARE[P]) return { out: andFlow(this.input(uid, "pre") ?? "TRUE", `${wrapFlow(this.need(uid, "in1"))} ${COMPARE[P]} ${wrapFlow(this.need(uid, "in2"))}`) };
    const box = (value: () => string) => {
      const eno = this.pass(uid, "eno", en());
      const v = value();
      this.guarded(eno, this.targets(uid, "out").map((t) => `${t} := ${v};`));
      return { eno };
    };
    if (MATH[P]) return box(() => (P === "MOD" ? ["in1", "in2"] : numbered("in")).map((i) => wrapFlow(this.need(uid, i))).join(` ${MATH[P]} `));
    if (P === "NEG") return box(() => `-${wrapFlow(this.need(uid, "in"))}`);
    if (UNARY.has(P)) return box(() => `${P}(${this.need(uid, "in")})`);
    if (P === "MIN" || P === "MAX") return box(() => `${P}(${numbered("in").map((i) => `${i.toUpperCase()} := ${this.need(uid, i)}`).join(", ")})`);
    if (P === "LIMIT") return box(() => `LIMIT(MN := ${this.need(uid, "mn")}, IN := ${this.need(uid, "in")}, MX := ${this.need(uid, "mx")})`);
    if (P === "SEL") return box(() => `SEL(G := ${this.need(uid, "g")}, IN0 := ${this.need(uid, "in0")}, IN1 := ${this.need(uid, "in1")})`);
    if (P === "SHL" || P === "SHR") return box(() => `${P}(IN := ${this.need(uid, "in")}, N := ${this.need(uid, "n")})`);
    if (P === "CONVERT" || P === "ROUND" || P === "TRUNC" || P === "CEIL" || P === "FLOOR") {
      const src = template("SrcType");
      const dest = template("DestType");
      if (!src || !dest) {
        this.missing.set(uid, name);
        return {};
      }
      return box(() => {
        const v = this.need(uid, "in");
        if (P !== "CONVERT") return `${P}(${v})`;
        return src.toUpperCase() === dest.toUpperCase() ? v : `${src.toUpperCase()}_TO_${dest.toUpperCase()}(${v})`;
      });
    }
    if (IEC_INPUTS[P]) return this.iec(uid, p, P);
    this.missing.set(uid, name);
    return {};
  }

  /** TON, CTU, R_TRIG … with their instance: the inputs wired, the outputs readable as members of the instance. */
  private iec(uid: string, p: XmlNode, P: string): Record<string, string> {
    const inst = kid(p, "Instance");
    if (!inst) {
      this.missing.set(uid, `${p.attrs.Name?.value} without an instance`);
      return {};
    }
    const self = this.operandOf(inst);
    const params: string[] = [];
    for (const pin of IEC_INPUTS[P]!) {
      const v = this.input(uid, pin.toLowerCase());
      if (v !== undefined) params.push(`${pin} := ${v}`);
    }
    this.lines.push(`${self}(${params.join(", ")});`);
    const outs: Record<string, string> = {};
    for (const [key, node] of this.pins) {
      if (!key.startsWith(`${uid}:`)) continue;
      const pin = key.slice(uid.length + 1);
      if (IEC_INPUTS[P]!.some((i) => i.toLowerCase() === pin)) continue;
      outs[pin] = `${self}.${pin.toUpperCase()}`;
      for (const e of node.ends) if (e.kind === "ident") this.lines.push(`${this.operand(e.uid)} := ${self}.${pin.toUpperCase()};`);
    }
    return outs;
  }

  /** An FB with its instance or an FC: EN guards the call, ENO goes on; outputs go to their operands. */
  private call(uid: string, p: XmlNode): Record<string, string> {
    const info = kid(p, "CallInfo");
    const name = info?.attrs.Name?.value ?? "";
    const inst = kid(info, "Instance");
    const callee = inst ? this.operandOf(inst) : `"${name}"`;
    const eno = this.pass(uid, "eno", this.input(uid, "en") ?? "TRUE");
    const args: string[] = [];
    const outs: Record<string, string> = { eno };
    let ret: string | undefined;
    for (const param of kids(info, "Parameter")) {
      const pn = param.attrs.Name?.value ?? "";
      const pin = pn.toLowerCase();
      const section = param.attrs.Section?.value;
      const shown = IDENT.test(pn) ? pn : `"${pn}"`;
      if (section === "Input" || section === "InOut") {
        const v = this.input(uid, pin);
        if (v !== undefined) args.push(`${shown} := ${v}`);
      } else if (section === "Output") {
        const t = this.targets(uid, pin)[0];
        if (inst) {
          if (t) args.push(`${shown} => ${t}`);
          outs[pin] = `${callee}.${shown}`;
        } else if (t) args.push(`${shown} => ${t}`);
        else if (this.consumers(uid, pin)) {
          // an FC's Bool output that goes on as power flow: taken into a temporary
          const tmp = `__rung${this.out.temps.length + 1}`;
          this.out.temps.push(tmp);
          args.push(`${shown} => #${tmp}`);
          outs[pin] = `#${tmp}`;
        }
      } else if (section === "Return") ret = this.targets(uid, pin)[0];
    }
    const stmt = `${callee}(${args.join(", ")});`;
    this.guarded(eno, [ret ? `${ret} := ${stmt}` : stmt]);
    return outs;
  }

  private operand(uid: string): string {
    const a = this.items.get(uid);
    if (!a) throw new Error(`an operand (UId ${uid}) the network does not have`);
    return this.operandOf(a);
  }

  /** An Access (or an Instance) as SCL: #local.member, "Global".member[i], a constant, %I0.0. */
  private operandOf(a: XmlNode): string {
    const scope = a.attrs.Scope?.value ?? "";
    if (scope === "LiteralConstant" || scope === "TypedConstant") {
      const c = kid(a, "Constant");
      const v = kid(c, "ConstantValue")?.text.trim() ?? "";
      const type = kid(c, "ConstantType")?.text.trim() ?? "";
      if (/^bool$/i.test(type)) return /^(true|1)$/i.test(v) ? "TRUE" : "FALSE";
      if (/^w?(string|char)$/i.test(type) && !v.startsWith("'")) return `'${v.replace(/'/g, "$'")}'`;
      return v;
    }
    if (scope === "LocalConstant" || scope === "GlobalConstant") {
      const n = kid(a, "Constant")?.attrs.Name?.value ?? "";
      return scope === "LocalConstant" ? `#${quoted(n)}` : `"${n}"`;
    }
    if (scope === "Address") return absolute(kid(a, "Address"));
    const comps = kids(kid(a, "Symbol") ?? a, "Component");
    if (!comps.length) throw new Error(`an operand of scope ${scope || "?"} the simulator does not read`);
    return comps
      .map((c, i) => {
        const n = c.attrs.Name?.value ?? "";
        const head = i > 0 ? `.${quoted(n)}` : scope === "LocalVariable" ? `#${quoted(n)}` : `"${n}"`;
        const index = kids(c, "Access").map((x) => this.operandOf(x));
        const slice = c.attrs.SliceAccessModifier?.value;
        return head + (index.length ? `[${index.join(", ")}]` : "") + (slice ? `.%${slice.toUpperCase()}` : "");
      })
      .join("");
  }
}

const quoted = (n: string) => (IDENT.test(n) ? n : `"${n}"`);
const simple = (e: string) => /^(TRUE|FALSE|#?[\w.[\]"%]+)$/.test(e);

const AREA: Record<string, string> = { Input: "I", Output: "Q", Memory: "M" };
const WIDTH: Record<string, string> = { Byte: "B", SInt: "B", USInt: "B", Char: "B", Word: "W", Int: "W", UInt: "W", DWord: "D", DInt: "D", UDInt: "D", Real: "D" };

/** <Address Area="Input" Type="Bool" BitOffset="3"/> as %I0.3 (BitOffset counts bits). */
function absolute(ad: XmlNode | undefined): string {
  const area = AREA[ad?.attrs.Area?.value ?? ""];
  const type = ad?.attrs.Type?.value ?? "";
  const bits = Number(ad?.attrs.BitOffset?.value ?? NaN);
  if (!area || !Number.isInteger(bits)) throw new Error(`an absolute address in ${ad?.attrs.Area?.value ?? "an area"} the simulator does not read`);
  if (/^bool$/i.test(type)) return `%${area}${Math.floor(bits / 8)}.${bits % 8}`;
  const w = WIDTH[type];
  if (!w) throw new Error(`an absolute ${type} address the simulator does not read`);
  return `%${area}${w}${bits / 8}`;
}
