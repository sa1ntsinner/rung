// SPDX-License-Identifier: MIT
// A LAD network (rung/ladder) laid out the way TIA Portal draws it: the power rail on the left, series to the right,
// parallel branches below each other, coils at the right end. Pure geometry: the webview turns it into SVG.

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
  /** Shapes with the flow line entering at (x, y), stretched to `width` (at least w); `last`: nothing follows on its line. */
  draw(x: number, y: number, out: Shape[], width?: number, last?: boolean): void;
  /** A coil: pushed to the right end of the network. */
  end?: boolean;
  /** A box nothing follows: it stays where it is and no wire leaves it. */
  stop?: boolean;
}

const label = (s: string) => (s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + "…" : s);
const textW = (s: string) => label(s).length * CH;
const constant = (s: string) => /^([-+]?\d|'|t#|T#|time#|16#|2#|8#|true$|false$)/i.test(s);
const operandCls = (s: string) => (constant(s) ? "lad-const" : "lad-operand");
const text = (x: number, y: number, s: string, cls: string, anchor: "start" | "middle" | "end" = "middle"): Shape => ({ t: "text", x, y, s: label(s), anchor, cls, ...(label(s) !== s ? { full: s } : {}) });

/** A leaf drawn wider than it is: the wire goes in front of what ends the flow (coils line up right), else after. */
function leaf(b: Box): Box {
  const draw = b.draw;
  return {
    ...b,
    draw(x, y, out, width = b.w, last = false) {
      const extra = width - b.w;
      if (extra <= 0) return draw(x, y, out, b.w, last);
      if (b.end) {
        out.push({ t: "line", x1: x, y1: y, x2: x + extra, y2: y });
        draw(x + extra, y, out, b.w, last);
      } else {
        draw(x, y, out, b.w, last);
        if (!b.stop) out.push({ t: "line", x1: x + b.w, y1: y, x2: x + width, y2: y });
      }
    },
  };
}

function contact(e: Extract<LadderElement, { k: "contact" }>): Box {
  const w = Math.max(64, textW(e.operand) + 8, e.bit ? textW(e.bit) + 8 : 0);
  return {
    w,
    above: 30,
    below: e.bit ? 30 : 14,
    draw(x, y, out) {
      const c = x + w / 2;
      out.push({ t: "line", x1: x, y1: y, x2: c - 7, y2: y }, { t: "line", x1: c + 7, y1: y, x2: x + w, y2: y });
      out.push({ t: "line", x1: c - 7, y1: y - 11, x2: c - 7, y2: y + 11, cls: "lad-sym" }, { t: "line", x1: c + 7, y1: y - 11, x2: c + 7, y2: y + 11, cls: "lad-sym" });
      if (e.negated) out.push({ t: "line", x1: c - 5, y1: y + 9, x2: c + 5, y2: y - 9, cls: "lad-sym" });
      if (e.edge) out.push(text(c, y + 4, e.edge, "lad-letter"));
      out.push(text(c, y - 17, e.operand, operandCls(e.operand)));
      if (e.bit) out.push(text(c, y + 26, e.bit, "lad-operand lad-small"));
    },
  };
}

function coil(e: Extract<LadderElement, { k: "coil" }>): Box {
  const w = Math.max(64, textW(e.operand) + 8, e.bit ? textW(e.bit) + 8 : 0);
  return {
    w,
    above: 30,
    below: e.bit ? 30 : 14,
    end: true,
    draw(x, y, out, _w, last) {
      const c = x + w / 2;
      // no right rail in TIA Portal's LAD: the line ends at the last coil, or goes on to the next one
      out.push({ t: "line", x1: x, y1: y, x2: c - 9, y2: y });
      if (!last) out.push({ t: "line", x1: c + 9, y1: y, x2: x + w, y2: y });
      out.push({ t: "path", d: `M ${c - 5} ${y - 11} Q ${c - 12} ${y} ${c - 5} ${y + 11}`, cls: "lad-sym" }, { t: "path", d: `M ${c + 5} ${y - 11} Q ${c + 12} ${y} ${c + 5} ${y + 11}`, cls: "lad-sym" });
      const letter = (e.negated ? "/" : "") + e.kind;
      if (letter) out.push(text(c, y + 4, letter, "lad-letter"));
      out.push(text(c, y - 17, e.operand, operandCls(e.operand)));
      if (e.bit) out.push(text(c, y + 26, e.bit, "lad-operand lad-small"));
    },
  };
}

function compare(e: Extract<LadderElement, { k: "compare" }>): Box {
  const w = Math.max(72, textW(e.in1) + 8, textW(e.in2) + 8);
  return {
    w,
    above: 30,
    below: 40,
    draw(x, y, out) {
      const c = x + w / 2;
      out.push({ t: "line", x1: x, y1: y, x2: c - 20, y2: y }, { t: "line", x1: c + 20, y1: y, x2: x + w, y2: y });
      out.push({ t: "rect", x: c - 20, y: y - 11, w: 40, h: 34, cls: "lad-box" });
      out.push(text(c, y + 4, e.op, "lad-letter"));
      if (e.type) out.push(text(c, y + 18, e.type, "lad-small lad-muted"));
      out.push(text(c, y - 17, e.in1, operandCls(e.in1)));
      out.push(text(c, y + 36, e.in2, operandCls(e.in2)));
    },
  };
}

function box(e: Extract<LadderElement, { k: "box" }>): Box {
  const rows = Math.max(1, e.inputs.length, e.outputs.length);
  const pinW = (p: Pin) => (p.pin.length + 1) * CH + textW(p.operand);
  const inner = Math.max(textW(e.name) + 16, ...e.inputs.map(pinW), 0) + Math.max(...e.outputs.map(pinW), 0) + 24;
  const bw = Math.max(110, inner);
  const w = bw + 2 * GAP;
  const top = e.instance ? 34 : 20;
  return {
    w,
    above: top + 10,
    below: 22 + rows * 18,
    stop: !e.flowOut,
    draw(x, y, out) {
      const bx = x + GAP;
      out.push({ t: "line", x1: x, y1: y, x2: bx, y2: y });
      if (e.flowOut) out.push({ t: "line", x1: bx + bw, y1: y, x2: x + w, y2: y });
      out.push({ t: "rect", x: bx, y: y - 18, w: bw, h: 30 + rows * 18, cls: "lad-box" });
      out.push(text(bx + bw / 2, y - 4, e.name, "lad-boxname"));
      if (e.instance) out.push(text(bx + bw / 2, y - 24, e.instance, operandCls(e.instance)));
      if (e.flowIn) out.push(text(bx + 4, y + 4, e.flowIn.toUpperCase(), "lad-pin", "start"));
      if (e.flowOut) out.push(text(bx + bw - 4, y + 4, e.flowOut.toUpperCase(), "lad-pin", "end"));
      e.inputs.forEach((p, i) => {
        const ry = y + 22 + i * 18;
        out.push(text(bx + 4, ry, p.pin.toUpperCase(), "lad-pin", "start"));
        out.push(text(bx + 4 + (p.pin.length + 1) * CH, ry, p.operand, operandCls(p.operand), "start"));
      });
      e.outputs.forEach((p, i) => {
        const ry = y + 22 + i * 18;
        out.push(text(bx + bw - 4, ry, p.pin.toUpperCase(), "lad-pin", "end"));
        out.push(text(bx + bw - 4 - (p.pin.length + 1) * CH, ry, p.operand, operandCls(p.operand), "end"));
      });
    },
  };
}

function series(items: LadderElement[]): Box {
  const parts = items.map(element);
  const w = parts.reduce((s, p) => s + p.w, 0) + GAP * Math.max(0, parts.length - 1);
  return {
    w,
    above: Math.max(0, ...parts.map((p) => p.above)),
    below: Math.max(0, ...parts.map((p) => p.below)),
    end: parts.at(-1)?.end,
    stop: parts.at(-1)?.stop,
    draw(x, y, out, width = w, lastRun = true) {
      const extra = width - w;
      parts.forEach((p, i) => {
        if (i) out.push({ t: "line", x1: x, y1: y, x2: x + GAP, y2: y });
        if (i) x += GAP;
        // the last element takes the extra width when it ends the flow (its coils move right), else a wire follows
        const last = i === parts.length - 1;
        const pw = last && p.end ? p.w + Math.max(0, extra) : p.w;
        p.draw(x, y, out, pw, last && lastRun);
        x += pw;
      });
      if (extra > 0 && !parts.at(-1)?.end && !parts.at(-1)?.stop) out.push({ t: "line", x1: x, y1: y, x2: x + extra, y2: y });
    },
  };
}

function parallel(e: Extract<LadderElement, { k: "par" }>): Box {
  const runs: Box[] = e.branches.map((b) => (b.length ? series(b) : { w: 0, above: 0, below: 0, draw() {} }));
  const pad = 10;
  const inner = Math.max(0, ...runs.map((r) => r.w));
  const w = inner + 2 * pad;
  const offsets: number[] = [];
  let off = 0;
  runs.forEach((r, i) => {
    if (i) off += runs[i - 1]!.below + VGAP + r.above;
    offsets.push(off);
  });
  return {
    w,
    above: runs[0]?.above ?? 0,
    below: off + (runs.at(-1)?.below ?? 0),
    end: !e.merge,
    draw(x, y, out, width = w) {
      // branches that end in coils use all the width they get; joined branches keep theirs, a wire follows the join
      const span = width - pad;
      const last = y + (offsets.at(-1) ?? 0);
      out.push({ t: "line", x1: x, y1: y, x2: x, y2: last });
      if (e.merge) out.push({ t: "line", x1: x + w, y1: y, x2: x + w, y2: last });
      runs.forEach((r, i) => {
        const by = y + offsets[i]!;
        out.push({ t: "line", x1: x, y1: by, x2: x + pad, y2: by });
        r.draw(x + pad, by, out, e.merge ? r.w : span, !e.merge);
        if (e.merge) out.push({ t: "line", x1: x + pad + r.w, y1: by, x2: x + w, y2: by });
      });
      if (e.merge && width > w) out.push({ t: "line", x1: x + w, y1: y, x2: x + width, y2: y });
    },
  };
}

function element(e: LadderElement): Box {
  if (e.k === "contact") return leaf(contact(e));
  if (e.k === "coil") return leaf(coil(e));
  if (e.k === "compare") return leaf(compare(e));
  if (e.k === "box") return leaf(box(e));
  return parallel(e);
}

/** A network's shapes and size; `minWidth` lines its coils up with the widest network of the block. */
export function layoutRung(rung: LadderElement[], minWidth = 0): { shapes: Shape[]; width: number; height: number } {
  const run = series(rung);
  const width = Math.max(minWidth, RAIL + GAP + run.w + 8);
  const shapes: Shape[] = [];
  const y = run.above + 8;
  const height = y + run.below + 8;
  shapes.push({ t: "line", x1: RAIL, y1: 0, x2: RAIL, y2: height, cls: "lad-rail" });
  shapes.push({ t: "line", x1: RAIL, y1: y, x2: RAIL + GAP, y2: y });
  run.draw(RAIL + GAP, y, shapes, width - RAIL - GAP - 8);
  return { shapes, width, height };
}

/** The width a network needs: the view draws every network at the widest one's width. */
export function rungWidth(rung: LadderElement[]): number {
  return RAIL + GAP + series(rung).w + 8;
}
