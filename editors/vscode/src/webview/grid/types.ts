// SPDX-License-Identifier: MIT
// The shapes the shared tree-grid draws: columns, rows that may hold child rows, and sections between them.

export interface GridColumn {
  key: string;
  label: string;
  /** the long name (TIA's), for the tooltip and screen readers */
  tooltip?: string;
  /** names, types and values: the editor's font */
  mono?: boolean;
  align?: "start" | "end" | "center";
  /** px; 0 takes the rest of the width */
  width: number;
}

export interface GridRow {
  id: string;
  depth: number;
  children?: GridRow[];
}

export interface GridSection<R extends GridRow = GridRow> {
  id: string;
  title: string;
  /** a short note after the title, e.g. RETAIN */
  note?: string;
  /** a section the owner can add (the block does not have it yet): drawn quietly, with its + */
  ghost?: boolean;
  rows: R[];
}

/** The narrowest a wide column gets before the panel scrolls sideways: the free column (comments) stays in view. */
const floor = (c: GridColumn) => (!c.width ? 100 : c.width > 80 ? Math.max(80, Math.round(c.width * 0.55)) : c.width);

/** grid-template-columns: wide columns give way down to their floor in a narrow panel, the free one takes the rest. */
export function columnsTemplate(columns: GridColumn[]): string {
  return columns.map((c) => (!c.width ? `minmax(${floor(c)}px, 1fr)` : floor(c) < c.width ? `minmax(${floor(c)}px, ${c.width}px)` : `${c.width}px`)).join(" ");
}

/** Narrower than this the grid scrolls sideways. */
export function columnsMinWidth(columns: GridColumn[]): number {
  return columns.reduce((n, c) => n + floor(c), 0);
}
