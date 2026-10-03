// SPDX-License-Identifier: MIT
// What the declarations table shows: its column presets, each cell's text and spoken label, and the filter.
import type { AttrState, DeclRow, DeclSection } from "../../protocol/declarations";
import type { GridColumn } from "../grid/types";

export type Preset = "code" | "hmi" | "commissioning";
export type AttrKey = "accessible" | "writable" | "visible" | "setpoint";

/** TIA Portal's names for the attribute columns, for tooltips, the inspector and screen readers. */
export const ATTR_LABEL: Record<AttrKey, string> = {
  accessible: "Accessible from HMI/OPC UA",
  writable: "Writable from HMI/OPC UA",
  visible: "Visible in HMI engineering",
  setpoint: "Setpoint",
};

const NAME: GridColumn = { key: "name", label: "Name", mono: true, width: 220 };
const TYPE: GridColumn = { key: "type", label: "Data type", mono: true, width: 180 };
const START: GridColumn = { key: "start", label: "Default value", mono: true, align: "end", width: 120 };
const COMMENT: GridColumn = { key: "comment", label: "Comment", width: 0 };
const attrColumn = (key: AttrKey, label: string): GridColumn => ({ key, label, tooltip: ATTR_LABEL[key], align: "center", width: 84 });

export const PRESETS: Record<Preset, { label: string; columns: GridColumn[] }> = {
  code: { label: "Code", columns: [NAME, TYPE, START, COMMENT] },
  hmi: { label: "HMI access", columns: [NAME, TYPE, attrColumn("accessible", "Accessible"), attrColumn("writable", "Writable"), attrColumn("visible", "Visible"), attrColumn("setpoint", "Setpoint"), COMMENT] },
  commissioning: { label: "Commissioning", columns: [NAME, TYPE, START, attrColumn("setpoint", "Setpoint"), COMMENT] },
};

export const isAttr = (column: string): column is AttrKey => column in ATTR_LABEL;

/** "Yes", "No (TIA default)": what an attribute cell says out loud. */
export function attrLabel(a: AttrState): string {
  return `${a.value ? "Yes" : "No"}${a.explicit ? "" : " (TIA default)"}`;
}

export function cellText(row: DeclRow, column: string): string {
  if (isAttr(column)) return row.hmi ? attrLabel(row.attrs[column]) : "Not applicable";
  switch (column) {
    case "name":
      return row.name;
    case "type":
      return row.type;
    case "start":
      return row.start ?? "";
    case "comment":
      return row.comment ?? "";
    default:
      return "";
  }
}

/** The rows whose name, type or comment contains the text, with the structs around them. */
export function filterSections(sections: DeclSection[], query: string): { sections: DeclSection[]; open: Set<string> } {
  const q = query.trim().toLowerCase();
  const open = new Set<string>();
  if (!q) return { sections, open };
  const hit = (r: DeclRow) => [r.name, r.type, r.comment ?? ""].some((s) => s.toLowerCase().includes(q));
  const keep = (rows: DeclRow[]): DeclRow[] =>
    rows.flatMap((r) => {
      const kids = r.children ? keep(r.children) : [];
      if (kids.length) {
        open.add(r.id);
        return [{ ...r, children: kids }];
      }
      return hit(r) ? [{ ...r, ...(r.children ? { children: hit(r) ? r.children : [] } : {}) }] : [];
    });
  return { sections: sections.map((s) => ({ ...s, rows: keep(s.rows) })).filter((s) => s.rows.length), open };
}

/** The row with this id, anywhere in the sections. */
export function findRow(sections: DeclSection[], id: string): { row: DeclRow; section: DeclSection } | undefined {
  const walk = (rows: DeclRow[]): DeclRow | undefined => {
    for (const r of rows) {
      if (r.id === id) return r;
      const c = r.children && walk(r.children);
      if (c) return c;
    }
    return undefined;
  };
  for (const section of sections) {
    const row = walk(section.rows);
    if (row) return { row, section };
  }
  return undefined;
}

/** How many declarations a section holds, members of structs included. */
export function countRows(rows: DeclRow[]): number {
  return rows.reduce((n, r) => n + 1 + (r.children ? countRows(r.children) : 0), 0);
}
