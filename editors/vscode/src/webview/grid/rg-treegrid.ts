// SPDX-License-Identifier: MIT
// The tree-grid every rung table is drawn with: sections as quiet bands, rows that open into their members, one
// active cell moved by the keyboard (WAI-ARIA treegrid), cells edited in place when the owner says they may be. The grid
// changes no data: it asks (rg-commit, rg-toggle, rg-insert, …) and the owner answers with new rows. Drawn in the page's
// own DOM so VS Code's theme and codicons apply as they are.
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { styleProps } from "./style-props";
import type { GridColumn, GridRow, GridSection } from "./types";

/** how a cell edits: text in an input, a flip of a Boolean, or not at all */
export type CellEdit = "text" | "toggle" | false;

type Line<R> = { kind: "band"; section: GridSection<R & GridRow> } | { kind: "row"; row: R; level: number; parentId?: string };

export class RgTreegrid<R extends GridRow = GridRow> extends LitElement {
  static override properties = {
    sections: { attribute: false },
    columns: { attribute: false },
    activeRow: { state: true },
    activeCol: { state: true },
    expanded: { attribute: false },
    focused: { state: true },
    editing: { state: true },
  };

  declare sections: GridSection<R>[];
  declare columns: GridColumn[];
  /** the rows open to show their members */
  declare expanded: Set<string>;
  declare activeRow: string | undefined;
  declare activeCol: number;
  declare focused: boolean;
  /** the cell open as an input */
  declare editing: { rowId: string; col: number; value: string; old: string } | undefined;
  /** how a cell edits; without it the grid only shows */
  editable?: (row: R, column: string) => CellEdit;
  /** a row as text for the clipboard (Ctrl+C); without it the grid copies nothing */
  copyText?: (row: R) => string;
  /** an input's suggestions: the id of a <datalist> on the page, per column */
  suggestions?: (column: string) => string | undefined;
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
    // the row being edited is gone (renamed, deleted elsewhere): its edit ends without a commit, and says what was typed
    if (this.editing && !this.findRow(this.editing.rowId)) {
      const lost = this.editing;
      this.editing = undefined;
      if (lost.value !== lost.old) this.emit("rg-edit-lost", { rowId: lost.rowId, column: this.columns[lost.col]?.key, value: lost.value });
    }
    const rows = this.rowLines();
    if (!rows.some((l) => l.row.id === this.activeRow)) this.activeRow = rows[0]?.row.id;
    // fewer columns (another preset): the active cell stays on the grid
    this.activeCol = Math.max(0, Math.min(this.activeCol, this.columns.length - 1));
  }

  private findRow(rowId: string): R | undefined {
    const walk = (rows: R[]): R | undefined => {
      for (const r of rows) {
        if (r.id === rowId) return r;
        const c = r.children && walk(r.children as R[]);
        if (c) return c;
      }
      return undefined;
    };
    for (const s of this.sections) {
      const r = walk(s.rows);
      if (r) return r;
    }
    return undefined;
  }

  private emit(type: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }

  /** Opens a cell as an input (a new row's name, a refused value to correct): its text, or `value`, all selected. */
  startEdit(rowId: string, column: string, value?: string): boolean {
    const row = this.findRow(rowId);
    const col = this.columns.findIndex((c) => c.key === column);
    if (!row || col < 0 || this.editable?.(row, column) !== "text") return false;
    if (rowId !== this.activeRow) this.reveal(rowId);
    this.activeCol = col;
    const old = this.cellText(row, column);
    this.editing = { rowId, col, value: value ?? old, old };
    this.selectOnOpen = value === undefined;
    return true;
  }

  private selectOnOpen = true;

  /** Closes the open cell without a commit (the rows now belong to another block). */
  cancelEdit(): void {
    this.editing = undefined;
  }

  private finishEdit(commit: boolean, refocus = true) {
    const ed = this.editing;
    if (!ed) return;
    const input = this.querySelector<HTMLInputElement>("input.rg-input");
    const value = input?.value ?? ed.value;
    this.editing = undefined;
    if (commit && value !== ed.old) this.emit("rg-commit", { rowId: ed.rowId, column: this.columns[ed.col]!.key, value, old: ed.old });
    // the keyboard stays in the table
    if (refocus) void this.updateComplete.then(() => this.querySelector<HTMLElement>('[role="treegrid"]')?.focus());
  }

  private onInputKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      this.finishEdit(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.finishEdit(true);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const ed = this.editing!;
      const row = this.findRow(ed.rowId)!;
      let next: string | undefined;
      const step = e.shiftKey ? -1 : 1;
      for (let c = ed.col + step; c >= 0 && c < this.columns.length && !next; c += step) if (this.editable?.(row, this.columns[c]!.key) === "text") next = this.columns[c]!.key;
      this.finishEdit(true, !next);
      if (next) this.startEdit(ed.rowId, next);
    }
  }

  private toggleCell(row: R, col: number) {
    this.emit("rg-toggle", { rowId: row.id, column: this.columns[col]!.key });
  }

  private onCopy(e: ClipboardEvent) {
    const row = this.activeRow ? this.findRow(this.activeRow) : undefined;
    if (!this.copyText || !row || this.editing) return;
    e.clipboardData?.setData("text/plain", this.copyText(row));
    e.preventDefault();
  }

  private onPaste(e: ClipboardEvent) {
    if (!this.editable || this.editing) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    e.preventDefault();
    this.emit("rg-paste", { text });
  }

  private onKey(e: KeyboardEvent) {
    // the document's undo needs no row (the last one may just have been deleted)
    if (this.editable && (e.ctrlKey || e.metaKey) && !e.altKey && /^[zy]$/i.test(e.key)) {
      this.emit(e.key.toLowerCase() === "y" || e.shiftKey ? "rg-redo" : "rg-undo", {});
      e.preventDefault();
      return;
    }
    const rows = this.rowLines();
    const i = rows.findIndex((l) => l.row.id === this.activeRow);
    if (i < 0) return;
    const cur = rows[i]!;
    if (this.editable && this.editKey(e, cur.row)) {
      e.preventDefault();
      return;
    }
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

  /** The keys that edit; true when one was handled. */
  private editKey(e: KeyboardEvent, row: R): boolean {
    const column = this.columns[this.activeCol]!.key;
    const how = this.editable!(row, column);
    const mod = e.ctrlKey || e.metaKey;
    // Alt+Up/Down: the owner moves the row (a test step) up or down
    if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      this.emit("rg-move", { rowId: row.id, by: e.key === "ArrowUp" ? -1 : 1 });
      return true;
    }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "z") this.emit(e.shiftKey ? "rg-redo" : "rg-undo", {});
      else if (k === "y") this.emit("rg-redo", {});
      else return false;
      return true;
    }
    switch (e.key) {
      case "Enter":
      case "F2":
        if (how === "toggle") this.toggleCell(row, this.activeCol);
        else if (how === "text") this.startEdit(row.id, column);
        // Enter on a cell that does not edit: its text in the editor; F2 does nothing
        else return e.key === "Enter" ? false : true;
        return true;
      case " ":
        if (how !== "toggle") return false;
        this.toggleCell(row, this.activeCol);
        return true;
      case "Insert":
        this.emit("rg-insert", { rowId: row.id });
        return true;
      case "Delete":
        this.emit("rg-delete", { rowId: row.id, column });
        return true;
    }
    // a character starts the edit with itself, as in a spreadsheet
    if (how === "text" && e.key.length === 1 && !e.altKey) {
      this.startEdit(row.id, column, e.key);
      return true;
    }
    return false;
  }

  protected override updated() {
    const input = this.querySelector<HTMLInputElement>("input.rg-input");
    if (input && document.activeElement !== input) {
      input.focus();
      if (this.selectOnOpen) input.select();
      else input.setSelectionRange(input.value.length, input.value.length);
    }
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
    // styles through the CSSOM only (styleProps): the webview's CSP refuses style attributes
    return html`<div
      class="rg-grid ${this.focused ? "rg-focused" : ""}"
      role="treegrid"
      tabindex="0"
      aria-rowcount=${lines.length}
      aria-colcount=${this.columns.length}
      aria-activedescendant=${activeId ?? nothing}
      style=${styleProps({ "--rg-cols": this.template(), "min-width": `${this.minWidth()}px` })}
      @keydown=${(e: KeyboardEvent) => this.onKey(e)}
      @paste=${(e: ClipboardEvent) => this.onPaste(e)}
      @copy=${(e: ClipboardEvent) => this.onCopy(e)}
      @focus=${() => (this.focused = true)}
      @blur=${() => (this.focused = false)}
    >
      <div class="rg-head" role="row">
        ${this.columns.map((c) => html`<div class="rg-hcell rg-${c.align ?? "start"}" role="columnheader" title=${c.tooltip ?? c.label}>${c.label}</div>`)}
      </div>
      ${lines.map((l) =>
        l.kind === "band"
          ? html`<div class="rg-band ${l.section.ghost ? "rg-band-ghost" : ""}" role="row"><div role="gridcell" class="rg-band-cell" aria-colspan=${this.columns.length}>
              <span class="rg-band-title">${l.section.title}</span>${l.section.note ? html`<span class="rg-band-note">${l.section.note}</span>` : nothing}${l.section.ghost ? nothing : html`<span class="rg-band-count">${l.section.rows.length}</span>`}${this.editable
                ? html`<button class="rg-band-add rg-icon-btn" tabindex="-1" title=${`Add a declaration to ${l.section.title}`} aria-label=${`Add a declaration to ${l.section.title}`} @click=${() => this.emit("rg-add", { sectionId: l.section.id })}><span class="codicon codicon-add"></span></button>`
                : nothing}
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
        const how = this.editable?.(row, c.key) ?? false;
        const editing = this.editing && this.editing.rowId === row.id && this.editing.col === ci;
        return html`<div
          id=${cellId(row.id, ci)}
          class="rg-cell rg-${c.align ?? "start"} ${c.mono ? "rg-mono" : ""} ${isActive ? "rg-active" : ""} ${editing ? "rg-editing" : ""} ${how ? `rg-edit-${how}` : ""}"
          role="gridcell"
          data-col=${c.key}
          aria-label=${`${c.tooltip ?? c.label}: ${label}`}
          title=${ci === 0 ? nothing : text}
          @click=${(e: MouseEvent) => {
            e.stopPropagation();
            if (editing) return;
            this.activate(row.id, ci);
            // a Boolean flips where it is clicked, as a check box does
            if (how === "toggle") this.toggleCell(row, ci);
          }}
          @dblclick=${() => {
            if (how === "text") this.startEdit(row.id, c.key);
            else if (how !== "toggle") this.emit("rg-open", { rowId: row.id, column: c.key });
          }}
        >
          ${ci === 0
            ? html`<span class="rg-indent" style=${styleProps({ width: `${(row.depth ?? 0) * 16}px` })}></span><span
                  class="rg-twisty codicon ${hasKids ? (open ? "codicon-chevron-down" : "codicon-chevron-right") : ""}"
                  @click=${(e: MouseEvent) => {
                    if (!hasKids) return;
                    e.stopPropagation();
                    this.toggle(row.id);
                  }}
                ></span>`
            : nothing}${editing
            ? html`<input
                class="rg-input ${c.mono ? "rg-mono" : ""}"
                aria-label=${c.tooltip ?? c.label}
                spellcheck="false"
                autocomplete="off"
                list=${this.suggestions?.(c.key) ?? nothing}
                .value=${this.editing!.value}
                @keydown=${(e: KeyboardEvent) => this.onInputKey(e)}
                @input=${(e: Event) => {
                  // the draft survives a redraw that makes a new input (rows above it came or went)
                  if (this.editing) this.editing.value = (e.target as HTMLInputElement).value;
                }}
                @click=${(e: MouseEvent) => e.stopPropagation()}
                @dblclick=${(e: MouseEvent) => e.stopPropagation()}
                @blur=${() => this.finishEdit(true)}
              />`
            : html`<span class="rg-text">${content}</span>`}
        </div>`;
      })}
    </div>`;
  }
}

if (!customElements.get("rg-treegrid")) customElements.define("rg-treegrid", RgTreegrid);
