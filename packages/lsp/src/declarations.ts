// SPDX-License-Identifier: BUSL-1.1
// The declaration model the editors' tables show (rung/declarations): a block's interface by TIA's sections, nested
// rows, attribute states and the exact text ranges every later edit replaces. Read from the parser; nothing is reformatted.
import type { BlockModel, ParsedDocument, Section, VarDecl } from "./parser.js";
import { EXPOSURE, attrState, parseAttributes, type AttrState } from "./attributes.js";

export type { AttrState };

/** UTF-16 offsets into the document text. */
export interface DRange {
  start: number;
  end: number;
}

export interface DeclRow {
  /** names from the section down: "Settings/Speed" (valid for one document version) */
  id: string;
  depth: number;
  name: string;
  type: string;
  typeRef?: string;
  kind: "plain" | "struct" | "array" | "instance";
  start?: string;
  comment?: string;
  attrs: { accessible: AttrState; visible: AttrState; writable: AttrState; setpoint: AttrState };
  /** attributes the table has no column for, shown in the inspector */
  other: { key: string; value: string }[];
  ranges: { whole: DRange; name: DRange; type: DRange; start?: DRange; comment?: DRange; attrs?: DRange };
  children?: DeclRow[];
}

export interface DeclSection {
  id: string;
  title: string;
  keyword: string;
  modifiers: string[];
  rows: DeclRow[];
  range: DRange;
}

export interface DeclModel {
  uri: string;
  version: number;
  block?: { name: string; kind: string; range: DRange };
  sections: DeclSection[];
  editable: boolean;
  reason?: string;
  /** regions the parser could not read */
  unavailable: DRange[];
}

/** TIA's names for the interface sections. */
const TITLE: Record<Section, string> = { Input: "Input", Output: "Output", InOut: "InOut", Static: "Static", Temp: "Temp", Constant: "Constant", Return: "Return", Member: "Static" };
const STANDARD_FB = /^(TON|TOF|TP|TONR|CTU|CTD|CTUD|R_TRIG|F_TRIG)(_|$)/i;
const KNOWN = new Set(Object.values(EXPOSURE).map((k) => k.toUpperCase()));

function row(text: string, v: VarDecl, parent: string, depth: number, isFb: (name: string) => boolean): DeclRow {
  const id = parent ? `${parent}/${v.name}` : v.name;
  const src = v.src;
  const list = src?.attrs ? parseAttributes(text, src.attrs) : undefined;
  const kind: DeclRow["kind"] = v.isArray ? "array" : v.members && v.type === "Struct" ? "struct" : v.typeRef && (STANDARD_FB.test(v.typeRef) || isFb(v.typeRef)) ? "instance" : "plain";
  return {
    id,
    depth,
    name: v.name,
    type: v.type,
    ...(v.typeRef ? { typeRef: v.typeRef } : {}),
    kind,
    ...(v.init !== undefined ? { start: v.init } : {}),
    ...(v.comment ? { comment: v.comment } : {}),
    attrs: { accessible: attrState(list, EXPOSURE.accessible), visible: attrState(list, EXPOSURE.visible), writable: attrState(list, EXPOSURE.writable), setpoint: attrState(list, EXPOSURE.setpoint) },
    other: (list?.entries ?? []).filter((e) => !KNOWN.has(e.key.toUpperCase())).map((e) => ({ key: e.key, value: e.value })),
    ranges: src
      ? { whole: src.whole, name: src.name, type: src.type, ...(src.init ? { start: src.init } : {}), ...(src.comment ? { comment: src.comment } : {}), ...(src.attrs ? { attrs: src.attrs } : {}) }
      : { whole: { start: v.start, end: v.end }, name: { start: v.start, end: v.end }, type: { start: v.end, end: v.end } },
    ...(v.members?.length ? { children: v.members.map((m) => row(text, m, id, depth + 1, isFb)) } : {}),
  };
}

/** The interface of the block at `offset` (or the file's first block). `isFb` tells instances of project FBs. */
export function declarationModel(uri: string, version: number, text: string, parsed: ParsedDocument, offset?: number, isFb: (name: string) => boolean = () => false): DeclModel {
  const blocks = parsed.blocks.filter((b) => b.kind !== "GVL");
  const block: BlockModel | undefined = (offset !== undefined ? blocks.find((b) => offset >= b.start && offset <= b.end) : undefined) ?? blocks[0];
  if (!block) return { uri, version, sections: [], editable: false, reason: "No block in this file", unavailable: [] };
  const sections: DeclSection[] = (block.sections ?? []).map((s, n) => ({
    id: `${s.section}-${n}`,
    title: TITLE[s.section] ?? s.section,
    keyword: s.keyword,
    modifiers: s.modifiers,
    rows: block.vars.filter((v) => v.start >= s.whole.start && v.end <= s.whole.end).map((v) => row(text, v, "", 0, isFb)),
    range: s.whole,
  }));
  const readOnly = !!block.xml || !!block.stl || /\.protected\.yaml$/i.test(uri);
  const declEnd = block.bodyStart ?? block.end;
  const unavailable = parsed.diagnostics.filter((d) => d.severity === "error" && d.start >= block.start && d.start < declEnd).map((d) => ({ start: d.start, end: d.end }));
  return {
    uri,
    version,
    block: { name: block.name, kind: block.kind, range: { start: block.start, end: block.end } },
    sections,
    editable: !readOnly,
    ...(readOnly ? { reason: "Read only: graphical or protected block" } : {}),
    unavailable,
  };
}
