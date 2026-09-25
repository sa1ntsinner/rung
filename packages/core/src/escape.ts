// SPDX-License-Identifier: BUSL-1.1
// Segment codec for workspace format 1 (docs/format/README.md).

export class AddressError extends Error {
  override name = "AddressError";
}

const ILLEGAL = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|", "%", "~"]);
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i;

const hex = (c: string) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");

/** Escape one raw name segment so it is a safe, lossless file/directory name. */
export function escapeSegment(raw: string): string {
  if (!raw || !raw.isWellFormed()) throw new AddressError(`invalid segment: ${JSON.stringify(raw)}`);
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    out += ILLEGAL.has(ch) || code < 0x20 || code === 0x7f ? hex(ch) : ch;
  }
  out = out.replace(/[. ]+$/, (tail) => Array.from(tail, hex).join(""));
  if (RESERVED.test(raw)) out = hex(out[0]!) + out.slice(1);
  return out;
}

/** Inverse of escapeSegment; rejects anything escapeSegment would not have produced. */
export function unescapeSegment(escaped: string): string {
  if (!escaped || /%(?![0-9A-F]{2})/.test(escaped)) throw new AddressError(`invalid segment: ${JSON.stringify(escaped)}`);
  const raw = escaped.replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  if (escapeSegment(raw) !== escaped) throw new AddressError(`noncanonical segment: ${JSON.stringify(escaped)}`);
  return raw;
}

/** Leaf = escape(name) or escape(namespace) "~" escape(name). */
export function leafSegment(a: { name: string; namespace?: string }): string {
  if (a.namespace === undefined) return escapeSegment(a.name);
  if (a.namespace === "") throw new AddressError("empty namespace");
  return `${escapeSegment(a.namespace)}~${escapeSegment(a.name)}`;
}

export function splitLeaf(leaf: string): { name: string; namespace?: string } {
  const i = leaf.indexOf("~");
  if (i < 0) return { name: unescapeSegment(leaf) };
  if (i === 0 || i === leaf.length - 1 || leaf.indexOf("~", i + 1) >= 0) throw new AddressError(`invalid leaf: ${leaf}`);
  return { namespace: unescapeSegment(leaf.slice(0, i)), name: unescapeSegment(leaf.slice(i + 1)) };
}
