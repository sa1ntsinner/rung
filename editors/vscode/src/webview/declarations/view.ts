// SPDX-License-Identifier: MIT
// The declarations view beside an SCL editor: the block's interface as a quiet table, a filter, three column
// presets, an inspector for the selected declaration, and editing in place. It changes no text itself: every edit goes
// to the extension as a checked message (protocol/declarations.ts) and comes back as a new model.
import { LitElement, html, nothing } from "lit";
import type { DeclModel, DeclOp, DeclRow, HostToView, NewRow, OpenTarget, PasteResult, ViewContext, ViewToHost } from "../../protocol/declarations";
import type { GridSection } from "../grid/types";
import "../grid/rg-treegrid";
import type { CellEdit, RgTreegrid } from "../grid/rg-treegrid";
import { ATTR_LABEL, PRESETS, attrLabel, cellText, countRows, filterSections, findRow, isAttr, type AttrKey, type Preset } from "./columns";

interface VsCodeApi {
  postMessage(m: ViewToHost): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;
const vscode = () => (api ??= acquireVsCodeApi());

interface SavedState {
  preset?: Preset;
  expanded?: string[];
}

const ATTRS: AttrKey[] = ["accessible", "writable", "visible", "setpoint"];
const SHORT: Record<AttrKey, string> = { accessible: "Accessible", writable: "Writable", visible: "Visible", setpoint: "Setpoint" };
/** the attribute TIA writes for each column */
const ATTR_KEY: Record<AttrKey, string> = { accessible: "ExternalAccessible", writable: "ExternalWritable", visible: "ExternalVisible", setpoint: "S7_SetPoint" };
const TYPES_LIST = "rg-types";

/** a message that asks for a change, as the view writes it (the request number and the file are added) */
type Request = Extract<ViewToHost, { req: number }> extends infer M ? (M extends unknown ? Omit<M, "v" | "req" | "uri"> : never) : never;
/** what a request was about: a refused cell edit opens again with its draft */
type Pending = { rowId: string; column: string; value: string } | undefined;

export class RgDeclarations extends LitElement {
  static override properties = {
    model: { state: true },
    context: { state: true },
    state: { state: true },
    preset: { state: true },
    filter: { state: true },
    selected: { state: true },
    notice: { state: true },
    paste: { state: true },
    typeNames: { state: true },
  };

  declare model: DeclModel | undefined;
  declare context: ViewContext | undefined;
  declare state: "loading" | "noServer" | "noBlock" | undefined;
  declare preset: Preset;
  declare filter: string;
  declare selected: string | undefined;
  /** the last refusal, said in the status line until the next edit */
  declare notice: string | undefined;
  /** pasted rows waiting for the user's yes */
  declare paste: { result: PasteResult; after?: string; section?: string } | undefined;
  declare typeNames: string[];
  private expanded: Set<string>;
  private req = 0;
  private readonly pending = new Map<number, Pending>();
  /** a cell to open once the model has its row (a new declaration's name) */
  private editNext: { rowId: string; column: string } | undefined;
  private readonly onMessage = (e: MessageEvent) => this.receive(e.data as HostToView);

  constructor() {
    super();
    const saved = (vscode().getState() ?? {}) as SavedState;
    this.preset = saved.preset && saved.preset in PRESETS ? saved.preset : "code";
    this.expanded = new Set(saved.expanded ?? []);
    this.filter = "";
    this.state = "loading";
    this.typeNames = [];
  }

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("message", this.onMessage);
    this.post({ v: 1, kind: "ready" });
  }

  override disconnectedCallback() {
    window.removeEventListener("message", this.onMessage);
    super.disconnectedCallback();
  }

  protected override updated(changed: Map<string, unknown>) {
    // the paste preview takes the keyboard: Enter inserts, Escape cancels
    if (changed.has("paste") && this.paste) this.querySelector<HTMLElement>(".rg-dialog .rg-primary, .rg-dialog .rg-secondary")?.focus();
  }

