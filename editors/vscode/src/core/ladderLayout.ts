// SPDX-License-Identifier: MIT
// A LAD network (rung/ladder) laid out the way TIA Portal draws it: the power rail on the left, series to the right,
// parallel branches below each other, coils at the right end. With values from the PLC it is TIA Portal's monitoring:
// where power flows the line is green, where it does not it is dashed, operands show their values. Pure geometry:
// the webview turns it into SVG.

export type LadderElement =
  | { k: "contact"; operand: string; negated: boolean; edge?: "P" | "N"; bit?: string }
  | { k: "coil"; operand: string; kind: "" | "S" | "R" | "P" | "N"; negated: boolean; bit?: string }
  | { k: "compare"; op: string; type?: string; in1: string; in2: string }
  | { k: "box"; name: string; instance?: string; flowIn?: string; flowOut?: string; inputs: Pin[]; outputs: Pin[] }
  | { k: "par"; branches: LadderElement[][]; merge: boolean };
/** Spoken network elements, including series and parallel connections. */
export function describeRung(rung: LadderElement[]): string {
  return rung.map(e => {
    if (e.k === "contact") return (e.negated ? "not " : "") + e.operand + (e.edge ? " (" + e.edge + " edge)" : "");
    if (e.k === "coil") return "coil " + e.operand + (e.kind ? " (" + e.kind + ")" : "") + (e.negated ? " inverted" : "");
    if (e.k === "par") return "(" + e.branches.map(describeRung).join(" or ") + ")";
    if (e.k === "compare") return e.in1 + " " + e.op + " " + e.in2;
    return "call " + (e.instance ?? e.name) + ": " + [...e.inputs, ...e.outputs].map(p => p.pin + " " + p.operand).join(", ");
  }).join(", and ");
}

export interface Pin {
  pin: string;
  operand: string;
}
export interface LadderNetwork {
  index: number;
  title: string;
  comment: string;
  language: string;
  rung?: LadderElement[];
  text?: string;
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

export type Shape =
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; cls?: string }
  | { t: "text"; x: number; y: number; s: string; anchor?: "start" | "middle" | "end"; cls: string; full?: string }
  | { t: "rect"; x: number; y: number; w: number; h: number; cls: string }
  | { t: "path"; d: string; cls: string };

/** A value read from the PLC by the operand's text, or undefined when it is not known. */
export type Values = (operand: string) => unknown;
/** Power on a line: flows, does not flow, or not known (no values, or an operand without one). */
type Power = boolean | undefined;

/** Approximate width of monospace-ish 12px text: labels are cut to fit their element, the full text is the title. */
const CH = 7;
const MAX_LABEL = 26;
const GAP = 14; // wire between elements
const VGAP = 18; // between parallel branches
const RAIL = 10;

interface Box {
  w: number;
  above: number;
  below: number;
  /** What leaves the element when `p` enters it. */
  out(p: Power): Power;
  /** Shapes with the flow line entering at (x, y), stretched to `width` (at least w); `last`: nothing follows on its line. */
  draw(x: number, y: number, shapes: Shape[], p: Power, width?: number, last?: boolean): void;
  /** A coil: pushed to the right end of the network. */
  end?: boolean;
  /** A box nothing follows: it stays where it is and no wire leaves it. */
  stop?: boolean;
}

const and = (a: Power, b: Power): Power => (a === false || b === false ? false : a === true && b === true ? true : undefined);
const or = (ps: Power[]): Power => (ps.includes(true) ? true : ps.every((p) => p === false) ? false : undefined);
const truth = (v: unknown): Power => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : typeof v === "string" && /^(true|false)$/i.test(v) ? /^true$/i.test(v) : undefined);
const wire = (x1: number, x2: number, y: number, p: Power): Shape => ({ t: "line", x1, y1: y, x2, y2: y, ...(p === true ? { cls: "lad-on" } : p === false ? { cls: "lad-off" } : {}) });
const sym = (p: Power) => (p === true ? "lad-sym lad-on" : "lad-sym");

