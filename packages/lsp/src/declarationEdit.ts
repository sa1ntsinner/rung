// SPDX-License-Identifier: BUSL-1.1
// The text edits a declaration table makes (rung/declarationEdit): each replaces only its own span, in TIA's export
// style, and carries the old text so a stale apply can be refused. Nothing else in the file changes.
import { ATTR_DEFAULT, parseAttributes } from "./attributes.js";
import type { DeclModel, DeclRow } from "./declarations.js";

export type DeclOp =
  | { op: "setStart"; row: string; value: string | null }
  | { op: "setComment"; row: string; value: string | null }
  /** on/off as asked; an attribute TIA knows a default for is removed when the value is that default. default: remove. */
  | { op: "setAttr"; row: string; key: string; state: "on" | "off" | "default" };

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

export function planDeclarationEdit(text: string, model: DeclModel, op: DeclOp): EditPlan {
  if (!model.editable) return { ok: false, reason: model.reason ?? "Read only" };
  const row = model.sections.map((s) => find(s.rows, op.row)).find(Boolean);
  if (!row) return { ok: false, reason: `No declaration ${op.row}` };
  const none: EditPlan = { ok: true, version: model.version, edits: [] };
  const edit = (start: number, end: number, t: string): EditPlan => ({ ok: true, version: model.version, edits: [{ start, end, old: text.slice(start, end), text: t }] });

  if (op.op === "setStart") {
    if (row.kind === "struct") return { ok: false, reason: "Structs have no start value; set it on a member" };
    const v = op.value?.trim();
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
    if (row.ranges.comment) {
      if (v) return edit(row.ranges.comment.start, row.ranges.comment.end, `// ${v}`);
      let s = row.ranges.comment.start;
      while (s > 0 && (text[s - 1] === " " || text[s - 1] === "\t")) s--;
      return edit(s, row.ranges.comment.end, "");
    }
    if (!v) return none;
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
