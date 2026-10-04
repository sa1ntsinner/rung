// SPDX-License-Identifier: BUSL-1.1
// The text edits a declaration table makes (rung/declarationEdit): each replaces only its own span, in TIA's export
// style, and carries the old text so a stale apply can be refused. Nothing else in the file changes.
import { ATTR_DEFAULT, parseAttributes } from "./attributes.js";
import type { DeclModel, DeclRow, DeclSection } from "./declarations.js";
import { ELEMENTARY_TYPES, KEYWORDS } from "./catalog.js";

export type DeclOp =
  | { op: "setStart"; row: string; value: string | null }
  | { op: "setComment"; row: string; value: string | null }
  /** on/off as asked; an attribute TIA knows a default for is removed when the value is that default. default: remove. */
  | { op: "setAttr"; row: string; key: string; state: "on" | "off" | "default" }
  | { op: "setType"; row: string; type: string }
  /** after the row `after` (at its level), at the end of struct `into`, else at the end of `section` */
  | { op: "insertRows"; after?: string; into?: string; section?: string; rows: NewRow[] }
  | { op: "deleteRow"; row: string };

export interface NewRow {
  name: string;
  type: string;
  start?: string;
  comment?: string;
}

export interface PlannedEdit {
  start: number;
  end: number;
  /** the text the edit replaces, as the plan saw it */
  old: string;
  text: string;
}

export type EditPlan = { ok: true; version: number; edits: PlannedEdit[] } | { ok: false; reason: string };

function find(rows: DeclRow[], id: string): DeclRow | undefined {
  for (const r of rows) {
    if (r.id === id) return r;
    const c = r.children && find(r.children, id);
    if (c) return c;
  }
  return undefined;
}

const lineStart = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1;
/** just past the line's EOL (or the text's end) */
const lineEnd = (text: string, at: number) => {
  const n = text.indexOf("\n", at);
  return n < 0 ? text.length : n + 1;
};
const indentOf = (text: string, at: number) => /^[ \t]*/.exec(text.slice(lineStart(text, at)))![0];
const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** names SCL reserves: TIA refuses them unquoted ("Timer" is the S5 timer type) */
const RESERVED = new Set(
  [...KEYWORDS, ...ELEMENTARY_TYPES, "TIMER", "COUNTER", "S5TIME", "POINTER", "ANY", "BLOCK_DB", "BLOCK_FB", "BLOCK_FC", "BLOCK_SDB", "DT", "TOD", "LTOD", "DATE_AND_TIME", "STRING", "WSTRING", "VOID", "NULL", "REF_TO", "REF", "DB_ANY", "AT", "VERSION", "TITLE"].map((k) =>
    k.toUpperCase(),
  ),
);

function parentOf(model: DeclModel, id: string): { siblings: DeclRow[]; parent?: DeclRow } | undefined {
  const walk = (rows: DeclRow[], parent?: DeclRow): { siblings: DeclRow[]; parent?: DeclRow } | undefined => {
    for (const r of rows) {
      if (r.id === id) return { siblings: rows, ...(parent ? { parent } : {}) };
      const c = r.children && walk(r.children, r);
      if (c) return c;
    }
    return undefined;
  };
  for (const s of model.sections) {
    const f = walk(s.rows);
    // top-level names are unique across the whole interface
    if (f) return f.parent ? f : { siblings: model.sections.flatMap((x) => x.rows) };
  }
  return undefined;
}

/** The section a row (at any depth) is declared in. */
function sectionOf(model: DeclModel, id: string): DeclSection | undefined {
  const top = id.split("/")[0];
  return model.sections.find((s) => s.rows.some((r) => r.id === top));
}

/** What TIA allows for a default value in a section, or why not. */
function startRule(model: DeclModel, section: DeclSection | undefined, start: string | undefined): string | undefined {
  if (!section) return undefined;
  if (start && section.title === "Temp") return "Temporary variables have no default value.";
  if (!start && section.title === "Constant") return "A constant needs a value.";
  if (start && model.block?.kind === "FC" && (section.title === "Input" || section.title === "Output" || section.title === "InOut")) return "A function's parameters have no default value.";
  return undefined;
}

