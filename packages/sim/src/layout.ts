// SPDX-License-Identifier: BUSL-1.1
// The bytes of a variable in a block with standard access (S7_Optimized_Access := 'FALSE'), for `x AT y`: two views
// of one memory. Big-endian, as on an S7 CPU; a BOOL is one bit and BOOLs in a row share a byte (element 0 is bit 0);
// BYTE, CHAR and SINT start on any byte; everything wider, every STRING, ARRAY and STRUCT starts on an even byte, and
// an ARRAY or STRUCT ends on one too.
import type { VarDecl } from "@rung/lsp";

type Value = unknown;
type Decl = Pick<VarDecl, "type" | "typeRef" | "members"> & { isArray?: boolean };
/** The members of a named structured type (a UDT, DTL), or undefined for an elementary type. */
export type MembersOf = (type: string) => Decl[] | undefined;

interface Leaf {
  type: string;
  get: () => Value;
  set: (v: Value) => void;
}
type Item = Leaf | "begin" | "end";

const BYTES: Record<string, number> = {
  BYTE: 1, CHAR: 1, SINT: 1, USINT: 1,
  WORD: 2, INT: 2, UINT: 2, DATE: 2, S5TIME: 2, WCHAR: 2,
  DWORD: 4, DINT: 4, UDINT: 4, REAL: 4, TIME: 4, TOD: 4, TIME_OF_DAY: 4,
  LWORD: 8, LINT: 8, ULINT: 8, LREAL: 8, LTIME: 8, LTOD: 8, LDT: 8, DT: 8, DATE_AND_TIME: 8,
};
const SIGNED = /^(SINT|INT|DINT|LINT|TIME|LTIME)$/;

class Unsupported extends Error {}

function shapeOf(type: string): { dims: string[]; element: string } | undefined {
  const m = /^\s*array\s*\[(.*?)\]\s*of\s+(.+)$/is.exec(type);
  return m ? { dims: m[1]!.split(","), element: m[2]!.trim() } : undefined;
}

function walk(value: Value, decl: Decl, membersOf: MembersOf, out: Item[], put: (v: Value) => void): void {
  if (decl.isArray) {
    const shape = shapeOf(decl.type);
    const arr = value as { items?: Value[] };
    if (!shape || !Array.isArray(arr?.items)) throw new Unsupported(`${decl.type}: not an array value`);
    const element: Decl = shape.dims.length > 1
      ? { type: `Array[${shape.dims.slice(1).join(",")}] of ${shape.element}`, typeRef: decl.typeRef, isArray: true, members: decl.members }
      : { type: shape.element, typeRef: decl.typeRef, isArray: /^array\b/i.test(shape.element), members: decl.members };
    out.push("begin");
    arr.items.forEach((item, i) => walk(item, element, membersOf, out, (v) => (arr.items![i] = v)));
    out.push("end");
    return;
  }
  const name = (decl.typeRef ?? decl.type).replace(/^"|"$/g, "");
  const members = decl.members?.length ? decl.members : membersOf(name);
  if (members) {
    const s = value as Record<string, Value>;
    out.push("begin");
    for (const m of members) {
      const key = (m as VarDecl).name.toUpperCase();
      walk(s[key], m, membersOf, out, (v) => (s[key] = v));
    }
    out.push("end");
    return;
  }
  out.push({ type: name.toUpperCase().replace(/\s+/g, ""), get: () => value, set: put });
}

/** Leaves with their bit positions, and the size in bytes. */
function place(items: Item[]): { leaves: { leaf: Leaf; bit: number }[]; size: number } {
  let bit = 0;
  const even = () => (bit = Math.ceil(bit / 16) * 16);
  const leaves: { leaf: Leaf; bit: number }[] = [];
  for (const it of items) {
    if (it === "begin" || it === "end") { even(); continue; }
    if (it.type === "BOOL") { leaves.push({ leaf: it, bit }); bit += 1; continue; }
    const str = /^(W?)STRING(?:\[(\d+)\])?$/.exec(it.type);
    const bytes = str ? (str[1] ? 2 : 1) * (Number(str[2] ?? 254) + 2) : BYTES[it.type];
    if (!bytes) throw new Unsupported(`${it.type} has no byte layout in the simulator`);
    if (bytes === 1 && !str) bit = Math.ceil(bit / 8) * 8;
    else even();
    leaves.push({ leaf: it, bit });
    bit += bytes * 8;
  }
  even();
  return { leaves, size: bit / 8 };
}

