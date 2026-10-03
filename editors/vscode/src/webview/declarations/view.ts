// SPDX-License-Identifier: MIT
// The declarations view beside an SCL editor: the block's interface as a quiet table, a filter, three column
// presets, and an inspector for the selected declaration. It only shows; every action goes to the extension as a
// checked message (protocol/declarations.ts).
import { LitElement, html, nothing } from "lit";
import type { DeclModel, DeclRow, HostToView, OpenTarget, ViewContext, ViewToHost } from "../../protocol/declarations";
import type { GridSection } from "../grid/types";
import "../grid/rg-treegrid";
import type { RgTreegrid } from "../grid/rg-treegrid";
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

export class RgDeclarations extends LitElement {
  static override properties = {
    model: { state: true },
    context: { state: true },
    state: { state: true },
    preset: { state: true },
    filter: { state: true },
    selected: { state: true },
  };

  declare model: DeclModel | undefined;
  declare context: ViewContext | undefined;
  declare state: "loading" | "noServer" | "noBlock" | undefined;
  declare preset: Preset;
  declare filter: string;
  declare selected: string | undefined;
  private expanded: Set<string>;
  private readonly onMessage = (e: MessageEvent) => this.receive(e.data as HostToView);

  constructor() {
    super();
    const saved = (vscode().getState() ?? {}) as SavedState;
    this.preset = saved.preset && saved.preset in PRESETS ? saved.preset : "code";
    this.expanded = new Set(saved.expanded ?? []);
    this.filter = "";
    this.state = "loading";
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
      void this.updateComplete.then(() => this.querySelector<RgTreegrid<DeclRow>>("rg-treegrid")?.reveal(m.rowId));
    }
  }

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
      <button class="rg-icon-btn" aria-pressed=${pinned ? "true" : "false"} title=${pinned ? "Unpin: follow the active SCL editor" : "Pin to this block"} aria-label=${pinned ? "Unpin" : "Pin"} @click=${() => this.post({ v: 1, kind: "pin", pinned: !pinned })}>
        <span class="codicon ${pinned ? "codicon-pinned" : "codicon-pin"}"></span>
      </button>
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
                @rg-select=${(e: CustomEvent<{ rowId: string }>) => (this.selected = e.detail.rowId)}
                @rg-open=${(e: CustomEvent<{ rowId: string; column: string }>) => this.open(e.detail.rowId, e.detail.column)}
                @rg-expand=${(e: CustomEvent<{ expanded: string[] }>) => {
                  this.expanded = new Set(e.detail.expanded);
                  this.save();
                }}
              ></rg-treegrid>`
            : html`<div class="rg-state">${this.filter ? html`<span>No declarations match.</span><button class="rg-link" @click=${() => (this.filter = "")}>Clear filter</button>` : html`<span>No declarations in this block.</span>`}</div>`}
        </div>
        ${picked ? this.renderInspector(picked.row, picked.section.title) : nothing}
      </div>
      <div class="rg-status">
        <span>${total} ${total === 1 ? "declaration" : "declarations"}</span>
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

  private renderInspector(row: DeclRow, section: string) {
    const path = row.id.split("/");
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
          return field(SHORT[k], html`${a.value ? "Yes" : "No"}${a.explicit ? nothing : html` <span class="rg-muted">default</span>`}`, false, ATTR_LABEL[k]);
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
