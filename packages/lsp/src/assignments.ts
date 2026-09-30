// SPDX-License-Identifier: BUSL-1.1
// The assignment list, like TIA Portal's: which inputs, outputs and memory bits the program uses, through which
// tag and where the code uses an address directly, and which of them overlap (%MW10 and %M10.3 share byte 10).
import { deviceOfUri, type WorkspaceIndex } from "./workspace.js";

export type Area = "I" | "Q" | "M";

export interface Assignment {
  /** The PLC (plc/<PLC>/ of a rung workspace); every PLC has its own inputs, outputs and bit memory. */
  device?: string;
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
  /** The PLC both addresses are of. */
  device?: string;
  a: string;
  b: string;
  /** Bytes both occupy. */
  bytes: number[];
  /** One lies inside the other (%IB200 and %I200.1: a status byte read whole and by bit, often on purpose); else they cross (%MW10 and %MW11), usually a mistake. */
  nested: boolean;
}

/** Bits of the elementary types a PLC tag can have at an I, Q or M address. */
export const TYPE_BITS: Readonly<Record<string, number>> = {
  BOOL: 1,
  BYTE: 8, SINT: 8, USINT: 8, CHAR: 8,
  WORD: 16, INT: 16, UINT: 16, WCHAR: 16, DATE: 16, S5TIME: 16,
  DWORD: 32, DINT: 32, UDINT: 32, REAL: 32, TIME: 32, TIME_OF_DAY: 32, TOD: 32,
  LWORD: 64, LINT: 64, ULINT: 64, LREAL: 64, LTIME: 64,
};

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

/** The addresses in use, per PLC; with `device`, those of that PLC only (workspace files outside plc/ belong to none). */
export function assignmentList(index: WorkspaceIndex, device?: string): { items: Assignment[]; overlaps: Overlap[] } {
  const byAddress = new Map<string, Assignment>();
  const wanted = (uri: string) => device === undefined || deviceOfUri(uri) === device;
  const entry = (uri: string, text: string, typeBits?: number): Assignment | undefined => {
    let p = parseAbsolute(text);
    if (!p) return undefined;
    // TIA Portal writes a 64-bit tag at a bit address (%M0.0 : LReal): it takes eight bytes from there
    if (typeBits === 64 && p.bit === 0) {
      const { bit: _bit, ...rest } = p;
      p = { ...rest, bits: 64 };
    }
    const plc = deviceOfUri(uri);
    const key = `${plc ?? ""}\u0000${p.address}${p.bits === 64 && p.address.includes(".") ? ":64" : ""}${p.peripheral ? ":P" : ""}`;
    let a = byAddress.get(key);
    if (!a) byAddress.set(key, (a = { ...(plc !== undefined ? { device: plc } : {}), ...p, tags: [], uses: [] }));
    return a;
  };
  // a tag name means the tag of the PLC the code is in (scopedTo)
  const tagAddress = new Map<string, Assignment>();
  const tagKey = (uri: string, name: string) => `${deviceOfUri(uri) ?? ""}\u0000${name.toUpperCase()}`;
  for (const g of index.allGlobals()) {
    // PLC tags, and located variables of IEC global variable lists (CODESYS: x AT %IX0.0 : BOOL)
    const at = g.tag?.address ?? g.gvar?.decl.at;
    if (!at || !wanted(g.uri)) continue;
    const a = entry(g.uri, at, TYPE_BITS[(g.tag?.dataType ?? g.gvar!.decl.type).toUpperCase()]);
    if (!a) continue;
    a.tags.push({ name: g.name, table: g.tag?.table ?? g.gvar!.list, dataType: g.tag?.dataType ?? g.gvar!.decl.type });
    tagAddress.set(tagKey(g.uri, g.name), a);
  }
  for (const doc of index.docs.values()) {
    if (!doc.parsed || !wanted(doc.uri)) continue;
    const tokens = doc.parsed.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      // `AT %I0.0` declares where a variable lives; it is not a use
      if (t.kind === "absolute" && tokens[i - 1]?.text.toUpperCase() !== "AT") {
        const a = entry(doc.uri, t.text);
        if (a) a.uses.push({ uri: doc.uri, line: doc.lines.position(t.start).line });
      }
    }
    for (const b of doc.parsed.blocks)
      for (const r of b.refs) {
        if (r.kind !== "global") continue;
        const a = tagAddress.get(tagKey(doc.uri, r.name)) ?? tagAddress.get(tagKey("", r.name));
        if (a) a.uses.push({ uri: doc.uri, line: doc.lines.position(r.start).line });
      }
  }
  const areaOrder: Record<Area, number> = { I: 0, Q: 1, M: 2 };
  const plcOrder = (a: Assignment) => a.device ?? "";
  const items = [...byAddress.values()].sort(
    (x, y) => (plcOrder(x) < plcOrder(y) ? -1 : plcOrder(x) > plcOrder(y) ? 1 : 0) || areaOrder[x.area] - areaOrder[y.area] || x.byte - y.byte || (x.bit ?? -1) - (y.bit ?? -1) || x.bits - y.bits,
  );
  // overlaps: two different addresses of one area of one PLC that share a byte (a bit inside a word, two words
  // that cross); two bits of the same byte do not overlap
  const overlaps: Overlap[] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.device !== b.device || a.area !== b.area || !!a.peripheral !== !!b.peripheral) continue;
      if (a.bits === 1 && b.bits === 1) continue;
      const sa = span(a);
      const sb = span(b);
      const shared = sa.filter((x) => sb.includes(x));
      if (shared.length) overlaps.push({ ...(a.device !== undefined ? { device: a.device } : {}), a: a.address, b: b.address, bytes: shared, nested: shared.length === Math.min(sa.length, sb.length) });
    }
  for (const a of items) a.uses.sort((x, y) => (x.uri < y.uri ? -1 : x.uri > y.uri ? 1 : x.line - y.line));
  return { items, overlaps };
}