const label = (s: string) => (s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + "…" : s);
const textW = (s: string) => label(s).length * CH;
const constant = (s: string) => /^([-+]?\d|'|t#|T#|time#|16#|2#|8#|true$|false$)/i.test(s);
const operandCls = (s: string) => (constant(s) ? "lad-const" : "lad-operand");
const text = (x: number, y: number, s: string, cls: string, anchor: "start" | "middle" | "end" = "middle"): Shape => ({ t: "text", x, y, s: label(s), anchor, cls, ...(label(s) !== s ? { full: s } : {}) });
/** "37", "T#2S500MS": a value as it stands next to its operand (booleans show as the line's colour instead). */
const shown = (v: unknown) => (v === undefined || typeof v === "boolean" ? undefined : typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v).slice(0, 24));

/** The names to read from the PLC for a network: tags and DB members, not constants, temporaries or open pins. */
export function operandsOf(rung: LadderElement[]): string[] {
  const names = new Set<string>();
  const add = (s: string | undefined) => {
    if (s && !constant(s) && !s.startsWith("#") && s !== "…" && !s.startsWith("(")) names.add(s);
  };
  const walk = (els: LadderElement[]) => {
    for (const e of els) {
      if (e.k === "contact" || e.k === "coil") add(e.operand);
      else if (e.k === "compare") (add(e.in1), add(e.in2));
      else if (e.k === "box") {
        for (const p of [...e.inputs, ...e.outputs]) add(p.operand);
        if (e.instance && e.flowOut && /^q$/i.test(e.flowOut)) add(`${e.instance}.Q`);
      } else for (const b of e.branches) walk(b);
    }
  };
  walk(rung);
  return [...names];
}

/** A leaf drawn wider than it is: the wire goes in front of what ends the flow (coils line up right), else after. */
function leaf(b: Box): Box {
  return {
    ...b,
    draw(x, y, shapes, p, width = b.w, last = false) {
      const extra = width - b.w;
      if (extra <= 0) return b.draw(x, y, shapes, p, b.w, last);
      if (b.end) {
        shapes.push(wire(x, x + extra, y, p));
        b.draw(x + extra, y, shapes, p, b.w, last);
      } else {
        b.draw(x, y, shapes, p, b.w, last);
        if (!b.stop) shapes.push(wire(x + b.w, x + width, y, b.out(p)));
      }
    },
  };
}

function contact(e: Extract<LadderElement, { k: "contact" }>, values: Values): Box {
  const w = Math.max(64, textW(e.operand) + 8, e.bit ? textW(e.bit) + 8 : 0);
  const v = truth(values(e.operand));
  // an edge passes for one cycle only: what it lets through is not known from a sample
  const closed: Power = e.edge ? undefined : v === undefined ? undefined : v !== e.negated;
  const out = (p: Power) => (e.edge ? (p === false ? false : undefined) : and(p, closed));
  return {
    w,
    above: 30,
    below: e.bit ? 30 : 14,
    out,
    draw(x, y, shapes, p) {
      const c = x + w / 2;
      shapes.push(wire(x, c - 7, y, p), wire(c + 7, x + w, y, out(p)));
      shapes.push({ t: "line", x1: c - 7, y1: y - 11, x2: c - 7, y2: y + 11, cls: sym(closed) }, { t: "line", x1: c + 7, y1: y - 11, x2: c + 7, y2: y + 11, cls: sym(closed) });
      if (e.negated) shapes.push({ t: "line", x1: c - 5, y1: y + 9, x2: c + 5, y2: y - 9, cls: sym(closed) });
      if (e.edge) shapes.push(text(c, y + 4, e.edge, "lad-letter"));
      shapes.push(text(c, y - 17, e.operand, operandCls(e.operand)));
      if (e.bit) shapes.push(text(c, y + 26, e.bit, "lad-operand lad-small"));
    },
  };
}

