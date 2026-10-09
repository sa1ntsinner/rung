// SPDX-License-Identifier: BUSL-1.1
// The declaration model the editors' tables show (rung/declarations): a block's interface by TIA's sections, nested
// rows, attribute states and the exact text ranges every later edit replaces. Read from the parser; nothing is reformatted.
// A PLC tag table (.tags.st) is shown the same way: its tags with their addresses, and its constants.
import type { BlockModel, ParsedDocument, Section, VarDecl } from "./parser.js";
import { TAG_TEXT, tagTableName } from "./workspace.js";
import { EXPOSURE, attrState, parseAttributes, type AttrState } from "./attributes.js";

export type { AttrState };

/** UTF-16 offsets into the document text. */
export interface DRange {
  start: number;
  end: number;
}

export interface DeclRow {
  /** names from the section down, each with % and / escaped: "Settings/Speed" (valid for one document version) */
  id: string;
  depth: number;
  name: string;
  type: string;
  typeRef?: string;
  kind: "plain" | "struct" | "array" | "instance";
  start?: string;
  comment?: string;
  /** a PLC tag's address (%I0.0, %MW10) */
  address?: string;
  attrs: { accessible: AttrState; visible: AttrState; writable: AttrState; setpoint: AttrState };
  /** whether TIA's HMI/OPC UA attributes apply (not to temporaries and constants) */
  hmi: boolean;
  /** attributes the table has no column for, shown in the inspector */
  other: { key: string; value: string }[];
  ranges: { whole: DRange; name: DRange; type: DRange; start?: DRange; comment?: DRange; attrs?: DRange; address?: DRange };
  /** the language server's errors and warnings about this declaration's name, type or value */
  problems?: DeclProblem[];
  children?: DeclRow[];
}

export interface DeclProblem {
  column: "name" | "type" | "start";
  severity: "error" | "warning";
  message: string;
}

/** A diagnostic of the file, as the language server reports it. */
export interface FileProblem extends DRange {
  severity: string;
  message: string;
}

export interface DeclSection {
  id: string;
  title: string;
  keyword: string;
  modifiers: string[];
  rows: DeclRow[];
  range: DRange;
  /** after the header .. the start of END_VAR: where new declarations go */
  body: DRange;
}

export interface DeclModel {
  uri: string;
  version: number;
  /** an FC's return type as written (Void, Int, …) */
  block?: { name: string; kind: string; range: DRange; returnType?: string };
  sections: DeclSection[];
  editable: boolean;
  reason?: string;
  /** regions the parser could not read */
  unavailable: DRange[];
  /** a tag table: the bit memory a new tag gets (the next free one of its PLC) */
  nextAddress?: string;
}

/** TIA's names for the interface sections. */
const TITLE: Record<Section, string> = { Input: "Input", Output: "Output", InOut: "InOut", Static: "Static", Temp: "Temp", Constant: "Constant", Return: "Return", Member: "Static" };
const STANDARD_FB = /^(TON|TOF|TP|TONR|CTU|CTD|CTUD|R_TRIG|F_TRIG)(_|$)/i;
const KNOWN = new Set(Object.values(EXPOSURE).map((k) => k.toUpperCase()));

/** The problems about a row's own name, type or value (a member's are its own). */
function problemsOf(r: Pick<DeclRow, "ranges">, problems: FileProblem[]): DeclProblem[] {
  const out: DeclProblem[] = [];
  for (const p of problems) {
    if (p.severity !== "error" && p.severity !== "warning") continue;
    const hits = (x?: DRange) => !!x && p.start < Math.max(x.end, x.start + 1) && p.end > x.start;
    const column = hits(r.ranges.name) ? "name" : hits(r.ranges.type) ? "type" : hits(r.ranges.start) ? "start" : undefined;
    if (column) out.push({ column, severity: p.severity, message: p.message });
  }
  return out;
}

function row(text: string, v: VarDecl, parent: string, depth: number, isFb: (name: string) => boolean, hmi: boolean, problems: FileProblem[]): DeclRow {
  // names joined by "/", each with "%" and "/" escaped: "a/b" (a quoted name) is not member b of a
  const segment = v.name.replace(/%/g, "%25").replace(/\//g, "%2F");
  const id = parent ? `${parent}/${segment}` : segment;
  const src = v.src;
  const list = src?.attrs ? parseAttributes(text, src.attrs) : undefined;
  const ranges: DeclRow["ranges"] = src
    ? { whole: src.whole, name: src.name, type: src.type, ...(src.init ? { start: src.init } : {}), ...(src.comment ? { comment: src.comment } : {}), ...(src.attrs ? { attrs: src.attrs } : {}) }
    : { whole: { start: v.start, end: v.end }, name: { start: v.start, end: v.end }, type: { start: v.end, end: v.end } };
  // a tag's address: AT %… between its name (and attributes) and its type
  const from = src?.attrs?.end ?? src?.name.end;
  const at = v.at && src && from !== undefined ? /\bAT\s+(%[^\s:;]+)/i.exec(text.slice(from, src.type.start)) : null;
  if (at && from !== undefined) {
    const s = from + at.index + at[0].length - at[1]!.length;
    ranges.address = { start: s, end: s + at[1]!.length };
  }
  const found = problemsOf({ ranges }, problems);
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
    ...(v.at ? { address: v.at } : {}),
    attrs: { accessible: attrState(list, EXPOSURE.accessible), visible: attrState(list, EXPOSURE.visible), writable: attrState(list, EXPOSURE.writable), setpoint: attrState(list, EXPOSURE.setpoint) },
    hmi,
    other: (list?.entries ?? []).filter((e) => !KNOWN.has(e.key.toUpperCase())).map((e) => ({ key: e.key, value: e.value })),
    ranges,
    ...(found.length ? { problems: found } : {}),
    ...(v.members?.length ? { children: v.members.map((m) => row(text, m, id, depth + 1, isFb, hmi, problems)) } : {}),
  };
}

