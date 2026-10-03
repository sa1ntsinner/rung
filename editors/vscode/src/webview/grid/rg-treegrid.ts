// SPDX-License-Identifier: MIT
// The tree-grid every rung table is drawn with: sections as quiet bands, rows that open into their members, one
// active cell moved by the keyboard (WAI-ARIA treegrid), and nothing else. Drawn in the page's own DOM so VS Code's
// theme and codicons apply as they are.
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type { GridColumn, GridRow, GridSection } from "./types";

type Line<R> = { kind: "band"; section: GridSection<R & GridRow> } | { kind: "row"; row: R; level: number; parentId?: string };

export class RgTreegrid<R extends GridRow = GridRow> extends LitElement {
  static override properties = {
    sections: { attribute: false },
    columns: { attribute: false },
    activeRow: { state: true },
    activeCol: { state: true },
    expanded: { attribute: false },
    focused: { state: true },
  };

  declare sections: GridSection<R>[];
  declare columns: GridColumn[];
  /** the rows open to show their members */
  declare expanded: Set<string>;
  declare activeRow: string | undefined;
  declare activeCol: number;
  declare focused: boolean;
  /** plain text of a cell: what is drawn unless renderCell draws more, and what a screen reader hears */
  cellText: (row: R, column: string) => string = () => "";
  /** a richer drawing of a cell (icons, muted parts); falls back to cellText */
  renderCell?: (row: R, column: string) => TemplateResult | string | typeof nothing;
  /** what a screen reader hears for a cell, when it differs from its text (attribute states) */
  cellLabel?: (row: R, column: string) => string;

  constructor() {
    super();
    this.sections = [];
    this.columns = [];
    this.expanded = new Set();
    this.activeCol = 0;
    this.focused = false;
  }

  protected override createRenderRoot() {
    return this;
  }

  /** The rows as drawn, sections first, children of open rows after their parent. */
  private lines(): Line<R>[] {
    const out: Line<R>[] = [];
    const walk = (rows: R[], level: number, parentId?: string) => {
      for (const row of rows) {
        out.push({ kind: "row", row, level, ...(parentId ? { parentId } : {}) });
        if (row.children?.length && this.expanded.has(row.id)) walk(row.children as R[], level + 1, row.id);
      }
    };
    for (const s of this.sections) {
      out.push({ kind: "band", section: s as GridSection<R & GridRow> });
      walk(s.rows, 1);
    }
    return out;
  }

  private rowLines(): Extract<Line<R>, { kind: "row" }>[] {
    return this.lines().filter((l): l is Extract<Line<R>, { kind: "row" }> => l.kind === "row");
  }

  /** Opens the rows above `rowId` and makes it the active row. */
  reveal(rowId: string): void {
    const parts = rowId.split("/");
    const next = new Set(this.expanded);
    for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
    this.expanded = next;
    // the owner keeps the expansion: told, so its next render does not close them again
    this.dispatchEvent(new CustomEvent("rg-expand", { detail: { expanded: [...next] }, bubbles: true }));
    this.activate(rowId);
  }

  private activate(rowId: string | undefined, col = this.activeCol) {
    this.activeRow = rowId;
    this.activeCol = Math.max(0, Math.min(col, this.columns.length - 1));
    if (rowId) this.dispatchEvent(new CustomEvent("rg-select", { detail: { rowId }, bubbles: true }));
    void this.updateComplete.then(() => this.querySelector(`[data-row="${CSS.escape(rowId ?? "")}"]`)?.scrollIntoView?.({ block: "nearest" }));
  }

  private toggle(rowId: string, open?: boolean) {
    const next = new Set(this.expanded);
    if (open ?? !next.has(rowId)) next.add(rowId);
    else next.delete(rowId);
    this.expanded = next;
    this.dispatchEvent(new CustomEvent("rg-expand", { detail: { expanded: [...next] }, bubbles: true }));
  }

  protected override willUpdate() {
    const rows = this.rowLines();
    if (!rows.some((l) => l.row.id === this.activeRow)) this.activeRow = rows[0]?.row.id;
    // fewer columns (another preset): the active cell stays on the grid
    this.activeCol = Math.max(0, Math.min(this.activeCol, this.columns.length - 1));
  }

