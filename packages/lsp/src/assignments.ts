// SPDX-License-Identifier: BUSL-1.1
// The assignment list, like TIA Portal's: which inputs, outputs and memory bits the program uses, through which
// tag and where the code uses an address directly, and which of them overlap (%MW10 and %M10.3 share byte 10).
import type { WorkspaceIndex } from "./workspace.js";

export type Area = "I" | "Q" | "M";

export interface Assignment {
  /** As written, normalised: %I0.0, %MW10, %QB4 */
  address: string;
  area: Area;
  byte: number;
  /** For a single bit. */
  bit?: number;
  /** 1, 8, 16, 32 or 64 */
  bits: number;
  /** Peripheral access (:P): straight to the module, not through the process image. */
  peripheral?: boolean;
  tags: { name: string; table: string; dataType: string }[];
  /** Where the code names the address itself (or the tag): workspace URIs and 0-based lines. */
  uses: { uri: string; line: number }[];
}

export interface Overlap {
  a: string;
  b: string;
  /** Bytes both occupy. */
  bytes: number[];
  /** One lies inside the other (%IB200 and %I200.1: a status byte read whole and by bit, often on purpose); else they cross (%MW10 and %MW11), usually a mistake. */
  nested: boolean;
}

const ADDRESS = /^%([IEQAM])([XBWDL])?(\d+)(?:\.([0-7]))?(:P)?$/i;
const SIZE: Record<string, number> = { X: 1, B: 8, W: 16, D: 32, L: 64 };

/** An absolute address of the process image or the bit memory; German mnemonics (%E, %A) too. */
export function parseAbsolute(text: string): Omit<Assignment, "tags" | "uses"> | undefined {
  const m = ADDRESS.exec(text.trim());
  if (!m) return undefined;
  const area = ({ I: "I", E: "I", Q: "Q", A: "Q", M: "M" } as const)[m[1]!.toUpperCase() as "I" | "E" | "Q" | "A" | "M"];
  const size = m[2]?.toUpperCase();
  const byte = Number(m[3]);
  if (m[4] !== undefined && size && size !== "X") return undefined; // %MW10.3 is not an address
  const bit = m[4] !== undefined ? Number(m[4]) : undefined;
  if (bit === undefined && (!size || size === "X")) return undefined; // %M10 without a bit
  const bits = bit !== undefined ? 1 : SIZE[size!]!;
  const address = `%${area}${bits === 1 ? "" : size}${byte}${bit !== undefined ? `.${bit}` : ""}`;
  return { address, area, byte, ...(bit !== undefined ? { bit } : {}), bits, ...(m[5] ? { peripheral: true } : {}) };
}

/** The bytes (and for a bit, its bit) an address occupies. */
function span(a: Pick<Assignment, "byte" | "bits">): number[] {
  const n = Math.max(1, a.bits / 8);
  return Array.from({ length: n }, (_, i) => a.byte + i);
}

export function assignmentList(index: WorkspaceIndex): { items: Assignment[]; overlaps: Overlap[] } {
  const byAddress = new Map<string, Assignment>();
  const entry = (text: string): Assignment | undefined => {
    const p = parseAbsolute(text);
    if (!p) return undefined;
    const key = `${p.address}${p.peripheral ? ":P" : ""}`;
    let a = byAddress.get(key);
    if (!a) byAddress.set(key, (a = { ...p, tags: [], uses: [] }));
    return a;
  };
  const tagAddress = new Map<string, Assignment>();
  for (const g of index.allGlobals()) {
    if (!g.tag?.address) continue;
    const a = entry(g.tag.address);
    if (!a) continue;
    a.tags.push({ name: g.name, table: g.tag.table, dataType: g.tag.dataType });
    tagAddress.set(g.name.toUpperCase(), a);
  }
  for (const doc of index.docs.values()) {
    if (!doc.parsed) continue;
    for (const t of doc.parsed.tokens) {
      if (t.kind === "absolute") {
        const a = entry(t.text);
        if (a) a.uses.push({ uri: doc.uri, line: doc.lines.position(t.start).line });
      }
    }
    for (const b of doc.parsed.blocks)
      for (const r of b.refs) {
        if (r.kind !== "global") continue;
        const a = tagAddress.get(r.name.toUpperCase());
        if (a) a.uses.push({ uri: doc.uri, line: doc.lines.position(r.start).line });
      }
  }
  const areaOrder: Record<Area, number> = { I: 0, Q: 1, M: 2 };
  const items = [...byAddress.values()].sort((x, y) => areaOrder[x.area] - areaOrder[y.area] || x.byte - y.byte || (x.bit ?? -1) - (y.bit ?? -1) || x.bits - y.bits);
  // overlaps: two different addresses of one area that share a byte (a bit inside a word, two words that cross);
  // two bits of the same byte do not overlap
  const overlaps: Overlap[] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.area !== b.area || !!a.peripheral !== !!b.peripheral) continue;
      if (a.bits === 1 && b.bits === 1) continue;
      const sa = span(a);
      const sb = span(b);
      const shared = sa.filter((x) => sb.includes(x));
      if (shared.length) overlaps.push({ a: a.address, b: b.address, bytes: shared, nested: shared.length === Math.min(sa.length, sb.length) });
    }
  for (const a of items) a.uses.sort((x, y) => (x.uri < y.uri ? -1 : x.uri > y.uri ? 1 : x.line - y.line));
  return { items, overlaps };
}