function sizeOfType(t: string): number {
  const str = /^(W?)STRING(?:\[(\d+)\])?$/.exec(t);
  return str ? (str[1] ? 2 : 1) * (Number(str[2] ?? 254) + 2) : BYTES[t]!;
}

function writeLeaf(bytes: Uint8Array, at: number, t: string, v: Value) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const str = /^(W?)STRING(?:\[(\d+)\])?$/.exec(t);
  if (str) {
    const max = Number(str[2] ?? 254), text = String(v ?? "").slice(0, max);
    if (str[1]) {
      view.setUint16(at, max); view.setUint16(at + 2, text.length);
      for (let i = 0; i < text.length; i++) view.setUint16(at + 4 + 2 * i, text.charCodeAt(i));
    } else {
      bytes[at] = max; bytes[at + 1] = text.length;
      for (let i = 0; i < text.length; i++) bytes[at + 2 + i] = text.charCodeAt(i) & 0xff;
    }
    return;
  }
  const n = t === "CHAR" || t === "WCHAR" ? String(v ?? "\0").charCodeAt(0) || 0 : Number(v ?? 0);
  switch (sizeOfType(t)) {
    case 1: bytes[at] = n & 0xff; return;
    case 2: view.setUint16(at, n & 0xffff); return;
    case 4: if (t === "REAL") view.setFloat32(at, n); else view.setUint32(at, n >>> 0); return;
    default: if (t === "LREAL") view.setFloat64(at, n); else view.setBigUint64(at, BigInt.asUintN(64, BigInt(Math.trunc(t === "LTIME" ? n * 1_000_000 : n)))); return;
  }
}

function readLeaf(bytes: Uint8Array, at: number, t: string): Value {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const str = /^(W?)STRING(?:\[(\d+)\])?$/.exec(t);
  if (str) {
    if (str[1]) return String.fromCharCode(...Array.from({ length: Math.min(view.getUint16(at + 2), Number(str[2] ?? 254)) }, (_, i) => view.getUint16(at + 4 + 2 * i)));
    return String.fromCharCode(...bytes.slice(at + 2, at + 2 + Math.min(bytes[at + 1]!, Number(str[2] ?? 254))));
  }
  if (t === "CHAR") return String.fromCharCode(bytes[at]!);
  if (t === "WCHAR") return String.fromCharCode(view.getUint16(at));
  const signed = SIGNED.test(t);
  switch (sizeOfType(t)) {
    case 1: return signed ? view.getInt8(at) : bytes[at]!;
    case 2: return signed ? view.getInt16(at) : view.getUint16(at);
    case 4: return t === "REAL" ? view.getFloat32(at) : signed ? view.getInt32(at) : view.getUint32(at);
    default: {
      if (t === "LREAL") return view.getFloat64(at);
      const big = signed ? view.getBigInt64(at) : view.getBigUint64(at);
      return t === "LTIME" ? Number(big) / 1_000_000 : Number(big);
    }
  }
}

/** The bytes of a value of this declaration. */
export function encode(value: Value, decl: Decl, membersOf: MembersOf): Uint8Array {
  const items: Item[] = [];
  walk(value, decl, membersOf, items, () => {});
  const { leaves, size } = place(items);
  const bytes = new Uint8Array(size);
  for (const { leaf, bit } of leaves) {
    if (leaf.type === "BOOL") { if (leaf.get()) bytes[bit >> 3]! |= 1 << (bit & 7); }
    else writeLeaf(bytes, bit / 8, leaf.type, leaf.get());
  }
  return bytes;
}

/** A value of this declaration read from these bytes (zeros past their end): a structure or array is filled in place. */
export function decode(bytes: Uint8Array, value: Value, decl: Decl, membersOf: MembersOf): Value {
  const items: Item[] = [];
  let result = value;
  walk(value, decl, membersOf, items, (v) => (result = v));
  const { leaves, size } = place(items);
  const all = new Uint8Array(Math.max(size, bytes.length));
  all.set(bytes);
  for (const { leaf, bit } of leaves) leaf.set(leaf.type === "BOOL" ? ((all[bit >> 3]! >> (bit & 7)) & 1) === 1 : readLeaf(all, bit / 8, leaf.type));
  return result;
}

export { Unsupported as LayoutUnsupported };