  private onKey(e: KeyboardEvent) {
    const rows = this.rowLines();
    const i = rows.findIndex((l) => l.row.id === this.activeRow);
    if (i < 0) return;
    const cur = rows[i]!;
    const hasKids = !!cur.row.children?.length;
    const open = this.expanded.has(cur.row.id);
    const last = this.columns.length - 1;
    const move = (j: number, col = this.activeCol) => this.activate(rows[Math.max(0, Math.min(j, rows.length - 1))]!.row.id, col);
    switch (e.key) {
      case "ArrowDown":
        move(i + 1);
        break;
      case "ArrowUp":
        move(i - 1);
        break;
      case "ArrowRight":
        if (this.activeCol === 0 && hasKids && !open) this.toggle(cur.row.id, true);
        else if (this.activeCol === 0 && hasKids && open) move(i + 1);
        else if (this.activeCol < last) this.activeCol++;
        break;
      case "ArrowLeft":
        if (this.activeCol > 0) this.activeCol--;
        else if (hasKids && open) this.toggle(cur.row.id, false);
        else if (cur.parentId) this.activate(cur.parentId, 0);
        break;
      case "Home":
        if (e.ctrlKey || e.metaKey) move(0, 0);
        else this.activeCol = 0;
        break;
      case "End":
        if (e.ctrlKey || e.metaKey) move(rows.length - 1, last);
        else this.activeCol = last;
        break;
      case "PageDown":
        move(i + 10);
        break;
      case "PageUp":
        move(i - 10);
        break;
      case "Enter":
        this.dispatchEvent(new CustomEvent("rg-open", { detail: { rowId: cur.row.id, column: this.columns[this.activeCol]!.key }, bubbles: true }));
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  private template(): string {
    return this.columns.map((c) => (c.width ? `${c.width}px` : "minmax(160px, 1fr)")).join(" ");
  }

  /** As wide as the panel, never narrower than its fixed columns: a free column (comments) takes the rest and ellipsizes. */
  private minWidth(): number {
    return this.columns.reduce((n, c) => n + (c.width || 160), 0);
  }

  protected override render() {
    const lines = this.lines();
    // ids by position: names (温度, "A B") are not safe ids, positions are unique
    const index = new Map(lines.flatMap((l, n) => (l.kind === "row" ? [[l.row.id, n] as const] : [])));
    const cellId = (rowId: string, col: number) => `rg-c-${index.get(rowId) ?? "x"}-${col}`;
    const activeId = this.activeRow && index.has(this.activeRow) ? cellId(this.activeRow, this.activeCol) : undefined;
    // styles through the CSSOM (styleMap): the webview's CSP refuses style attributes
    return html`<div
      class="rg-grid ${this.focused ? "rg-focused" : ""}"
      role="treegrid"
      tabindex="0"
      aria-rowcount=${lines.length}
      aria-colcount=${this.columns.length}
      aria-activedescendant=${activeId ?? nothing}
      style=${styleMap({ "--rg-cols": this.template(), "min-width": `${this.minWidth()}px` })}
      @keydown=${(e: KeyboardEvent) => this.onKey(e)}
      @focus=${() => (this.focused = true)}
      @blur=${() => (this.focused = false)}
    >
      <div class="rg-head" role="row">
        ${this.columns.map((c) => html`<div class="rg-hcell rg-${c.align ?? "start"}" role="columnheader" title=${c.tooltip ?? c.label}>${c.label}</div>`)}
      </div>
      ${lines.map((l) =>
        l.kind === "band"
          ? html`<div class="rg-band" role="row"><div role="gridcell" class="rg-band-cell" aria-colspan=${this.columns.length}>
              <span class="rg-band-title">${l.section.title}</span>${l.section.note ? html`<span class="rg-band-note">${l.section.note}</span>` : nothing}<span class="rg-band-count">${l.section.rows.length}</span>
            </div></div>`
          : this.renderRow(l.row, l.level, cellId),
      )}
    </div>`;
  }

  private renderRow(row: R, level: number, cellId: (rowId: string, col: number) => string) {
    const hasKids = !!row.children?.length;
    const open = this.expanded.has(row.id);
    const selected = row.id === this.activeRow;
    return html`<div
      class="rg-row ${selected ? "rg-selected" : ""}"
      role="row"
      data-row=${row.id}
      aria-level=${level}
      aria-selected=${selected ? "true" : "false"}
      aria-expanded=${hasKids ? (open ? "true" : "false") : nothing}
      @click=${() => this.activate(row.id, this.activeCol)}
    >
      ${this.columns.map((c, ci) => {
        const text = this.cellText(row, c.key);
        const label = this.cellLabel?.(row, c.key) ?? text;
        const content = this.renderCell?.(row, c.key) ?? text;
        const isActive = selected && ci === this.activeCol;
        return html`<div
          id=${cellId(row.id, ci)}
          class="rg-cell rg-${c.align ?? "start"} ${c.mono ? "rg-mono" : ""} ${isActive ? "rg-active" : ""}"
          role="gridcell"
          data-col=${c.key}
          aria-label=${`${c.tooltip ?? c.label}: ${label}`}
          title=${ci === 0 ? nothing : text}
          @click=${(e: MouseEvent) => {
            e.stopPropagation();
            this.activate(row.id, ci);
          }}
          @dblclick=${() => this.dispatchEvent(new CustomEvent("rg-open", { detail: { rowId: row.id, column: c.key }, bubbles: true }))}
        >
          ${ci === 0
            ? html`<span class="rg-indent" style=${styleMap({ width: `${(row.depth ?? 0) * 16}px` })}></span><span
                  class="rg-twisty codicon ${hasKids ? (open ? "codicon-chevron-down" : "codicon-chevron-right") : ""}"
                  @click=${(e: MouseEvent) => {
                    if (!hasKids) return;
                    e.stopPropagation();
                    this.toggle(row.id);
                  }}
                ></span>`
            : nothing}<span class="rg-text">${content}</span>
        </div>`;
      })}
    </div>`;
  }
}

if (!customElements.get("rg-treegrid")) customElements.define("rg-treegrid", RgTreegrid);