function coil(e: Extract<LadderElement, { k: "coil" }>, values: Values): Box {
  const w = Math.max(64, textW(e.operand) + 8, e.bit ? textW(e.bit) + 8 : 0);
  // the coil shows its operand's state (a set coil keeps it after the power is gone)
  const state = truth(values(e.operand));
  return {
    w,
    above: 30,
    below: e.bit ? 30 : 14,
    end: true,
    out: (p) => p,
    draw(x, y, shapes, p, _w, last) {
      const c = x + w / 2;
      // no right rail in TIA Portal's LAD: the line ends at the last coil, or goes on to the next one
      shapes.push(wire(x, c - 9, y, p));
      if (!last) shapes.push(wire(c + 9, x + w, y, p));
      shapes.push({ t: "path", d: `M ${c - 5} ${y - 11} Q ${c - 12} ${y} ${c - 5} ${y + 11}`, cls: sym(state) }, { t: "path", d: `M ${c + 5} ${y - 11} Q ${c + 12} ${y} ${c + 5} ${y + 11}`, cls: sym(state) });
      const letter = (e.negated ? "/" : "") + e.kind;
      if (letter) shapes.push(text(c, y + 4, letter, "lad-letter"));
      shapes.push(text(c, y - 17, e.operand, operandCls(e.operand)));
      if (e.bit) shapes.push(text(c, y + 26, e.bit, "lad-operand lad-small"));
    },
  };
}

const COMPARE: Record<string, (a: number, b: number) => boolean> = { "==": (a, b) => a === b, "<>": (a, b) => a !== b, ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b, "<=": (a, b) => a <= b };
/** A number from a value or an integer/real constant; anything else (times, strings) is not compared here. */
const numberOf = (operand: string, values: Values): number | undefined => {
  const v = constant(operand) ? (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(operand) ? Number(operand) : undefined) : values(operand);
  return typeof v === "number" ? v : undefined;
};

function compare(e: Extract<LadderElement, { k: "compare" }>, values: Values): Box {
  const v1 = shown(values(e.in1)), v2 = shown(values(e.in2));
  // room for a value of six characters on both sides of the name: the drawing keeps still while the number changes
  const room = (v: string | undefined) => (v ? 2 * (Math.max(6, v.length) * CH + 8) : 0);
  const w = Math.max(72, textW(e.in1) + 8 + room(v1), textW(e.in2) + 8 + room(v2));
  const a = numberOf(e.in1, values), b = numberOf(e.in2, values);
  const result: Power = a === undefined || b === undefined || !COMPARE[e.op] ? undefined : COMPARE[e.op]!(a, b);
  const out = (p: Power) => and(p, result);
  return {
    w,
    above: 30,
    below: 40,
    out,
    draw(x, y, shapes, p) {
      const c = x + w / 2;
      shapes.push(wire(x, c - 20, y, p), wire(c + 20, x + w, y, out(p)));
      shapes.push({ t: "rect", x: c - 20, y: y - 11, w: 40, h: 34, cls: result === true ? "lad-box lad-on" : "lad-box" });
      shapes.push(text(c, y + 4, e.op, "lad-letter"));
      if (e.type) shapes.push(text(c, y + 18, e.type, "lad-small lad-muted"));
      shapes.push(text(c, y - 17, e.in1, operandCls(e.in1)));
      shapes.push(text(c, y + 36, e.in2, operandCls(e.in2)));
      // each value beside its operand's name, as TIA Portal's monitoring shows it, never over the wire
      if (v1) shapes.push(text(c + textW(e.in1) / 2 + 8, y - 17, v1, "lad-value", "start"));
      if (v2) shapes.push(text(c + textW(e.in2) / 2 + 8, y + 36, v2, "lad-value", "start"));
    },
  };
}