  private post(m: ViewToHost) {
    vscode().postMessage(m);
  }

  private save() {
    vscode().setState({ preset: this.preset, expanded: [...this.expanded] } satisfies SavedState);
  }

  private receive(m: HostToView) {
    if (!m || m.v !== 1) return;
    if (m.kind === "model") {
      this.model = m.model;
      this.context = m.context;
      this.state = undefined;
    } else if (m.kind === "state") {
      this.state = m.state;
      if (m.context) this.context = m.context;
    } else if (m.kind === "reveal") {
      void this.updateComplete.then(() => this.grid()?.reveal(m.rowId));
    } else if (m.kind === "result") {
      this.result(m);
    } else if (m.kind === "pastePreview") {
      if (!this.pending.has(m.req)) return;
      this.pending.delete(m.req);
      this.paste = { result: m.result, ...this.target() };
    } else if (m.kind === "types") {
      this.typeNames = [...m.elementary, ...m.types.map((t) => t.name)];
    }
    // a new row's name opens once the model has the row
    if (m.kind === "model" && this.editNext && findRow(m.model.sections, this.editNext.rowId)) {
      const next = this.editNext;
      this.editNext = undefined;
      void this.updateComplete.then(async () => {
        const g = this.grid();
        await g?.updateComplete;
        g?.startEdit(next.rowId, next.column);
      });
    }
  }

  // ---------- editing ----------

  /** How a cell edits: nothing in a read-only block; a struct has no type or value of its own. */
  private readonly editable = (row: DeclRow, column: string): CellEdit => {
    if (isAttr(column)) return row.hmi ? "toggle" : false;
    if ((column === "type" || column === "start") && row.kind === "struct") return false;
    return column === "name" || column === "type" || column === "start" || column === "comment" ? "text" : false;
  };

  private send(m: Request, pending?: Pending): void {
    const req = ++this.req;
    this.pending.set(req, pending);
    this.notice = undefined;
    this.post({ v: 1, req, uri: this.model!.uri, ...m } as ViewToHost);
  }

  private op(op: DeclOp, pending?: Pending) {
    this.send({ kind: "edit", version: this.model!.version, op }, pending);
  }

  private commit(rowId: string, column: string, value: string) {
    const pending = { rowId, column, value };
    if (column === "name") return this.send({ kind: "rename", version: this.model!.version, rowId, name: value }, pending);
    if (column === "type") return this.op({ op: "setType", row: rowId, type: value }, pending);
    const v = value.trim() ? value : null;
    if (column === "start") return this.op({ op: "setStart", row: rowId, value: v }, pending);
    if (column === "comment") return this.op({ op: "setComment", row: rowId, value: v }, pending);
  }

  private toggle(rowId: string, column: string) {
    const hit = this.model && findRow(this.model.sections, rowId);
    if (!hit || !isAttr(column)) return;
    this.op({ op: "setAttr", row: rowId, key: ATTR_KEY[column], state: hit.row.attrs[column].value ? "off" : "on" });
  }

  /** Delete: on a value it clears the value (an attribute back to TIA's default), on the name or type the row goes. */
  private clearOrDelete(rowId: string, column: string) {
    if (isAttr(column)) return this.op({ op: "setAttr", row: rowId, key: ATTR_KEY[column], state: "default" });
    if (column === "start") return this.op({ op: "setStart", row: rowId, value: null });
    if (column === "comment") return this.op({ op: "setComment", row: rowId, value: null });
    this.send({ kind: "delete", version: this.model!.version, rowId });
  }

  /** Where new rows go: after the selected row, else at the end of the first section that is not a constant. */
  private target(): { after: string } | { section: string } | undefined {
    if (this.selected && this.model && findRow(this.model.sections, this.selected)) return { after: this.selected };
    const s = this.model?.sections.find((x) => x.title === "Static") ?? this.model?.sections.find((x) => x.title !== "Constant") ?? this.model?.sections[0];
    return s ? { section: s.id } : undefined;
  }

