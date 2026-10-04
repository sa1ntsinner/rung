// SPDX-License-Identifier: MIT
// The test table: a test file's cases on the left, the selected case's steps on the right as a tree of Set / Run /
// Expect rows and their name = value entries, edited in place. It changes no text itself: every edit goes to the
// extension as a checked message (protocol/tests.ts) and comes back as a new model. Runs go through the test explorer.
import { LitElement, html, nothing } from "lit";
import type { CaseRun, KeyProblem, Part, TCase, TStep as TestStep, TestFileModel, TestHostToView, TestOp, TestViewToHost } from "../../protocol/tests";
import type { GridColumn, GridRow, GridSection } from "../grid/types";
import "../grid/rg-treegrid";
import type { CellEdit, RgTreegrid } from "../grid/rg-treegrid";

interface VsCodeApi {
  postMessage(m: TestViewToHost): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
let api: VsCodeApi | undefined;
const vscode = () => (api ??= acquireVsCodeApi());

/** A row of the steps grid: a step, or one name = value of its set/expect. */
export interface StepRow extends GridRow {
  step: number;
  part?: Part;
  key?: string;
  value?: string;
  label: string;
  children?: StepRow[];
}

const COLUMNS: GridColumn[] = [
  { key: "label", label: "Step", width: 260 },
  { key: "name", label: "Name", mono: true, width: 220 },
  { key: "value", label: "Value", mono: true, width: 150 },
  { key: "result", label: "Last run", width: 0 },
];

const PART_LABEL: Record<Part, string> = { set: "Set", expect: "Expect" };
const enc = (s: string) => encodeURIComponent(s);

function runText(s: TestStep): string | undefined {
  if (s.cycle) return `${s.cycle.value} ${s.cycle.value === "1" ? "cycle" : "cycles"}`;
  if (s.advance) return s.advance.value;
  return undefined;
}

/** A step's title: what it does, in the order rung runs it (set, cycle, advance, expect). */
export function stepTitle(s: TestStep): string {
  // a step that only runs: its count or time stands in the value column
  if (!s.set && !s.expect && !(s.cycle && s.advance)) return s.cycle ? "Run" : s.advance ? "Advance" : "Empty step";
  const parts: string[] = [];
  if (s.set) parts.push("Set");
  if (s.cycle) parts.push(`Run ${s.cycle.value} ${s.cycle.value === "1" ? "cycle" : "cycles"}`);
  if (s.advance) parts.push(`Advance ${s.advance.value}`);
  if (s.expect) parts.push("Expect");
  return parts.join(" · ");
}

export function stepRows(c: TCase): StepRow[] {
  return c.steps.map((s) => {
    const children: StepRow[] = [];
    // the part each name belongs to is said only where a step has both
    const both = !!s.set && !!s.expect;
    for (const part of ["set", "expect"] as const)
      for (const e of s[part]?.entries ?? [])
        children.push({ id: `s${s.index}/${part}/${enc(e.key)}`, depth: 1, step: s.index, part, key: e.key, value: e.text ?? e.value, label: both ? PART_LABEL[part] : "" });
    const run = runText(s);
    return { id: `s${s.index}`, depth: 0, step: s.index, label: `${s.index + 1}  ${stepTitle(s)}`, ...(run && !s.set && !s.expect ? { value: run } : {}), ...(children.length ? { children } : {}) };
  });
}

export class RgTests extends LitElement {
  static override properties = {
    file: { state: true },
    context: { state: true },
    state: { state: true },
    selected: { state: true },
    notice: { state: true },
    runs: { state: true },
    running: { state: true },
    renaming: { state: true },
  };

  declare file: TestFileModel | undefined;
  declare context: { file: string; dirty: boolean } | undefined;
  declare state: "loading" | "noServer" | undefined;
  declare selected: number;
  declare notice: string | undefined;
  declare runs: Map<number, CaseRun>;
  declare running: Set<number>;
  /** the case whose name is being typed */
  declare renaming: number | undefined;
  private req = 0;
  /** a row to make active once the next model arrives (a step that moved) */
  private follow: string | undefined;
  private readonly onMessage = (e: MessageEvent) => this.receive(e.data as TestHostToView);