/**
 * A PLC tag table as a table: its VAR_GLOBAL sections (tags, and constants under VAR_GLOBAL CONSTANT), each tag with
 * its address. `nextAddress`: where a new tag goes.
 */
function tagTableModel(uri: string, version: number, text: string, parsed: ParsedDocument, problems: FileProblem[], nextAddress?: string): DeclModel {
  const vars = parsed.blocks.flatMap((b) => b.vars);
  // comments blanked out (same offsets): a VAR_GLOBAL in the header comment is no section
  const code = text.replace(/\(\*[\s\S]*?\*\)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m) => m.replace(/[^\r\n]/g, " "));
  const sections: DeclSection[] = [];
  for (const m of code.matchAll(/^[ \t]*VAR_GLOBAL([ \t]+CONSTANT)?[ \t]*$/gim)) {
    const bodyStart = m.index + m[0].length + (code.slice(m.index + m[0].length).match(/^\r?\n/)?.[0].length ?? 0);
    const close = /^[ \t]*END_VAR\b/im.exec(code.slice(bodyStart));
    const bodyEnd = close ? bodyStart + close.index : text.length;
    const constant = !!m[1];
    sections.push({
      id: `${constant ? "Constants" : "Tags"}-${sections.length}`,
      title: constant ? "Constants" : "Tags",
      keyword: constant ? "VAR_GLOBAL CONSTANT" : "VAR_GLOBAL",
      modifiers: constant ? ["CONSTANT"] : [],
      rows: vars.filter((v) => v.start >= bodyStart && v.end <= bodyEnd).map((v) => row(text, v, "", 0, () => false, !constant, problems)),
      range: { start: m.index, end: close ? bodyEnd + close[0].length : text.length },
      body: { start: bodyStart, end: bodyEnd },
    });
  }
  return {
    uri,
    version,
    block: { name: tagTableName(uri), kind: "TAGS", range: { start: 0, end: text.length } },
    sections,
    editable: true,
    unavailable: parsed.diagnostics.filter((d) => d.severity === "error").map((d) => ({ start: d.start, end: d.end })),
    ...(nextAddress ? { nextAddress } : {}),
  };
}

/** The interface of the block at `offset` (or the file's first block). `isFb` tells instances of project FBs. */
export function declarationModel(uri: string, version: number, text: string, parsed: ParsedDocument, offset?: number, isFb: (name: string) => boolean = () => false, problems: FileProblem[] = [], nextAddress?: string): DeclModel {
  if (TAG_TEXT.test(uri)) return tagTableModel(uri, version, text, parsed, problems, nextAddress);
  const blocks = parsed.blocks.filter((b) => b.kind !== "GVL");
  const block: BlockModel | undefined = (offset !== undefined ? blocks.find((b) => offset >= b.start && offset <= b.end) : undefined) ?? blocks[0];
  if (!block) return { uri, version, sections: [], editable: false, reason: "No block in this file", unavailable: [] };
  const sections: DeclSection[] = (block.sections ?? []).map((s, n) => ({
    id: `${s.section}-${n}`,
    title: TITLE[s.section] ?? s.section,
    keyword: s.keyword,
    modifiers: s.modifiers,
    rows: block.vars.filter((v) => v.start >= s.whole.start && v.end <= s.whole.end).map((v) => row(text, v, "", 0, isFb, s.section !== "Temp" && s.section !== "Constant", problems)),
    range: s.whole,
    body: s.body,
  }));
  const readOnly = !!block.xml || !!block.stl || /\.protected\.yaml$/i.test(uri);
  const declEnd = block.bodyStart ?? block.end;
  const unavailable = parsed.diagnostics.filter((d) => d.severity === "error" && d.start >= block.start && d.start < declEnd).map((d) => ({ start: d.start, end: d.end }));
  return {
    uri,
    version,
    block: { name: block.name, kind: block.kind, range: { start: block.start, end: block.end }, ...(block.returnType ? { returnType: block.returnType } : {}) },
    sections,
    editable: !readOnly,
    ...(readOnly ? { reason: "Read only: graphical or protected block" } : {}),
    unavailable,
  };
}