function box(e: Extract<LadderElement, { k: "box" }>, values: Values): Box {
  const rows = Math.max(1, e.inputs.length, e.outputs.length);
  const value = (p: Pin) => (constant(p.operand) ? undefined : shown(values(p.operand)));
  const pinText = (p: Pin) => (value(p) ? `${p.operand} = ${value(p)}` : p.operand);
  const pinW = (p: Pin) => (p.pin.length + 1) * CH + Math.min(textW(pinText(p)), MAX_LABEL * CH + 10 * CH);
  const inner = Math.max(textW(e.name) + 16, ...e.inputs.map(pinW), 0) + Math.max(...e.outputs.map(pinW), 0) + 24;
  const bw = Math.max(110, inner);
  const w = bw + 2 * GAP;
  const top = e.instance ? 34 : 20;
  // a timer's Q or a trigger's Q is its instance's output; anything else passes on what enables it (ENO = EN)
  const q = e.instance && e.flowOut && /^q$/i.test(e.flowOut) ? truth(values(`${e.instance}.Q`)) : undefined;
  const out = (p: Power) => (q !== undefined ? q : p);
  const valueText = (x: number, y: number, p: Pin, anchor: "start" | "end") => {
    const v = value(p);
    // the operand cut to fit, its value after it: "Tank_Level_Percent" = 37
    return [text(x, y, p.operand, operandCls(p.operand), anchor), ...(v ? [text(anchor === "start" ? x + textW(p.operand) + CH : x - textW(p.operand) - CH, y, `= ${v}`, "lad-value", anchor)] : [])];
  };
  return {
    w,
    above: top + 10,
    below: 22 + rows * 18,
    stop: !e.flowOut,
    out,
    draw(x, y, shapes, p) {
      const bx = x + GAP;
      shapes.push(wire(x, bx, y, p));
      if (e.flowOut) shapes.push(wire(bx + bw, x + w, y, out(p)));
      shapes.push({ t: "rect", x: bx, y: y - 18, w: bw, h: 30 + rows * 18, cls: p === true ? "lad-box lad-on" : "lad-box" });
      shapes.push(text(bx + bw / 2, y - 4, e.name, "lad-boxname"));
      if (e.instance) shapes.push(text(bx + bw / 2, y - 24, e.instance, operandCls(e.instance)));
      if (e.flowIn) shapes.push(text(bx + 4, y + 4, e.flowIn.toUpperCase(), "lad-pin", "start"));
      if (e.flowOut) shapes.push(text(bx + bw - 4, y + 4, e.flowOut.toUpperCase(), "lad-pin", "end"));
      e.inputs.forEach((pin, i) => {
        const ry = y + 22 + i * 18;
        shapes.push(text(bx + 4, ry, pin.pin.toUpperCase(), "lad-pin", "start"), ...valueText(bx + 4 + (pin.pin.length + 1) * CH, ry, pin, "start"));
      });
      e.outputs.forEach((pin, i) => {
        const ry = y + 22 + i * 18;
        shapes.push(text(bx + bw - 4, ry, pin.pin.toUpperCase(), "lad-pin", "end"), ...valueText(bx + bw - 4 - (pin.pin.length + 1) * CH, ry, pin, "end"));
      });
    },
  };
}

function series(items: LadderElement[], values: Values): Box {
  const parts = items.map((e) => element(e, values));
  const w = parts.reduce((s, p) => s + p.w, 0) + GAP * Math.max(0, parts.length - 1);
  const out = (p: Power) => parts.reduce((q, part) => part.out(q), p);
  return {
    w,
    above: Math.max(0, ...parts.map((p) => p.above)),
    below: Math.max(0, ...parts.map((p) => p.below)),
    end: parts.at(-1)?.end,
    stop: parts.at(-1)?.stop,
    out,
    draw(x, y, shapes, p, width = w, lastRun = true) {
      const extra = width - w;
      let q = p;
      parts.forEach((part, i) => {
        if (i) shapes.push(wire(x, x + GAP, y, q));
        if (i) x += GAP;
        // the last element takes the extra width when it ends the flow (its coils move right), else a wire follows
        const last = i === parts.length - 1;
        const pw = last && part.end ? part.w + Math.max(0, extra) : part.w;
        part.draw(x, y, shapes, q, pw, last && lastRun);
        q = part.out(q);
        x += pw;
      });
      if (extra > 0 && !parts.at(-1)?.end && !parts.at(-1)?.stop) shapes.push(wire(x, x + extra, y, q));
    },
  };
}

