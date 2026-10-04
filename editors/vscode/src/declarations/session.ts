// SPDX-License-Identifier: MIT
// One declarations view and the document it shows: the model from the language server (rung/declarations), the
// view's messages turned into editor navigation and into edits of the document (planned by the language server,
// applied here only to the text they were planned on). The companion panel moves a session from file to file; the
// UDT table editor keeps one on its document.
import * as vscode from "vscode";
import type { Lsp } from "../lsp";
import { isViewToHost, type DeclModel, type DeclOp, type DeclRow, type HostToView, type PasteResult, type ViewContext, type ViewToHost } from "../protocol/declarations";
import type { RungWorkspace } from "../workspace";
import { STALE, checkPlan, type Rng, type ServerPlan } from "./edits";

export function findRow(model: DeclModel, id: string): DeclRow | undefined {
  const walk = (rows: DeclRow[]): DeclRow | undefined => {
    for (const r of rows) {
      if (r.id === id) return r;
      const c = r.children && walk(r.children);
      if (c) return c;
    }
    return undefined;
  };
  for (const s of model.sections) {
    const r = walk(s.rows);
    if (r) return r;
  }
  return undefined;
}

export interface SessionHost {
  /** the document the view shows (its uri as a string), if any */
  uri(): string | undefined;
  /** a position that names the block in a file with several */
  position(): vscode.Position | undefined;
  visible(): boolean;
  /** the panel's or editor's title */
  title(text: string): void;
  /** whether the view follows the editor (the panel) or is the document's own editor */
  pinned(): boolean | undefined;
  /** the view asked to pin or unpin (the panel only) */
  pin?(pinned: boolean): void;
  /** the webview's own editor group: given the focus back after an undo */
  focus(): void;
  /** undo/redo where the view is the document's own editor; else they run in its text editor */
  undo?(kind: "undo" | "redo"): Thenable<unknown>;
}

type Result = { ok: boolean; reason?: string; edit?: { rowId: string; column: "name" } };