/** A row as TIA exports it, or why it cannot be written. */
function rowText(r: NewRow, indent: string): string | { reason: string } {
  const name = r.name.trim();
  const type = r.type.trim();
  const start = r.start?.trim();
  const comment = r.comment?.trim();
  if (!name) return { reason: "A declaration needs a name." };
  if (!type) return { reason: `"${name}" needs a data type.` };
  if ([name, type, start ?? "", comment ?? ""].some((v) => /[\r\n]/.test(v))) return { reason: "A value cannot span lines." };
  if (name.includes('"')) return { reason: `A name cannot contain '"'.` };
  if (/[;{}]|:=|\(\*|\/\/|\/\*/.test(type)) return { reason: `"${type}" is not a data type.` };
  if (start && /;|\/\/|\(\*|\/\*/.test(start.replace(/'(?:[^']|'')*'/g, "''"))) return { reason: `"${start}" is not a start value.` };
  const quoted = PLAIN_NAME.test(name) && !RESERVED.has(name.toUpperCase()) ? name : `"${name}"`;
  const instr = instruction(type);
  return `${indent}${quoted}${instr ? ` ${instructionPragma(instr)}` : ""} : ${instr ?? type}${start ? ` := ${start}` : ""};${comment ? `   // ${comment}` : ""}`;
}

/** TIA's full name of an instruction FB type (TON → TON_TIME, CTU → CTU_INT), undefined for any other type. */
export function instruction(type: string): string | undefined {
  const t = type.trim().toUpperCase();
  if (/^(TON|TOF|TP|TONR)$/.test(t)) return `${t}_TIME`;
  if (/^(CTU|CTD|CTUD)$/.test(t)) return `${t}_INT`;
  if (/^(TON|TOF|TP|TONR)_(TIME|LTIME)$/.test(t) || /^(CTU|CTD|CTUD)_(SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT)$/.test(t) || /^[RF]_TRIG$/.test(t)) return t;
  return undefined;
}
/** what TIA's export writes on an instruction instance (V20) */
const instructionPragma = (instr: string) => `{InstructionName := '${instr}'; LibVersion := '1.0'}`;
const INSTRUCTION_KEYS = new Set(["INSTRUCTIONNAME", "LIBVERSION"]);

function planRows(text: string, model: DeclModel, op: Extract<DeclOp, { op: "insertRows" }>): EditPlan {
  let at: number;
  let indent: string;
  let siblings: DeclRow[];
  if (op.after) {
    const p = parentOf(model, op.after);
    const row = p && p.siblings.find((r) => r.id === op.after);
    if (!p || !row) return { ok: false, reason: `No declaration ${op.after}` };
    siblings = p.siblings;
    // below the row's own line(s), its trailing comment included
    at = lineEnd(text, Math.max(row.ranges.whole.end, row.ranges.comment?.end ?? 0) - 1);
    indent = indentOf(text, row.ranges.whole.start);
  } else if (op.into) {
    const p = parentOf(model, op.into);
    const row = p && p.siblings.find((r) => r.id === op.into);
    if (!row || row.kind !== "struct") return { ok: false, reason: `No structure ${op.into}` };
    siblings = row.children ?? [];
    const close = text.slice(row.ranges.type.end, row.ranges.whole.end).search(/END_STRUCT\s*;?\s*$/i);
    if (close < 0) return { ok: false, reason: "The structure has no END_STRUCT yet" };
    at = lineStart(text, row.ranges.type.end + close);
    const first = row.children?.[0];
    indent = first ? indentOf(text, first.ranges.whole.start) : indentOf(text, row.ranges.whole.start) + "   ";
  } else {
    const s = model.sections.find((x) => x.id === op.section);
    if (!s) return { ok: false, reason: `No section ${op.section}` };
    siblings = model.sections.flatMap((x) => x.rows);
    at = lineStart(text, s.body.end);
    // END_VAR on the header's line ("VAR END_VAR"): open a line
    const last = s.rows[s.rows.length - 1];
    indent = last ? indentOf(text, last.ranges.whole.start) : indentOf(text, s.range.start) + "   ";
    if (at <= s.body.start) return { ok: false, reason: "Put END_VAR on a line of its own first" };
  }
  if (!op.rows.length) return { ok: true, version: model.version, edits: [] };
  const taken = new Set(siblings.map((r) => r.name.toLowerCase()));
  const section = op.after ? sectionOf(model, op.after) : op.into ? sectionOf(model, op.into) : model.sections.find((x) => x.id === op.section);
  const lines: string[] = [];
  for (const r of op.rows) {
    const rule = startRule(model, section, r.start?.trim());
    if (rule) return { ok: false, reason: rule };
    const t = rowText(r, indent);
    if (typeof t !== "string") return { ok: false, reason: t.reason };
    const key = r.name.trim().toLowerCase();
    if (taken.has(key)) return { ok: false, reason: `The block already has "${r.name.trim()}".` };
    taken.add(key);
    lines.push(t);
  }
  const eol = eolOf(text);
  // the last line of the file may have no EOL
  const lead = at === text.length && at > 0 && text[at - 1] !== "\n" ? eol : "";
  return { ok: true, version: model.version, edits: [{ start: at, end: at, old: "", text: lead + lines.map((l) => l + eol).join("") }] };
}

export function planDeclarationEdit(text: string, model: DeclModel, op: DeclOp): EditPlan {
  if (!model.editable) return { ok: false, reason: model.reason ?? "Read only" };
  if (op.op === "insertRows") return planRows(text, model, op);
  const row = model.sections.map((s) => find(s.rows, op.row)).find(Boolean);
  if (!row) return { ok: false, reason: `No declaration ${op.row}` };
  const none: EditPlan = { ok: true, version: model.version, edits: [] };
  const edit = (start: number, end: number, t: string): EditPlan => ({ ok: true, version: model.version, edits: [{ start, end, old: text.slice(start, end), text: t }] });

  if (op.op === "setType") {
    if (row.kind === "struct") return { ok: false, reason: "A structure's members are edited one by one" };
    const t = rowText({ name: row.name, type: op.type }, "");
    if (typeof t !== "string") return { ok: false, reason: t.reason };
    const instr = instruction(op.type);
    const v = instr ?? op.type.trim();
    const edits: PlannedEdit[] = [];
    const put = (start: number, end: number, t: string) => {
      if (text.slice(start, end) !== t) edits.push({ start, end, old: text.slice(start, end), text: t });
    };
    // an instruction instance carries its InstructionName; any other type does not
    const a = row.ranges.attrs;
    const others = a ? parseAttributes(text, a).entries.filter((e) => !INSTRUCTION_KEYS.has(e.key.toUpperCase())).map((e) => text.slice(e.entry.start, e.entry.end)) : [];
    const pragma = instr ? `${instructionPragma(instr).slice(0, -1)}${others.map((o) => `; ${o}`).join("")}}` : others.length ? `{ ${others.join("; ")}}` : "";
    if (a) {
      const s = text[a.start - 1] === " " ? a.start - 1 : a.start;
      put(s, a.end, pragma ? ` ${pragma}` : "");
    } else if (pragma) put(row.ranges.name.end, row.ranges.name.end, ` ${pragma}`);
    put(row.ranges.type.start, row.ranges.type.end, v);
    return { ok: true, version: model.version, edits };
  }

  if (op.op === "deleteRow") {
    const { start, end } = row.ranges.whole;
    const tail = Math.max(end, row.ranges.comment?.end ?? 0);
    const from = lineStart(text, start);
    const to = lineEnd(text, tail - 1);
    const before = text.slice(from, start);
    const after = text.slice(tail, to).trim();
    // the declaration has its lines to itself: they go whole
    if (!before.trim() && !after) return edit(from, to, "");
    // it shares a line with another declaration: only its own text goes
    if (after) {
      let e = tail;
      while (text[e] === " " || text[e] === "\t") e++;
      return edit(start, e, "");
    }
    // last on a shared line: from the spaces before it to the line's end, the EOL stays
    let s = start;
    while (s > from && (text[s - 1] === " " || text[s - 1] === "\t")) s--;
    const eolLen = /\r?\n$/.exec(text.slice(tail, to))?.[0].length ?? 0;
    return edit(s, to - eolLen, "");
  }

  if (op.op === "setStart") {
    if (row.kind === "struct") return { ok: false, reason: "Structs have no start value; set it on a member" };
    const v = op.value?.trim();
    const rule = startRule(model, sectionOf(model, row.id), v);
    if (rule) return { ok: false, reason: rule };
    if (v) {
      const bad = rowText({ name: row.name, type: "Int", start: v }, "");
      if (typeof bad !== "string") return { ok: false, reason: bad.reason };
    }
    if (row.ranges.start) {
      if (v) return edit(row.ranges.start.start, row.ranges.start.end, v);
      // " := value" goes, back to the end of the type
      return edit(row.ranges.type.end, row.ranges.start.end, "");
    }
    if (!v) return none;
    if (text[row.ranges.whole.end - 1] !== ";") return { ok: false, reason: "The declaration has no ';' yet" };
    return edit(row.ranges.type.end, row.ranges.type.end, ` := ${v}`);
  }

  if (op.op === "setComment") {
    const v = op.value?.trim();
    if (v && /[\r\n]/.test(v)) return { ok: false, reason: "A comment is one line." };
    if (row.ranges.comment) {
      // the comment keeps its kind: a block comment may have code after it on the line
      const old = text.slice(row.ranges.comment.start, row.ranges.comment.end);
      const block = old.startsWith("(*") ? ["(* ", " *)"] : old.startsWith("/*") ? ["/* ", " */"] : undefined;
      if (v && block && v.includes(block[1]!.trim())) return { ok: false, reason: `A comment in ${block[0]!.trim()} ${block[1]!.trim()} cannot contain "${block[1]!.trim()}".` };
      if (v) return edit(row.ranges.comment.start, row.ranges.comment.end, block ? `${block[0]}${v}${block[1]}` : `// ${v}`);
      let s = row.ranges.comment.start;
      while (s > 0 && (text[s - 1] === " " || text[s - 1] === "\t")) s--;
      return edit(s, row.ranges.comment.end, "");
    }
    if (!v) return none;
    // a // comment would hide what else stands on the line (a second declaration)
    const eol = text.indexOf("\n", row.ranges.whole.end);
    if (text.slice(row.ranges.whole.end, eol < 0 ? text.length : eol).trim()) return { ok: false, reason: "Another declaration follows on this line; put it on a line of its own first" };
    // TIA's export puts three spaces before a declaration's comment
    return edit(row.ranges.whole.end, row.ranges.whole.end, `   // ${v}`);
  }

  // setAttr: written as TIA writes it, an entry only for a value other than TIA's default
  const def = ATTR_DEFAULT[op.key.toUpperCase()];
  const remove = op.state === "default" || (def !== undefined && (op.state === "on") === def);
  const value = op.state === "on" ? "'True'" : "'False'";
  const a = row.ranges.attrs;
  if (!a) {
    if (remove) return none;
    return edit(row.ranges.name.end, row.ranges.name.end, ` { ${op.key} := ${value}}`);
  }
  const list = parseAttributes(text, a);
  const entry = list.entries.find((e) => e.key.toUpperCase() === op.key.toUpperCase());
  if (entry) {
    if (!remove) return entry.raw === value ? none : edit(entry.value_.start, entry.value_.end, value);
    if (list.entries.length === 1) {
      // the whole pragma and the space before it
      const s = text[a.start - 1] === " " ? a.start - 1 : a.start;
      return edit(s, a.end, "");
    }
    const idx = list.entries.indexOf(entry);
    if (idx < list.entries.length - 1) return edit(entry.entry.start, list.entries[idx + 1]!.entry.start, "");
    return edit(list.entries[idx - 1]!.entry.end, entry.entry.end, "");
  }
  if (remove) return none;
  const last = list.entries[list.entries.length - 1];
  const at = last ? last.entry.end : a.start + 1;
  return edit(at, at, last ? `; ${op.key} := ${value}` : ` ${op.key} := ${value}`);
}