function parallel(e: Extract<LadderElement, { k: "par" }>, values: Values): Box {
  const empty: Box = { w: 0, above: 0, below: 0, out: (p) => p, draw() {} };
  const runs = e.branches.map((b) => (b.length ? series(b, values) : empty));
  const pad = 10;
  const inner = Math.max(0, ...runs.map((r) => r.w));
  const w = inner + 2 * pad;
  const offsets: number[] = [];
  let off = 0;
  runs.forEach((r, i) => {
    if (i) off += runs[i - 1]!.below + VGAP + r.above;
    offsets.push(off);
  });
  // joined branches give an OR; branches that end in coils pass on what reached the split
  const out = (p: Power) => (e.merge ? or(runs.map((r) => r.out(p))) : p);
  return {
    w,
    above: runs[0]?.above ?? 0,
    below: off + (runs.at(-1)?.below ?? 0),
    end: !e.merge,
    out,
    draw(x, y, shapes, p, width = w) {
      const span = width - pad;
      const last = y + (offsets.at(-1) ?? 0);
      const join = out(p);
      shapes.push({ t: "line", x1: x, y1: y, x2: x, y2: last, ...(p === true ? { cls: "lad-on" } : {}) });
      if (e.merge) shapes.push({ t: "line", x1: x + w, y1: y, x2: x + w, y2: last, ...(join === true ? { cls: "lad-on" } : {}) });
      runs.forEach((r, i) => {
        const by = y + offsets[i]!;
        shapes.push(wire(x, x + pad, by, p));
        r.draw(x + pad, by, shapes, p, e.merge ? r.w : span, !e.merge);
        if (e.merge) shapes.push(wire(x + pad + r.w, x + w, by, r.out(p)));
      });
      if (e.merge && width > w) shapes.push(wire(x + w, x + width, y, join));
    },
  };
}

function element(e: LadderElement, values: Values): Box {
  if (e.k === "contact") return leaf(contact(e, values));
  if (e.k === "coil") return leaf(coil(e, values));
  if (e.k === "compare") return leaf(compare(e, values));
  if (e.k === "box") return leaf(box(e, values));
  return parallel(e, values);
}

const none: Values = () => undefined;

/**
 * A network's shapes and size; `minWidth` puts its coils at that edge. With `values` (from the PLC) the lines carry
 * power from the rail, which is always on.
 */
export function layoutRung(rung: LadderElement[], minWidth = 0, values?: Values): { shapes: Shape[]; width: number; height: number } {
  const run = series(rung, values ?? none);
  const width = Math.max(minWidth, RAIL + GAP + run.w + 8);
  const shapes: Shape[] = [];
  const y = run.above + 8;
  const height = y + run.below + 8;
  const p: Power = values ? true : undefined;
  shapes.push({ t: "line", x1: RAIL, y1: 0, x2: RAIL, y2: height, cls: values ? "lad-rail lad-on" : "lad-rail" });
  shapes.push(wire(RAIL, RAIL + GAP, y, p));
  run.draw(RAIL + GAP, y, shapes, p, width - RAIL - GAP - 8);
  return { shapes, width, height };
}

/** The width a network needs. */
export function rungWidth(rung: LadderElement[]): number {
  return RAIL + GAP + series(rung, none).w + 8;
}
