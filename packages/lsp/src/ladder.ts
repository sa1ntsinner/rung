// SPDX-License-Identifier: BUSL-1.1
// A LAD block in SimaticML as networks an editor can draw: the power flow of each network as series and parallel
// runs of contacts, compares, boxes and coils (read-only). What cannot be drawn that way (FBD, STL, SCL networks,
// a box fed by two power flows, wiring that is no series-parallel ladder) comes with its SCL or source text instead.
import { parseXml, type XmlNode } from "./simaticml.js";
import { operandText, translateFlgNet, type NetworkTranslation } from "./flgnet.js";

export type LadderElement =
  | { k: "contact"; operand: string; negated: boolean; edge?: "P" | "N"; bit?: string }
  | { k: "coil"; operand: string; kind: "" | "S" | "R" | "P" | "N"; negated: boolean; bit?: string }
  | { k: "compare"; op: string; type?: string; in1: string; in2: string }
  | { k: "box"; name: string; instance?: string; flowIn?: string; flowOut?: string; inputs: Pin[]; outputs: Pin[] }
  | { k: "par"; branches: LadderElement[][]; merge: boolean };
export interface Pin {
  pin: string;
  operand: string;
}
export interface LadderNetwork {
  index: number;
  title: string;
  comment: string;
  language: string;
  /** The power flow from the left rail, when the network is a ladder. */
  rung?: LadderElement[];
  /** Otherwise its text: SCL or STL source, or what the simulator runs for it (SCL). */
  text?: string;
  /** Why the network is shown as text. */
  note?: string;
}
export interface LadderBlock {
  name: string;
  type: string;
  language: string;
  title: string;
  comment: string;
  networks: LadderNetwork[];
}

