// SPDX-License-Identifier: BUSL-1.1
// Rows pasted into a declaration table (rung/declarationPaste): tab-separated text from Excel or TIA Portal's interface
// table, read into new declarations for a preview. Nothing is written here; insertRows writes what the user confirms.
import type { NewRow } from "./declarationEdit.js";

export interface PasteResult {
  rows: NewRow[];
  /** by line of the pasted text, 1-based */
  errors: { line: number; message: string }[];
}

type Column = "name" | "type" | "start" | "comment";
/** TIA's column names, English and German */
const HEADER: Record<string, Column> = {
  name: "name",
  "data type": "type",
  datentyp: "type",
  type: "type",
  "default value": "start",
  standardwert: "start",
  "start value": "start",
  startwert: "start",
  comment: "comment",
  kommentar: "comment",
};

/** Excel's TSV: fields split by tabs, a quoted field may hold tabs, "" and line breaks. Records with their first line. */
function records(text: string): { line: number; fields: string[] }[] {
  const out: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let line = 1;
  let first = 1;
  let i = 0;
  const end = () => {
    fields.push(field);
    if (fields.some((f) => f.trim())) out.push({ line: first, fields });
    fields = [];
    field = "";
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' && field === "") {
      // a quoted field
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (text[i] === "\n") line++;
        field += text[i++];
      }
      // Excel quotes only a field with a tab, a line break or a quote: "T_Pos" is TIA's own quoting, kept as text
      if (!/[\t\n\r"]/.test(field)) field = `"${field}"`;
      // a quote that only opened a field followed by more text keeps its text
      while (i < text.length && text[i] !== "\t" && text[i] !== "\n" && text[i] !== "\r") field += text[i++];
      continue;
    }
    if (c === "\t") {
      fields.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      end();
      line++;
      first = line;
    } else field += c;
    i++;
  }
  if (field || fields.length) end();
  return out;
}

const clean = (v: string | undefined) => v?.replace(/\s*\r?\n\s*/g, " ").trim() ?? "";

export function parsePastedRows(text: string): PasteResult {
  const recs = records(text);
  const result: PasteResult = { rows: [], errors: [] };
  if (!recs.length) return result;
  const head = recs[0]!.fields.map((f) => HEADER[f.trim().toLowerCase()]);
  const hasHeader = head.includes("name") && head.includes("type");
  const columns: (Column | undefined)[] = hasHeader ? head : ["name", "type", "start", "comment"];
  for (const r of hasHeader ? recs.slice(1) : recs) {
    const v: Partial<Record<Column, string>> = {};
    r.fields.forEach((f, i) => {
      const c = columns[i];
      if (c && v[c] === undefined) v[c] = clean(f);
    });
    // TIA shows a quoted name ("30ms"); the quotes are not part of it
    const name = (v.name ?? "").replace(/^"(.*)"$/, "$1");
    if (!name) {
      result.errors.push({ line: r.line, message: "A row has no name." });
      continue;
    }
    if (!v.type) {
      result.errors.push({ line: r.line, message: `"${name}" has no data type.` });
      continue;
    }
    result.rows.push({ name, type: v.type, ...(v.start ? { start: v.start } : {}), ...(v.comment ? { comment: v.comment } : {}) });
  }
  return result;
}
