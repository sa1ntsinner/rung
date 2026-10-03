// SPDX-License-Identifier: BUSL-1.1
// TIA attribute pragmas on declarations ({ ExternalWritable := 'False'; S7_SetPoint := 'True' }): the entries with
// their exact spans, so a table can show them and change one value without touching the others.
import type { Span } from "./parser.js";

export interface AttrEntry {
  key: string;
  /** unquoted, '' read as ' */
  value: string;
  /** the value as written, quotes included */
  raw: string;
  key_: Span;
  value_: Span;
  /** key start .. value end */
  entry: Span;
}

export interface AttrList {
  span: Span;
  entries: AttrEntry[];
}

/** The four attributes TIA's interface table shows as columns, by their source keys. */
export const EXPOSURE = { accessible: "ExternalAccessible", visible: "ExternalVisible", writable: "ExternalWritable", setpoint: "S7_SetPoint" } as const;

/**
 * TIA Portal's value when the attribute is absent. TIA V20 writes none of these when they equal this value: an
 * exported block carries ExternalWritable := 'False' but never 'True', S7_SetPoint := 'True' but never 'False'
 * (checked against TIA V20 by import, compile and export).
 */
export const ATTR_DEFAULT: Record<string, boolean> = { EXTERNALACCESSIBLE: true, EXTERNALVISIBLE: true, EXTERNALWRITABLE: true, S7_SETPOINT: false };

/** An attribute as a table shows it: its value, and whether the source says so or TIA's default applies. */
export interface AttrState {
  value: boolean;
  explicit: boolean;
}

export function parseAttributes(src: string, span: Span): AttrList {
  const entries: AttrEntry[] = [];
  let i = span.start + 1; // after {
  const end = span.end - 1; // the }
  while (i < end) {
    while (i < end && /[\s;]/.test(src[i]!)) i++;
    if (i >= end) break;
    const keyStart = i;
    while (i < end && /[\w.]/.test(src[i]!)) i++;
    const keyEnd = i;
    while (i < end && /\s/.test(src[i]!)) i++;
    if (src.startsWith(":=", i)) i += 2;
    while (i < end && /\s/.test(src[i]!)) i++;
    const valueStart = i;
    let value = "";
    if (src[i] === "'") {
      i++;
      while (i < end) {
        if (src[i] === "'" && src[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          i++;
          break;
        }
        value += src[i++];
      }
    } else {
      while (i < end && src[i] !== ";") value += src[i++];
      value = value.trim();
    }
    const valueEnd = i;
    if (keyEnd > keyStart)
      entries.push({ key: src.slice(keyStart, keyEnd), value, raw: src.slice(valueStart, valueEnd), key_: { start: keyStart, end: keyEnd }, value_: { start: valueStart, end: valueEnd }, entry: { start: keyStart, end: valueEnd } });
    // a malformed entry: skip to the next separator
    while (i < end && src[i] !== ";") i++;
  }
  return { span, entries };
}

export function attrState(list: AttrList | undefined, key: string): AttrState {
  const e = list?.entries.find((x) => x.key.toUpperCase() === key.toUpperCase());
  const fallback = ATTR_DEFAULT[key.toUpperCase()] ?? false;
  if (!e || !/^(true|false)$/i.test(e.value)) return { value: fallback, explicit: false };
  return { value: /^true$/i.test(e.value), explicit: true };
}