  private applyPaste() {
    const p = this.paste;
    this.paste = undefined;
    if (!p?.result.rows.length) return;
    this.op({ op: "insertRows", ...(p.after ? { after: p.after } : p.section ? { section: p.section } : {}), rows: p.result.rows });
  }

  private result(m: Extract<HostToView, { kind: "result" }>) {
    const pending = this.pending.get(m.req);
    this.pending.delete(m.req);
    if (m.ok) {
      if (m.edit) this.editNext = m.edit;
      return;
    }
    // cancelled (a question the user said no to): nothing to say
    if (!m.reason) return;
    this.notice = m.reason;
    // the refused value opens again, as typed, to be corrected
    if (pending) void this.updateComplete.then(() => this.grid()?.startEdit(pending.rowId, pending.column, pending.value));
  }

  private grid() {
    return this.querySelector<RgTreegrid<DeclRow>>("rg-treegrid");
  }

  /** One row as TIA's table columns, tab-separated: what Ctrl+C copies and Ctrl+V reads back. */
  private readonly copyText = (row: DeclRow) => [row.name, row.type, row.start ?? "", row.comment ?? ""].map((f) => (/[\t\n"]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join("\t");

  private open(rowId: string, column: string) {
    const target: OpenTarget = column === "type" || column === "start" || column === "comment" ? column : "name";
    this.post({ v: 1, kind: "open", rowId, target });
  }

  // ---------- drawing ----------

  protected override render() {
    return html`<div class="rg-app">${this.renderHeader()}${this.state ? this.renderState() : this.renderTable()}</div>`;
  }

  private renderHeader() {
    const block = this.model?.block;
    const file = this.context?.file ?? "";
    const folder = file.split("/").slice(0, -1).filter((p, i) => !(i === 0 && p === "plc")).join(" / ");
    const pinned = this.context?.pinned ?? false;
    return html`<header class="rg-header">
      <div class="rg-title">
        <span class="rg-title-name">${block?.name ?? "Declarations"}</span>
        ${block ? html`<span class="rg-kind">${block.kind}</span>` : nothing}
        <span class="rg-crumbs">${folder}</span>
      </div>
${this.context?.fixed ? nothing : html`      <button class="rg-icon-btn" aria-pressed=${pinned ? "true" : "false"} title=${pinned ? "Unpin: follow the active SCL editor" : "Pin to this block"} aria-label=${pinned ? "Unpin" : "Pin"} @click=${() => this.post({ v: 1, kind: "pin", pinned: !pinned })}>
        <span class="codicon ${pinned ? "codicon-pinned" : "codicon-pin"}"></span>
      </button>`}
      <button class="rg-icon-btn" title="Open text" aria-label="Open text" @click=${() => this.post({ v: 1, kind: "openText" })}>
        <span class="codicon codicon-go-to-file"></span>
      </button>
    </header>`;
  }

  private renderState() {
    const text = this.state === "noServer" ? "The rung language server is not running." : this.state === "noBlock" ? "This file has no block." : "Reading declarations…";
    return html`<div></div><div></div>
      <div class="rg-body rg-no-inspector">
        <div class="rg-state">
          <span>${text}</span>
          ${this.state === "noServer" ? html`<button class="rg-primary" @click=${() => this.post({ v: 1, kind: "openText" })}>Open text</button>` : nothing}
        </div>
      </div>
      <div class="rg-status"></div>`;
  }

  private renderTable() {
    const model = this.model!;
    const { sections, open } = filterSections(model.sections, this.filter);
    const expanded = new Set([...this.expanded, ...open]);
    // RETAIN is worth a note; CONSTANT is already the section's title
    const note = (s: { modifiers: string[] }) => s.modifiers.filter((m) => m !== "CONSTANT").join(" ");
    const grid: GridSection<DeclRow>[] = sections.map((s) => ({ id: s.id, title: s.title, ...(note(s) ? { note: note(s) } : {}), rows: s.rows }));
    const columns = PRESETS[this.preset].columns;
    const total = model.sections.reduce((n, s) => n + countRows(s.rows), 0);
    const picked = this.selected ? findRow(model.sections, this.selected) : undefined;
    return html`
      <div class="rg-toolbar">
        <label class="rg-filter">
          <span class="codicon codicon-filter"></span>
          <input type="text" placeholder="Filter" aria-label="Filter declarations by name, type or comment" .value=${this.filter} @input=${(e: Event) => (this.filter = (e.target as HTMLInputElement).value)} />
        </label>
        ${model.editable
          ? html`<div class="rg-tools" role="group" aria-label="Declarations">
              <button class="rg-icon-btn" data-action="add" title="Add a declaration below (Insert)" aria-label="Add a declaration" @click=${() => {
                const t = this.target();
                if (t) this.send({ kind: "add", version: model.version, ...t });
              }}><span class="codicon codicon-add"></span></button>
              <button class="rg-icon-btn" data-action="delete" title="Delete the declaration" aria-label="Delete the declaration" ?disabled=${!picked} @click=${() => picked && this.send({ kind: "delete", version: model.version, rowId: picked.row.id })}><span class="codicon codicon-trash"></span></button>
            </div>`
          : nothing}
        <div class="rg-presets" role="group" aria-label="Columns">
          ${(Object.keys(PRESETS) as Preset[]).map(
            (p) => html`<button class="rg-text-btn" data-preset=${p} aria-pressed=${p === this.preset ? "true" : "false"} @click=${() => {
              this.preset = p;
              this.save();
            }}>${PRESETS[p].label}</button>`,
          )}
        </div>
      </div>
      ${model.unavailable.length
        ? html`<div class="rg-notice" role="status"><span class="codicon codicon-warning"></span><span>Part of the declarations could not be read. Fix the text to see all of it.</span><button class="rg-link" @click=${() => this.post({ v: 1, kind: "openText" })}>Open text</button></div>`
        : html`<div></div>`}
      <div class="rg-body ${picked ? "" : "rg-no-inspector"}">
        <div class="rg-scroll">
          ${grid.length
            ? html`<rg-treegrid
                .sections=${grid}
                .columns=${columns}
                .expanded=${expanded}
                .cellText=${cellText}
                .renderCell=${(row: DeclRow, column: string) => this.cell(row, column)}
                .editable=${model.editable ? this.editable : undefined}
                .suggestions=${(c: string) => (c === "type" && this.typeNames.length ? TYPES_LIST : undefined)}
                .copyText=${this.copyText}
                @rg-select=${(e: CustomEvent<{ rowId: string }>) => (this.selected = e.detail.rowId)}
                @rg-open=${(e: CustomEvent<{ rowId: string; column: string }>) => this.open(e.detail.rowId, e.detail.column)}
                @rg-commit=${(e: CustomEvent<{ rowId: string; column: string; value: string }>) => this.commit(e.detail.rowId, e.detail.column, e.detail.value)}
                @rg-toggle=${(e: CustomEvent<{ rowId: string; column: string }>) => this.toggle(e.detail.rowId, e.detail.column)}
                @rg-insert=${(e: CustomEvent<{ rowId: string }>) => this.send({ kind: "add", version: model.version, after: e.detail.rowId })}
                @rg-add=${(e: CustomEvent<{ sectionId: string }>) => this.send({ kind: "add", version: model.version, section: e.detail.sectionId })}
                @rg-delete=${(e: CustomEvent<{ rowId: string; column: string }>) => this.clearOrDelete(e.detail.rowId, e.detail.column)}
                @rg-paste=${(e: CustomEvent<{ text: string }>) => this.send({ kind: "paste", text: e.detail.text })}
                @rg-undo=${() => this.post({ v: 1, kind: "undo" })}
                @rg-redo=${() => this.post({ v: 1, kind: "redo" })}
                @keydown=${(e: KeyboardEvent) => this.navKey(e)}
                @rg-expand=${(e: CustomEvent<{ expanded: string[] }>) => {
                  this.expanded = new Set(e.detail.expanded);
                  this.save();
                }}
              ></rg-treegrid>`
            : html`<div class="rg-state">${this.filter ? html`<span>No declarations match.</span><button class="rg-link" @click=${() => (this.filter = "")}>Clear filter</button>` : html`<span>No declarations in this block.</span>`}</div>`}
        </div>
        ${picked ? this.renderInspector(picked.row, picked.section.title) : nothing}
        ${this.paste ? this.renderPaste(this.paste.result) : nothing}
      </div>
      ${this.typeNames.length ? html`<datalist id=${TYPES_LIST}>${this.typeNames.map((t) => html`<option value=${t}></option>`)}</datalist>` : nothing}
      <div class="rg-status">
        ${this.notice
          ? html`<span class="rg-refusal" role="alert"><span class="codicon codicon-warning"></span>${this.notice}</span>`
          : html`<span>${total} ${total === 1 ? "declaration" : "declarations"}</span>`}
        ${model.editable ? nothing : html`<span>${model.reason ?? "Read only"}</span>`}
        <span class="rg-spacer"></span>
        ${this.context?.dirty ? html`<span class="rg-dirty">Edited, not saved</span>` : nothing}
      </div>`;
  }

  private cell(row: DeclRow, column: string) {
    if (isAttr(column)) {
      if (!row.hmi) return nothing;
      const a = row.attrs[column];
      if (!a.value && !a.explicit) return nothing;
      return html`<span class="rg-attr codicon ${a.value ? "codicon-check" : "codicon-circle-slash"} ${a.explicit ? "" : "rg-default"}" title=${attrLabel(a)}></span>`;
    }
    if (column === "type" && row.kind === "struct") return html`<span class="rg-muted">Struct · ${row.children?.length ?? 0}</span>`;
    if (column === "comment") return html`<span class="rg-muted">${row.comment ?? ""}</span>`;
    return cellText(row, column);
  }

  /** F12: the selected declaration's type; Shift+F12: where it is used (VS Code's keys). */
  private navKey(e: KeyboardEvent) {
    if (e.key !== "F12" || !this.selected) return;
    e.preventDefault();
    this.post(e.shiftKey ? { v: 1, kind: "usages", rowId: this.selected } : { v: 1, kind: "openType", rowId: this.selected });
  }

  private renderPaste(r: PasteResult) {
    const n = r.rows.length;
    const where = this.paste?.after ? `below ${this.paste.after.split("/").pop()!.replace(/%2F/g, "/").replace(/%25/g, "%")}` : "at the end of the section";
    const cancel = () => {
      this.paste = undefined;
      void this.updateComplete.then(() => this.querySelector<HTMLElement>('[role="treegrid"]')?.focus());
    };
    return html`<div class="rg-dialog" role="dialog" aria-modal="true" aria-label="Paste declarations" @keydown=${(e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), cancel())}>
      <div class="rg-dialog-title">${n ? `Insert ${n} ${n === 1 ? "declaration" : "declarations"} ${where}` : "Nothing to insert"}</div>
      ${n
        ? html`<div class="rg-dialog-table" role="table">
            ${r.rows.map((x: NewRow) => html`<div class="rg-dialog-row" role="row"><span class="rg-mono" role="cell">${x.name}</span><span class="rg-mono" role="cell">${x.type}</span><span class="rg-mono" role="cell">${x.start ?? ""}</span><span class="rg-muted" role="cell">${x.comment ?? ""}</span></div>`)}
          </div>`
        : nothing}
      ${r.errors.length
        ? html`<ul class="rg-dialog-errors">${r.errors.map((e) => html`<li><span class="codicon codicon-warning"></span>Line ${e.line}: ${e.message}</li>`)}</ul>`
        : nothing}
      <div class="rg-dialog-actions">
        ${n ? html`<button class="rg-primary" @click=${() => this.applyPaste()}>Insert</button>` : nothing}
        <button class="rg-secondary" @click=${cancel}>Cancel</button>
      </div>
    </div>`;
  }

  private renderInspector(row: DeclRow, section: string) {
    // the id's parts carry % and / escaped
    const path = row.id.split("/").map((p) => p.replace(/%2F/g, "/").replace(/%25/g, "%"));
    const field = (label: string, value: unknown, mono = false, title?: string) => html`<div class="rg-field"><span class="rg-field-label" title=${title ?? label}>${label}</span><span class="rg-field-value ${mono ? "rg-mono" : ""}">${value}</span></div>`;
    const typeValue = row.typeRef && row.kind !== "struct"
      ? html`<button class="rg-link rg-mono" title="Open type" @click=${() => this.post({ v: 1, kind: "openType", rowId: row.id })}>${row.type}</button>`
      : row.type;
    return html`<aside class="rg-inspector" aria-label="Selected declaration">
      <div class="rg-insp-name">${row.name}</div>
      <div class="rg-insp-path">${path.length > 1 ? path.join(" / ") : section}</div>
      <div class="rg-insp-group">
        ${field("Data type", typeValue, true)}
        ${row.kind === "struct" ? nothing : field("Default value", row.start ?? html`<span class="rg-muted">none</span>`, true)}
        ${field("Comment", row.comment ?? html`<span class="rg-muted">none</span>`)}
      </div>
      <div class="rg-insp-group">
        <div class="rg-insp-group-title">HMI / OPC UA</div>
        ${row.hmi ? nothing : html`<div class="rg-muted">Not used for temporary variables and constants.</div>`}
        ${(row.hmi ? ATTRS : []).map((k) => {
          const a = row.attrs[k];
          if (!this.model?.editable) return field(SHORT[k], html`${a.value ? "Yes" : "No"}${a.explicit ? nothing : html` <span class="rg-muted">default</span>`}`, false, ATTR_LABEL[k]);
          const set = (state: "on" | "off" | "default") => this.op({ op: "setAttr", row: row.id, key: ATTR_KEY[k], state });
          return field(
            SHORT[k],
            html`<span class="rg-seg-line" data-attr=${k}>
              <span class="rg-seg" role="group" aria-label=${ATTR_LABEL[k]}>
                <button class="rg-text-btn" data-state="on" aria-pressed=${a.value ? "true" : "false"} @click=${() => !a.value && set("on")}>Yes</button><button class="rg-text-btn" data-state="off" aria-pressed=${a.value ? "false" : "true"} @click=${() => a.value && set("off")}>No</button>
              </span>
              ${a.explicit ? html`<button class="rg-link rg-reset" data-state="default" title="Back to TIA Portal's default" @click=${() => set("default")}>Reset</button>` : html`<span class="rg-muted">default</span>`}
            </span>`,
            false,
            ATTR_LABEL[k],
          );
        })}
      </div>
      ${row.other.length
        ? html`<div class="rg-insp-group"><div class="rg-insp-group-title">Other attributes</div>${row.other.map((o) => field(o.key, o.value, true))}</div>`
        : nothing}
      <div class="rg-actions">
        <button class="rg-link" data-action="usages" @click=${() => this.post({ v: 1, kind: "usages", rowId: row.id })}><span class="codicon codicon-references"></span>Where used</button>
        <button class="rg-link" data-action="text" @click=${() => this.post({ v: 1, kind: "open", rowId: row.id, target: "name" })}><span class="codicon codicon-go-to-file"></span>Show in text</button>
      </div>
    </aside>`;
  }
}

if (!customElements.get("rg-declarations")) customElements.define("rg-declarations", RgDeclarations);