export class DeclarationsSession implements vscode.Disposable {
  private model: DeclModel | undefined;
  private ready = false;
  /** the latest refresh; an older one's answer is dropped */
  private seq = 0;
  /** the file whose type names the view has */
  private typesFor: string | undefined;
  /** the last message sent to the view */
  private last: HostToView | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly deps: { lsp: Lsp; ws: RungWorkspace },
    private readonly host: SessionHost,
  ) {
    this.subs.push(
      webview.onDidReceiveMessage((m: unknown) => {
        if (isViewToHost(m)) void this.handle(m);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.host.uri()) this.scheduleRefresh(150);
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.toString() === this.host.uri()) this.scheduleRefresh(0);
      }),
    );
  }

  /** The model the view shows. */
  get shown(): DeclModel | undefined {
    return this.model;
  }

  /** Hidden, the webview is gone (no retained context); shown again, it loads and says ready. */
  hidden(): void {
    this.ready = false;
  }

  post(m: HostToView): void {
    this.last = m;
    if (this.ready) void this.webview.postMessage(m);
  }

  /** A message as if the view sent it (checked the same way); the answer the view would get. */
  async receive(m: unknown): Promise<HostToView | undefined> {
    if (!isViewToHost(m)) return undefined;
    this.last = undefined;
    await this.handle(m);
    return this.last;
  }

  scheduleRefresh(ms: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), ms);
  }

  document(): vscode.TextDocument | undefined {
    const uri = this.host.uri();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
  }

  private context(doc?: vscode.TextDocument): ViewContext {
    const uri = this.host.uri();
    const fsPath = doc?.uri.fsPath ?? (uri ? vscode.Uri.parse(uri).fsPath : "");
    const rel = (this.deps.ws.rel(fsPath) ?? vscode.workspace.asRelativePath(fsPath)).replace(/\\/g, "/");
    const plc = /^plc\/([^/]+)\//.exec(rel)?.[1];
    const pinned = this.host.pinned();
    return { ...(plc ? { plc } : {}), file: rel, dirty: doc?.isDirty ?? false, pinned: pinned ?? false, ...(pinned === undefined ? { fixed: true } : {}) };
  }

  async refresh(): Promise<void> {
    if (!this.ready || !this.host.visible()) return;
    const target = this.host.uri();
    if (!target) {
      this.post({ v: 1, kind: "state", state: "noBlock" });
      return;
    }
    const seq = ++this.seq;
    const doc = this.document() ?? (await vscode.workspace.openTextDocument(vscode.Uri.parse(target)).then((d) => d, () => undefined));
    const position = this.host.position();
    const model = await this.deps.lsp.request<DeclModel | null>("rung/declarations", { textDocument: { uri: target }, ...(position ? { position } : {}) }).catch(() => undefined);
    // a later refresh (another file, another block, a newer text) answers instead
    if (seq !== this.seq || target !== this.host.uri()) return;
    if (model === undefined) {
      this.post({ v: 1, kind: "state", state: "noServer", context: this.context(doc) });
      // the language server may still be starting: ask again until it answers
      this.scheduleRefresh(1000);
      return;
    }
    if (!model || !model.block) {
      this.model = undefined;
      this.post({ v: 1, kind: "state", state: "noBlock", context: this.context(doc) });
      return;
    }
    this.model = model;
    this.host.title(model.block.name);
    this.post({ v: 1, kind: "model", model, context: this.context(doc) });
    if (model.editable && this.typesFor !== target) {
      this.typesFor = target;
      const t = await this.deps.lsp.request<{ elementary: string[]; types: { name: string; kind: string }[] }>("rung/typeNames", { textDocument: { uri: target } }).catch(() => undefined);
      if (t) this.post({ v: 1, kind: "types", ...t });
    }
  }

  private async handle(m: ViewToHost) {
    switch (m.kind) {
      case "ready":
        this.ready = true;
        this.typesFor = undefined;
        await this.refresh();
        return;
      case "pin":
        this.host.pin?.(m.pinned);
        return;
      case "openText":
        await this.showText();
        return;
      case "open": {
        const row = this.model && findRow(this.model, m.rowId);
        if (!row) return;
        const r = (m.target === "name" ? row.ranges.name : row.ranges[m.target]) ?? row.ranges.name;
        await this.showText(r.start, r.end);
        return;
      }
      case "openType": {
        const row = this.model && findRow(this.model, m.rowId);
        const doc = this.document();
        if (!row || !doc) return;
        const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", doc.uri, doc.positionAt(row.ranges.type.start));
        const d = defs?.[0];
        if (!d) {
          void vscode.window.setStatusBarMessage(`rung: no definition of ${row.type} in the workspace`, 3000);
          return;
        }
        const loc = "targetUri" in d ? new vscode.Location(d.targetUri, d.targetSelectionRange ?? d.targetRange) : d;
        await vscode.window.showTextDocument(loc.uri, { selection: loc.range, preview: true });
        return;
      }
      case "usages": {
        const row = this.model && findRow(this.model, m.rowId);
        const doc = this.document();
        if (!row || !doc) return;
        await vscode.commands.executeCommand("rung.usages.show", doc.uri, doc.positionAt(row.ranges.name.start), row.name);
        return;
      }
      case "edit":
      case "add":
      case "delete":
      case "rename": {
        // the view may show another file by now: an edit is for the file and the text it was made on
        const doc = this.document();
        let r: Result;
        if (m.uri !== this.host.uri() || !doc || !this.model || this.model.uri !== m.uri) r = { ok: false, reason: "The table shows another file now. Review the value again." };
        else if (m.version !== this.model.version || m.version !== doc.version) r = { ok: false, reason: STALE };
        else if (m.kind === "edit") r = await this.applyOp(m.op, m.version);
        else if (m.kind === "add") r = await this.add(m, m.version);
        else if (m.kind === "delete") r = await this.delete(m.rowId, m.version);
        else r = await this.rename(m.rowId, m.name, m.version);
        this.post({ v: 1, kind: "result", req: m.req, ...r });
        return;
      }
      case "paste": {
        const down: PasteResult = { rows: [], errors: [{ line: 1, message: "The language server is not running." }] };
        const result = (await this.deps.lsp.request<PasteResult>("rung/declarationPaste", { textDocument: { uri: m.uri }, text: m.text }).catch(() => undefined)) ?? down;
        this.post({ v: 1, kind: "pastePreview", req: m.req, result });
        return;
      }
      case "undo":
      case "redo": {
        if (this.host.undo) {
          await this.host.undo(m.kind);
          return;
        }
        // the document's own undo stack: run it in its text editor, then give the view its focus back
        if (!(await this.showText())) return;
        await vscode.commands.executeCommand(m.kind);
        this.host.focus();
        return;
      }
    }
  }

  /** Plans `op` in the language server and applies it, unless the document moved on since the view's model. */
  private async applyOp(op: DeclOp, version?: number): Promise<Result> {
    const doc = this.document();
    if (!doc || !this.model) return { ok: false, reason: "The file is not open." };
    if (!this.model.editable) return { ok: false, reason: this.model.reason ?? "Read only" };
    const position = this.host.position();
    const plan = await this.deps.lsp
      .request<ServerPlan>("rung/declarationEdit", { textDocument: { uri: doc.uri.toString(), version: version ?? doc.version }, ...(position ? { position } : {}), op })
      .catch(() => undefined);
    const range = (r: Rng) => new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
    const checked = checkPlan({ version: doc.version, getText: (r) => doc.getText(range(r)) }, plan ?? { ok: false, reason: "The language server is not running." });
    if (!checked.ok) return checked;
    if (!checked.edits.length) return { ok: true };
    const edit = new vscode.WorkspaceEdit();
    for (const e of checked.edits) edit.replace(doc.uri, range(e.range), e.newText);
    return (await vscode.workspace.applyEdit(edit)) ? { ok: true } : { ok: false, reason: STALE };
  }

  /** A new Bool declaration with a free name, as TIA adds one; the view then edits its name. */
  private async add(m: { after?: string; into?: string; section?: string }, version: number): Promise<Result> {
    if (!this.model) return { ok: false, reason: "The file is not open." };
    const taken = new Set<string>();
    const collect = (rows: DeclRow[]) => rows.forEach((r) => (taken.add(r.name.toLowerCase()), r.children && collect(r.children)));
    for (const s of this.model.sections) collect(s.rows);
    let n = 1;
    while (taken.has(`tag_${n}`)) n++;
    const name = `Tag_${n}`;
    const where = m.after ? { after: m.after } : m.into ? { into: m.into } : { section: m.section };
    const r = await this.applyOp({ op: "insertRows", ...where, rows: [{ name, type: "Bool" }] }, version);
    if (!r.ok) return r;
    // the new row's id: beside `after`, inside `into`, or at a section's top level
    const parent = m.after ? m.after.slice(0, Math.max(0, m.after.lastIndexOf("/"))) : (m.into ?? "");
    return { ok: true, edit: { rowId: parent ? `${parent}/${name}` : name, column: "name" } };
  }

  /** Deletes a declaration; one the workspace uses (or may use: no answer) only after the user says so. */
  private async delete(rowId: string, version: number): Promise<Result> {
    const row = this.model && findRow(this.model, rowId);
    const doc = this.document();
    if (!row || !doc) return { ok: false, reason: "The declaration is gone. Review the table again." };
    const pos = doc.positionAt(row.ranges.name.start);
    type Site = { uri: string; range: { start: { line: number; character: number } } };
    const used = await this.deps.lsp
      .request<{ writes: Site[]; reads: Site[]; handedOn?: Site[] }>("rung/usages", { textDocument: { uri: doc.uri.toString() }, position: { line: pos.line, character: pos.character } })
      .then(
        (u) => (u ? new Set([...u.writes, ...u.reads, ...(u.handedOn ?? [])].map((x) => `${x.uri}:${x.range.start.line}:${x.range.start.character}`)).size : undefined),
        () => undefined,
      );
    if (used !== 0) {
      const yes = "Delete";
      const what = used === undefined ? `Where "${row.name}" is used could not be checked.` : `"${row.name}" is used ${used === 1 ? "in one place" : `in ${used} places`} in this workspace.`;
      const pick = await vscode.window.showWarningMessage(`${what} Delete its declaration anyway?`, { modal: true, detail: "Code that uses it will not compile until it is changed. HMI screens and other PLCs are not checked." }, yes);
      if (pick !== yes) return { ok: false };
    }
    // the answer took a while: the edit is still for the text the view showed
    return this.applyOp({ op: "deleteRow", row: rowId }, version);
  }

  /** Renames through the language server's rename: the code that uses the name follows. */
  private async rename(rowId: string, name: string, version: number): Promise<Result> {
    const row = this.model && findRow(this.model, rowId);
    const doc = this.document();
    const next = name.trim();
    if (!row || !doc) return { ok: false, reason: "The declaration is gone. Review the table again." };
    if (!next || next === row.name) return { ok: true };
    if (doc.version !== version) return { ok: false, reason: STALE };
    // inside a quoted name ("30ms") the rename provider wants a position past the quote
    const pos = doc.positionAt(row.ranges.name.start + (doc.getText().charAt(row.ranges.name.start) === '"' ? 1 : 0));
    try {
      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>("vscode.executeDocumentRenameProvider", doc.uri, pos, next);
      if (!edit || !edit.size) return { ok: false, reason: `"${row.name}" cannot be renamed here.` };
      if (doc.version !== version) return { ok: false, reason: STALE };
      return (await vscode.workspace.applyEdit(edit)) ? { ok: true } : { ok: false, reason: STALE };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The file in its text editor (the one already showing it, else the first column), with a range selected. */
  async showText(start?: number, end?: number): Promise<vscode.TextEditor | undefined> {
    const target = this.host.uri();
    if (!target) return undefined;
    const shown = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === target);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(target));
    const selection = start !== undefined ? new vscode.Range(doc.positionAt(start), doc.positionAt(end ?? start)) : undefined;
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: shown?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: false, ...(selection ? { selection } : {}) });
    if (selection) editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return editor;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const s of this.subs) s.dispose();
  }
}