  constructor() {
    super();
    const saved = (vscode().getState() ?? {}) as { selected?: number };
    this.selected = saved.selected ?? 0;
    this.state = "loading";
    this.runs = new Map();
    this.running = new Set();
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

  private post(m: TestViewToHost) {
    vscode().postMessage(m);
  }

  private receive(m: TestHostToView) {
    if (!m || m.v !== 1) return;
    if (m.kind === "model") {
      this.file = m.file;
      this.context = m.context;
      this.state = undefined;
      if (this.selected >= m.file.model.cases.length) this.selected = Math.max(0, m.file.model.cases.length - 1);
      const follow = this.follow;
      this.follow = undefined;
      if (follow)
        void this.updateComplete.then(async () => {
          const g = this.querySelector<RgTreegrid<StepRow>>("rg-treegrid");
          await g?.updateComplete;
          g?.reveal(follow);
        });
    } else if (m.kind === "state") this.state = m.state;
    else if (m.kind === "result") {
      if (!m.ok && m.reason) this.notice = m.reason;
    } else if (m.kind === "runs") {
      this.runs = new Map(m.runs.map((r) => [r.index, r]));
      this.running = new Set(m.running);
    }
  }

  private edit(op: TestOp) {
    if (!this.file) return;
    this.notice = undefined;
    this.post({ v: 1, kind: "edit", req: ++this.req, uri: this.file.uri, version: this.file.version, op });
  }

  private select(i: number) {
    this.selected = i;
    vscode().setState({ selected: i });
  }

  // ---------- the steps grid ----------

  private readonly editable = (row: StepRow, column: string): CellEdit => {
    if (row.part) return column === "name" || column === "value" ? "text" : false;
    // a step that only runs: its cycles or time edit in place
    const s = this.file?.model.cases[this.selected]?.steps[row.step];
    return column === "value" && s && !s.set && !s.expect && (s.cycle || s.advance) ? "text" : false;
  };

  private readonly cellText = (row: StepRow, column: string): string => {
    switch (column) {
      case "label":
        return row.part ? row.label : row.label;
      case "name":
        return row.key ?? "";
      case "value":
        return row.part ? (row.value ?? "") : row.value?.replace(/ cycles?$/, "") ?? "";
      case "result":
        return this.resultText(row) ?? "";
      default:
        return "";
    }
  };

  /** What the last run says about this row: the value an expectation got, or the step an error stopped in. */
  private resultText(row: StepRow): string | undefined {
    const run = this.runs.get(this.selected);
    if (!run) return undefined;
    if (row.part === "expect") {
      const f = run.failures.find((x) => x.step === row.step + 1 && x.name.toLowerCase() === row.key!.toLowerCase());
      return f ? `got ${JSON.stringify(f.actual)}` : run.errorStep && run.errorStep <= row.step + 1 ? undefined : "ok";
    }
    if (!row.part && run.errorStep === row.step + 1) return run.error;
    return undefined;
  }

  private problem(row: StepRow): KeyProblem | undefined {
    return row.part ? this.file?.problems.find((p) => p.case === this.selected && p.step === row.step && p.part === row.part && p.key === row.key) : undefined;
  }

  private cell(row: StepRow, column: string) {
    if (column === "label")
      return row.part
        ? html`<span class="rg-muted">${row.label}</span>`
        : html`<span class="rg-step-no">${row.step + 1}</span><span>${row.label.replace(/^\d+\s+/, "")}</span>`;
    if (column === "name" && row.part) {
      const p = this.problem(row);
      return p ? html`<span class="rg-problem rg-problem-error" title=${p.message}>${row.key}</span>` : row.key;
    }
    if (column === "value" && !row.part) return row.value ? html`<span>${row.value}</span>` : nothing;
    if (column === "result") {
      const t = this.resultText(row);
      if (!t) return nothing;
      const bad = t !== "ok";
      return html`<span class=${bad ? "rg-fail" : "rg-pass"}><span class="codicon ${bad ? "codicon-error" : "codicon-pass"}"></span>${t === "ok" ? nothing : html`<span>${t}</span>`}</span>`;
    }
    return this.cellText(row, column);
  }

  private commit(rowId: string, column: string, value: string) {
    const c = this.selected;
    const row = this.findStepRow(rowId);
    if (!row) return;
    if (row.part && row.key !== undefined) {
      if (column === "name") return this.edit({ op: "setKey", case: c, step: row.step, part: row.part, key: row.key, newKey: value });
      return this.edit({ op: "setValue", case: c, step: row.step, part: row.part, key: row.key, value });
    }
    const s = this.file?.model.cases[c]?.steps[row.step];
    if (s?.cycle) return this.edit({ op: "setRun", case: c, step: row.step, kind: "cycle", value });
    if (s?.advance) return this.edit({ op: "setRun", case: c, step: row.step, kind: "advance", value });
  }

  private findStepRow(id: string): StepRow | undefined {
    const c = this.file?.model.cases[this.selected];
    if (!c) return undefined;
    for (const r of stepRows(c)) {
      if (r.id === id) return r;
      const k = r.children?.find((x) => x.id === id);
      if (k) return k;
    }
    return undefined;
  }

  /** Insert: a name into the step's set/expect (picked from the block), or a step after a step that only runs. */
  private insert(rowId: string) {
    const row = this.findStepRow(rowId);
    const s = row && this.file?.model.cases[this.selected]?.steps[row.step];
    if (!row || !s || !this.file) return;
    const part: Part | undefined = row.part ?? (s.expect ? "expect" : s.set ? "set" : undefined);
    if (part) this.post({ v: 1, kind: "pick", req: ++this.req, uri: this.file.uri, version: this.file.version, case: this.selected, step: row.step, part });
    else this.edit({ op: "addStep", case: this.selected, after: row.step, kind: "cycle" });
  }

  private removeRow(rowId: string) {
    const row = this.findStepRow(rowId);
    if (!row) return;
    if (row.part && row.key !== undefined) return this.edit({ op: "removeEntry", case: this.selected, step: row.step, part: row.part, key: row.key });
    this.edit({ op: "removeStep", case: this.selected, step: row.step });
  }

  // ---------- drawing ----------

  protected override render() {
    if (this.state || !this.file) {
      const text = this.state === "noServer" ? "The rung language server is not running." : "Reading the test…";
      return html`<div class="rg-app"><div class="rg-state"><span>${text}</span></div></div>`;
    }
    const m = this.file.model;
    if (m.errors.length) {
      const e = m.errors[0]!;
      return html`<div class="rg-app">${this.renderHeader()}<div class="rg-state"><span>The file has a YAML error on line ${e.line + 1}: ${e.message}</span><button class="rg-primary" @click=${() => this.post({ v: 1, kind: "openText", line: e.line })}>Open text</button></div></div>`;
    }
    return html`<div class="rg-app rg-tests">${this.renderHeader()}
      <div class="rg-tests-body">${this.renderCases(m.cases)}${this.renderSteps(m.cases[this.selected])}</div>
      <div class="rg-status">
        ${this.notice
          ? html`<span class="rg-refusal" role="alert"><span class="codicon codicon-warning"></span>${this.notice}</span>`
          : html`<span>${m.cases.length} ${m.cases.length === 1 ? "case" : "cases"}${this.file.problems.length ? html` · <span class="rg-sev-error">${this.file.problems.length} ${this.file.problems.length === 1 ? "name" : "names"} not in ${m.block?.value}</span>` : nothing}</span>`}
        <span class="rg-spacer"></span>
        ${this.context?.dirty ? html`<span class="rg-dirty">Edited, not saved</span>` : nothing}
      </div>
    </div>`;
  }

  private renderHeader() {
    const m = this.file!.model;
    return html`<header class="rg-header">
      <div class="rg-title">
        <span class="codicon codicon-beaker rg-title-icon"></span>
        <span class="rg-title-name">${m.block?.value ?? "Test"}</span>
        ${m.cycle ? html`<span class="rg-kind" title="Cycle time">${m.cycle.value}</span>` : nothing}
        <span class="rg-crumbs">${this.context?.file ?? ""}</span>
        ${this.file!.noBlock ? html`<span class="rg-refusal"><span class="codicon codicon-warning"></span>${this.file!.noBlock}</span>` : nothing}
      </div>
      <button class="rg-icon-btn" title="Run all cases" aria-label="Run all cases" data-action="run-all" @click=${() => this.post({ v: 1, kind: "run" })}><span class="codicon codicon-run-all"></span></button>
      <button class="rg-icon-btn" title="Open text" aria-label="Open text" @click=${() => this.post({ v: 1, kind: "openText" })}><span class="codicon codicon-go-to-file"></span></button>
    </header>`;
  }

  private caseIcon(i: number) {
    if (this.running.has(i)) return html`<span class="codicon codicon-loading codicon-modifier-spin" aria-label="running"></span>`;
    const r = this.runs.get(i);
    if (!r) return html`<span class="codicon codicon-circle-large-outline rg-muted" aria-label="not run"></span>`;
    return r.passed ? html`<span class="codicon codicon-pass rg-pass" aria-label="passed"></span>` : html`<span class="codicon codicon-error rg-fail" aria-label="failed"></span>`;
  }

  private renderCases(cases: TCase[]) {
    const name = (c: TCase) => c.name?.value ?? `case ${c.index + 1}`;
    const freeName = (base: string) => {
      const taken = new Set(cases.map((c) => name(c).toLowerCase()));
      let n = 2;
      let x = base;
      while (taken.has(x.toLowerCase())) x = `${base} ${n++}`;
      return x;
    };
    return html`<nav class="rg-cases" aria-label="Cases">
      <div class="rg-pane-title">Cases</div>
      <ul role="listbox" aria-label="Cases" tabindex="0" @keydown=${(e: KeyboardEvent) => this.casesKey(e, cases)}>
        ${cases.map(
          (c) => html`<li role="option" aria-selected=${c.index === this.selected ? "true" : "false"} class="rg-case ${c.index === this.selected ? "rg-selected" : ""}" data-case=${c.index} @click=${() => this.select(c.index)} @dblclick=${() => (this.renaming = c.index)}>
            ${this.caseIcon(c.index)}
            ${this.renaming === c.index
              ? html`<input class="rg-input rg-case-input" aria-label="Case name" .value=${name(c)} @keydown=${(e: KeyboardEvent) => this.renameKey(e, c.index)} @blur=${(e: Event) => this.renameDone(c.index, (e.target as HTMLInputElement).value)} />`
              : html`<span class="rg-case-name" title=${name(c)}>${name(c)}</span>`}
            <span class="rg-case-actions">
              <button class="rg-icon-btn" title="Run this case" aria-label="Run this case" data-action="run" @click=${(e: Event) => (e.stopPropagation(), this.post({ v: 1, kind: "run", case: c.index }))}><span class="codicon codicon-play"></span></button>
              <button class="rg-icon-btn" title="Duplicate" aria-label="Duplicate" data-action="duplicate" @click=${(e: Event) => (e.stopPropagation(), this.edit({ op: "duplicateCase", case: c.index, name: freeName(`${name(c)} copy`) }))}><span class="codicon codicon-copy"></span></button>
              <button class="rg-icon-btn" title="Delete" aria-label="Delete" data-action="delete" @click=${(e: Event) => (e.stopPropagation(), this.edit({ op: "removeCase", case: c.index }))}><span class="codicon codicon-trash"></span></button>
            </span>
          </li>`,
        )}
      </ul>
      <button class="rg-link rg-add-case" data-action="add-case" @click=${() => this.edit({ op: "addCase", name: freeName("new case") })}><span class="codicon codicon-add"></span>Add case</button>
      ${this.renderStubs()}
    </nav>`;
  }

  /** What stands in for code the simulator does not run: shown, edited in the text. */
  private renderStubs() {
    const stubs = this.file?.model.stubs ?? [];
    if (!stubs.length) return nothing;
    return html`<div class="rg-pane-title rg-stubs-title" title="What stands in for code the simulator does not run (docs/testing.md)">Stubs</div>
      <ul class="rg-stubs">
        ${stubs.map(
          (s) => html`<li class="rg-stub" title="Show in the text" @click=${() => this.post({ v: 1, kind: "openText", line: s.line })}>
            <span class="codicon codicon-debug-disconnect rg-muted"></span><span class="rg-mono">${s.name}</span>
            <span class="rg-muted rg-stub-outputs">${s.value ? s.value.value : s.entries.map((e) => e.key).join(", ")}</span>
          </li>`,
        )}
      </ul>`;
  }

  private casesKey(e: KeyboardEvent, cases: TCase[]) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.select(Math.max(0, Math.min(cases.length - 1, this.selected + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "F2") {
      e.preventDefault();
      this.renaming = this.selected;
    } else if (e.key === "Delete") {
      e.preventDefault();
      this.edit({ op: "removeCase", case: this.selected });
    }
  }

  private renameKey(e: KeyboardEvent, i: number) {
    e.stopPropagation();
    if (e.key === "Enter") this.renameDone(i, (e.target as HTMLInputElement).value);
    else if (e.key === "Escape") this.renaming = undefined;
  }

  private renameDone(i: number, value: string) {
    if (this.renaming !== i) return;
    this.renaming = undefined;
    const c = this.file?.model.cases[i];
    if (c && value.trim() && value.trim() !== c.name?.value) this.edit({ op: "renameCase", case: i, name: value });
  }

  protected override updated() {
    const input = this.querySelector<HTMLInputElement>(".rg-case-input");
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  }

  private renderSteps(c: TCase | undefined) {
    if (!c) return html`<section class="rg-steps"><div class="rg-state"><span>No cases yet.</span></div></section>`;
    const rows = stepRows(c);
    const grid: GridSection<StepRow>[] = [{ id: `case-${c.index}`, title: c.name?.value ?? `case ${c.index + 1}`, rows }];
    const run = this.runs.get(c.index);
    const add = (kind: Part | "cycle" | "advance") => this.edit({ op: "addStep", case: c.index, kind });
    return html`<section class="rg-steps" aria-label="Steps">
      <div class="rg-steps-head">
        ${run && !run.passed && run.error ? html`<span class="rg-refusal" title=${run.error}><span class="codicon codicon-error rg-fail"></span>${run.errorStep ? `step ${run.errorStep}: ` : ""}${run.error}</span>` : nothing}
        <span class="rg-spacer"></span>
        <span class="rg-add-step" role="group" aria-label="Add a step">
          <button class="rg-text-btn" data-action="add-set" @click=${() => add("set")}><span class="codicon codicon-add"></span>Set</button>
          <button class="rg-text-btn" data-action="add-cycle" @click=${() => add("cycle")}>Run</button>
          <button class="rg-text-btn" data-action="add-advance" @click=${() => add("advance")}>Advance</button>
          <button class="rg-text-btn" data-action="add-expect" @click=${() => add("expect")}>Expect</button>
        </span>
        <button class="rg-icon-btn" title="Run this case" aria-label="Run this case" data-action="run-case" @click=${() => this.post({ v: 1, kind: "run", case: c.index })}><span class="codicon codicon-play"></span></button>
      </div>
      <div class="rg-scroll">
        <rg-treegrid
          .sections=${grid}
          .columns=${COLUMNS}
          .expanded=${new Set(rows.map((r) => r.id))}
          .cellText=${this.cellText}
          .renderCell=${(row: StepRow, column: string) => this.cell(row, column)}
          .editable=${this.editable}
          @rg-commit=${(e: CustomEvent<{ rowId: string; column: string; value: string }>) => this.commit(e.detail.rowId, e.detail.column, e.detail.value)}
          @rg-insert=${(e: CustomEvent<{ rowId: string }>) => this.insert(e.detail.rowId)}
          @rg-delete=${(e: CustomEvent<{ rowId: string }>) => this.removeRow(e.detail.rowId)}
          @rg-move=${(e: CustomEvent<{ rowId: string; by: -1 | 1 }>) => {
            const row = this.findStepRow(e.detail.rowId);
            if (!row || row.part) return;
            this.edit({ op: "moveStep", case: c.index, step: row.step, by: e.detail.by });
            // the moved step keeps the keyboard: Alt+Up again moves it further
            this.follow = `s${row.step + e.detail.by}`;
          }}
          @rg-open=${(e: CustomEvent<{ rowId: string }>) => {
            const row = this.findStepRow(e.detail.rowId);
            const s = row && c.steps[row.step];
            if (s) this.post({ v: 1, kind: "openText", line: s.line });
          }}
          @rg-undo=${() => this.post({ v: 1, kind: "undo" })}
          @rg-redo=${() => this.post({ v: 1, kind: "redo" })}
        ></rg-treegrid>
      </div>
    </section>`;
  }
}

if (!customElements.get("rg-tests")) customElements.define("rg-tests", RgTests);
