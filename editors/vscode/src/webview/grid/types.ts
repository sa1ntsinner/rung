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