const kid = (n: XmlNode | undefined, name: string) => n?.children.find((c) => c.name === name);
const kids = (n: XmlNode | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? [];

/** The first text of a multilingual title or comment (TIA Portal's editing language comes first in exports). */
function multilingual(owner: XmlNode | undefined, composition: string): string {
  const text = kids(kid(owner, "ObjectList"), "MultilingualText").find((t) => t.attrs.CompositionName?.value === composition);
  for (const item of kids(kid(text, "ObjectList"), "MultilingualTextItem")) {
    const t = kid(kid(item, "AttributeList"), "Text")?.text.trim();
    if (t) return t;
  }
  return "";
}

export function ladderOf(xml: string): LadderBlock {
  const doc = parseXml(xml);
  const block = kid(kid(doc, "Document"), "SW.Blocks.OB") ?? kid(kid(doc, "Document"), "SW.Blocks.FB") ?? kid(kid(doc, "Document"), "SW.Blocks.FC");
  if (!block) throw new Error("not a SimaticML OB, FB or FC");
  const attrs = kid(block, "AttributeList");
  const result: LadderBlock = {
    name: kid(attrs, "Name")?.text.trim() ?? "",
    type: block.name.replace("SW.Blocks.", ""),
    language: kid(attrs, "ProgrammingLanguage")?.text.trim() ?? "",
    title: multilingual(block, "Title"),
    comment: multilingual(block, "Comment"),
    networks: [],
  };
  let index = 0;
  for (const unit of kids(kid(block, "ObjectList"), "SW.Blocks.CompileUnit")) {
    const ua = kid(unit, "AttributeList");
    const source = kid(ua, "NetworkSource");
    const language = kid(ua, "ProgrammingLanguage")?.text.trim() ?? result.language;
    const n: LadderNetwork = { index: ++index, title: multilingual(unit, "Title"), comment: multilingual(unit, "Comment"), language };
    const net = kid(source, "FlgNet");
    const textSource = kid(source, "StructuredText") ?? kid(source, "StatementList");
    if (net && language === "LAD") {
      try {
        n.rung = new Rung(net).draw();
      } catch (e) {
        n.note = (e as Error).message;
        n.text = sclOf(net);
      }
    } else if (net) {
      n.note = `${language} network`;
      n.text = sclOf(net);
    } else if (textSource) n.text = tokensText(textSource);
    else n.note = source?.children.length ? `${language} network` : "empty network";
    result.networks.push(n);
  }
  return result;
}

/** What the simulator runs for a network, as SCL; empty when even that is not known. */
function sclOf(net: XmlNode): string {
  const out: NetworkTranslation = { scl: "", unsupported: [], temps: [], refs: [], stl: [] };
  try {
    return translateFlgNet(net, out).lines.join("\n");
  } catch {
    return "";
  }
}

/** SCL or STL networks in SimaticML are token lists: their text, as TIA Portal shows it. */
function tokensText(n: XmlNode): string {
  let s = "";
  const walk = (x: XmlNode) => {
    if (x.name === "Blank") s += " ".repeat(Number(x.attrs.Num?.value ?? 1));
    else if (x.name === "NewLine") s += "\n".repeat(Number(x.attrs.Num?.value ?? 1));
    else if (x.name === "Token") s += x.attrs.Text?.value ?? "";
    else if (x.name === "Access") s += operandText(x);
    else if (x.name === "LineComment") s += `//${kid(x, "Text")?.text ?? ""}`;
    else if (x.name === "Comment") s += `(*${kid(x, "Text")?.text ?? ""}*)`;
    else for (const c of x.children) walk(c);
  };
  walk(n);
  return s;
}

type End = { kind: "rail" } | { kind: "ident"; uid: string } | { kind: "open" } | { kind: "pin"; uid: string; pin: string };
const FLOW_OUT = new Set(["out", "eno", "q"]);
const COMPARE: Record<string, string> = { Eq: "==", Ne: "<>", Gt: ">", Ge: ">=", Lt: "<", Le: "<=" };
const COILS: Record<string, "" | "S" | "R" | "P" | "N"> = { Coil: "", SCoil: "S", RCoil: "R", PCoil: "P", NCoil: "N" };

class Rung {
  private readonly items = new Map<string, XmlNode>();
  private readonly nets: End[][] = [];
  private readonly netOf = new Map<string, End[]>();
  private readonly used = new Set<string>();

  constructor(net: XmlNode) {
    for (const p of kid(net, "Parts")?.children ?? []) if (p.attrs.UId) this.items.set(p.attrs.UId.value, p);
    for (const w of kids(kid(net, "Wires"), "Wire")) {
      const ends: End[] = [];
      for (const c of w.children) {
        const uid = c.attrs.UId?.value;
        if (c.name === "Powerrail") ends.push({ kind: "rail" });
        else if (c.name === "OpenCon") ends.push({ kind: "open" });
        else if (c.name === "IdentCon" && uid) ends.push({ kind: "ident", uid });
        else if (c.name === "NameCon" && uid && c.attrs.Name) ends.push({ kind: "pin", uid, pin: c.attrs.Name.value });
      }
      this.nets.push(ends);
      for (const e of ends) if (e.kind === "pin") this.netOf.set(key(e.uid, e.pin), ends);
    }
  }

  /** A net carries power when no operand hangs on it: the rail, or pins wired to pins. */
  private flow(net: End[] | undefined): net is End[] {
    return !!net && net.some((e) => e.kind === "rail" || e.kind === "pin") && !net.some((e) => e.kind === "ident" || e.kind === "open");
  }

  private isOutput(uid: string, pin: string): boolean {
    const p = this.items.get(uid);
    if (p?.name === "Call") {
      const param = kids(kid(p, "CallInfo"), "Parameter").find((x) => x.attrs.Name?.value.toLowerCase() === pin.toLowerCase());
      if (param) return /^(Output|Return)$/.test(param.attrs.Section?.value ?? "");
    }
    return /^(out\d*|eno|q|et|cv|qu|qd|ret_val)$/i.test(pin);
  }

  /** The pins of a part, from the wires (a part's pins exist only as wire ends). */
  private pinsOf(uid: string): string[] {
    const pins: string[] = [];
    for (const net of this.nets) for (const e of net) if (e.kind === "pin" && e.uid === uid && !pins.includes(e.pin)) pins.push(e.pin);
    return pins;
  }

  private flowInputs(uid: string): string[] {
    return this.pinsOf(uid).filter((p) => !this.isOutput(uid, p) && this.flow(this.netOf.get(key(uid, p))));
  }

  private flowOutput(uid: string): End[] | undefined {
    const pin = this.pinsOf(uid).find((p) => this.isOutput(uid, p) && FLOW_OUT.has(p.toLowerCase()) && this.flow(this.netOf.get(key(uid, p))));
    return pin ? this.netOf.get(key(uid, pin)) : undefined;
  }

  /** The part feeding a flow net (its output pin on it), or "rail". */
  private driver(net: End[]): string {
    if (net.some((e) => e.kind === "rail")) return "rail";
    const d = net.filter((e): e is Extract<End, { kind: "pin" }> => e.kind === "pin" && this.isOutput(e.uid, e.pin));
    if (d.length !== 1) throw new Error("a wire fed by several outputs");
    return d[0]!.uid;
  }

  private consumers(net: End[]): string[] {
    const out: string[] = [];
    for (const e of net) if (e.kind === "pin" && !this.isOutput(e.uid, e.pin) && !out.includes(e.uid)) out.push(e.uid);
    return out;
  }

  draw(): LadderElement[] {
    const rails = this.nets.filter((n) => n.some((e) => e.kind === "rail"));
    if (!rails.length) throw new Error("no connection to the power rail");
    const runs = rails.map((r) => this.from(r));
    for (const [uid, p] of this.items) if ((p.name === "Part" || p.name === "Call") && !this.used.has(uid)) throw new Error(`${p.attrs.Name?.value ?? "a call"} is not on the power flow from the rail`);
    return runs.length === 1 ? runs[0]! : [{ k: "par", branches: runs, merge: false }];
  }

  /** The run that starts on a flow net, up to its end or the point where it splits. */
  private from(net: End[]): LadderElement[] {
    const run: LadderElement[] = [];
    for (let guard = 0; guard < 10_000; guard++) {
      const units = this.unitsAt(net);
      if (!units.length) return run;
      if (units.length > 1) {
        run.push({ k: "par", branches: units.map((u) => [u.element, ...(u.next ? this.from(u.next) : [])]), merge: false });
        return run;
      }
      run.push(units[0]!.element);
      if (!units[0]!.next) return run;
      net = units[0]!.next;
    }
    throw new Error("the power flow does not end");
  }

  /** What a flow net feeds: each part on it, a parallel block (an OR) that starts here as one unit. */
  private unitsAt(net: End[]): { element: LadderElement; next?: End[] }[] {
    const units: { element: LadderElement; next?: End[] }[] = [];
    const inBlocks = new Set<string>();
    for (const uid of this.consumers(net)) {
      if (inBlocks.has(uid)) continue;
      const block = this.blockFrom(net, uid);
      if (block) {
        for (const u of block.members) inBlocks.add(u);
        units.push({ element: block.element, next: block.next });
        continue;
      }
    }
    for (const uid of this.consumers(net)) {
      if (inBlocks.has(uid)) continue;
      if (this.used.has(uid)) throw new Error("wiring that is no series-parallel ladder");
      const p = this.items.get(uid)!;
      if ((p.attrs.Name?.value ?? "") === "O") continue; // an OR reached from inside its own branches
      if (this.flowInputs(uid).length > 1) throw new Error(`${p.attrs.Name?.value ?? "a box"} gets more than one power flow`);
      this.used.add(uid);
      units.push({ element: this.element(uid), next: this.flowOutput(uid) });
    }
    return units;
  }

  /**
   * The parallel block (an OR part) whose branches start on this net and one of which begins with `first` (or is
   * empty: the OR's input on the net itself). Each branch runs back from the OR to the net.
   */
  private blockFrom(start: End[], first: string): { element: LadderElement; next?: End[]; members: string[] } | undefined {
    let best: { uid: string; branches: string[][]; members: string[] } | undefined;
    for (const [uid, p] of this.items) {
      if (p.name !== "Part" || p.attrs.Name?.value !== "O" || this.used.has(uid)) continue;
      const inputs = this.flowInputs(uid).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const chains = inputs.map((pin) => this.chainBack(this.netOf.get(key(uid, pin))!));
      if (splitOf(chains) !== start) continue;
      const branches = chains.map((c) => c.parts.slice(c.nets.indexOf(start)).map((x) => x));
      // a branch can begin with a nested OR: what it begins with is then what that OR's branches begin with
      const heads = branches.flatMap((b) => (b.length ? this.heads(b[0]!) : [uid]));
      if (!heads.includes(first)) continue;
      const members = [uid, ...branches.flat()];
      // an OR nested in another one's branch starts here too: the outer one is the unit
      if (!best || members.length > best.members.length) best = { uid, branches, members };
    }
    if (!best) return undefined;
    // a part inside a branch feeds nothing else, so the block can be drawn as one unit
    for (const m of best.branches.flat()) {
      const next = this.flowOutput(m);
      if (next && this.consumers(next).length > 1) throw new Error("a branch that feeds something besides its OR");
    }
    const before = new Set(this.used);
    const drawn = best.branches.map((b) => b.map((m) => this.unit(m)));
    this.used.add(best.uid);
    // every part the block drew, nested ORs' branches included: none of them is a unit of its own here
    return { element: { k: "par", branches: drawn, merge: true }, next: this.flowOutput(best.uid), members: [...this.used].filter((u) => !before.has(u)) };
  }

  /** The parts a flow reaches first through this one: itself, or for an OR the first parts of its branches. */
  private heads(uid: string): string[] {
    if (this.items.get(uid)?.attrs.Name?.value !== "O") return [uid];
    const chains = this.flowInputs(uid).map((pin) => this.chainBack(this.netOf.get(key(uid, pin))!));
    const split = splitOf(chains)!;
    return chains.flatMap((c) => {
      const branch = c.parts.slice(c.nets.indexOf(split));
      return branch.length ? this.heads(branch[0]!) : [uid];
    });
  }

  /** An element inside a parallel branch: a part, or a nested OR block drawn where it stands. */
  private unit(uid: string): LadderElement {
    if (this.used.has(uid)) throw new Error("wiring that is no series-parallel ladder");
    const p = this.items.get(uid)!;
    if (p.attrs.Name?.value === "O") {
      const inputs = this.flowInputs(uid).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const chains = inputs.map((pin) => this.chainBack(this.netOf.get(key(uid, pin))!));
      const common = splitOf(chains)!;
      const branches = chains.map((c) => c.parts.slice(c.nets.indexOf(common)).map((m) => this.unit(m)));
      this.used.add(uid);
      return { k: "par", branches, merge: true };
    }
    this.used.add(uid);
    return this.element(uid);
  }

  /**
   * The parts from a flow net back to the rail, nearest first reversed into flow order: nets[i] is the net in front
   * of parts[i] (parts[i..] lead from nets[i] to the OR). A nested OR counts as one part.
   */
  private chainBack(net: End[]): { nets: End[][]; parts: string[] } {
    const nets: End[][] = [net];
    const parts: string[] = [];
    for (let guard = 0; guard < 10_000; guard++) {
      const d = this.driver(net);
      if (d === "rail") break;
      parts.unshift(d);
      const p = this.items.get(d)!;
      let back: End[] | undefined;
      if (p.attrs.Name?.value === "O") {
        const chains = this.flowInputs(d).map((pin) => this.chainBack(this.netOf.get(key(d, pin))!));
        back = splitOf(chains);
      } else {
        const ins = this.flowInputs(d);
        if (ins.length !== 1) throw new Error(`${p.attrs.Name?.value ?? "a box"} gets more than one power flow`);
        back = this.netOf.get(key(d, ins[0]!));
      }
      if (!back) throw new Error("a branch without a start");
      net = back;
      nets.unshift(net);
    }
    // nets runs rail-side first: nets[i] precedes parts[i]
    return { nets: nets.slice(0, parts.length + 1), parts };
  }

  /** What hangs on a data pin: its operand, "…" when open, or the box it is wired to. */
  private operandAt(uid: string, pin: string): string {
    const net = this.netOf.get(key(uid, pin));
    if (!net) return "";
    const ident = net.find((e) => e.kind === "ident") as { uid: string } | undefined;
    if (ident) return operandText(this.items.get(ident.uid)!);
    if (net.some((e) => e.kind === "open")) return "…";
    const other = net.find((e) => e.kind === "pin" && e.uid !== uid) as { uid: string; pin: string } | undefined;
    return other ? `(${this.items.get(other.uid)?.attrs.Name?.value ?? "box"}.${other.pin})` : "";
  }

  private negated(p: XmlNode, pin: string): boolean {
    return kids(p, "Negated").some((n) => n.attrs.Name?.value === pin);
  }

  private element(uid: string): LadderElement {
    const p = this.items.get(uid)!;
    const name = p.attrs.Name?.value ?? "";
    if (p.name === "Part" && (name === "Contact" || name === "PContact" || name === "NContact")) {
      const edge = name === "PContact" ? "P" : name === "NContact" ? "N" : undefined;
      return { k: "contact", operand: this.operandAt(uid, "operand"), negated: this.negated(p, "operand"), ...(edge ? { edge, bit: this.operandAt(uid, "bit") } : {}) };
    }
    if (p.name === "Part" && name in COILS) {
      const kind = COILS[name]!;
      return { k: "coil", operand: this.operandAt(uid, "operand"), kind, negated: this.negated(p, "operand"), ...(kind === "P" || kind === "N" ? { bit: this.operandAt(uid, "bit") } : {}) };
    }
    if (p.name === "Part" && name in COMPARE) {
      const type = kids(p, "TemplateValue").find((t) => t.attrs.Name?.value === "SrcType")?.text.trim();
      return { k: "compare", op: COMPARE[name]!, ...(type ? { type } : {}), in1: this.operandAt(uid, "in1"), in2: this.operandAt(uid, "in2") };
    }
    // a box: an instruction or a call
    const info = kid(p, "CallInfo");
    const inst = kid(p, "Instance") ?? kid(info, "Instance");
    const flowIn = this.flowInputs(uid)[0];
    const outNet = this.flowOutput(uid);
    const flowOut = outNet ? this.pinsOf(uid).find((x) => this.netOf.get(key(uid, x)) === outNet) : undefined;
    const pins = this.pinsOf(uid).filter((x) => x !== flowIn && x !== flowOut);
    return {
      k: "box",
      name: info?.attrs.Name?.value ?? name,
      ...(inst ? { instance: operandText(inst) } : {}),
      ...(flowIn ? { flowIn } : {}),
      ...(flowOut ? { flowOut } : {}),
      inputs: pins.filter((x) => !this.isOutput(uid, x)).map((x) => ({ pin: x, operand: this.operandAt(uid, x) })),
      outputs: pins.filter((x) => this.isOutput(uid, x)).map((x) => ({ pin: x, operand: this.operandAt(uid, x) })),
    };
  }
}

const key = (uid: string, pin: string) => `${uid}:${pin.toLowerCase()}`;
/** Where parallel branches split: the last net (nearest the OR) every branch passes. */
const splitOf = (chains: { nets: End[][] }[]) => [...chains[0]!.nets].reverse().find((n) => chains.every((c) => c.nets.includes(n)));
