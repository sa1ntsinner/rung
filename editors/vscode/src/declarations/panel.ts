// SPDX-License-Identifier: MIT
// The declarations panel beside an SCL editor: it asks the language server for the block's interface
// (rung/declarations), shows it in a webview, follows the active SCL editor unless pinned, and turns the view's
// messages into editor navigation. It changes no file.
import * as vscode from "vscode";
import { retarget, type Binding } from "../core/binding";
import { nonce, webviewHtml } from "../host/webviewHtml";
import type { Lsp } from "../lsp";
import { isViewToHost, type DeclModel, type DeclRow, type HostToView, type ViewContext, type ViewToHost } from "../protocol/declarations";
import type { RungWorkspace } from "../workspace";

const VIEW_TYPE = "rung.declarations";
const BINDING_KEY = "rung.declarations.binding";

function findRow(model: DeclModel, id: string): DeclRow | undefined {
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

/** The deepest row whose declaration holds the offset. */
function rowAt(model: DeclModel, offset: number): DeclRow | undefined {
  let found: DeclRow | undefined;
  const walk = (rows: DeclRow[]) => {
    for (const r of rows) {
      if (offset >= r.ranges.whole.start && offset <= r.ranges.whole.end) {
        found = r;
        if (r.children) walk(r.children);
      }
    }
  };
  for (const s of model.sections) walk(s.rows);
  return found;
}

export class DeclarationsPanel implements vscode.Disposable {
  private static current: DeclarationsPanel | undefined;
  private binding: Binding;
  private position: vscode.Position | undefined;
  private model: DeclModel | undefined;
  private ready = false;
  private readonly subs: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private revealTimer: NodeJS.Timeout | undefined;

  /** Opens the panel beside the editor (or shows it), bound to `uri` or the active SCL editor. */
  static show(ctx: vscode.ExtensionContext, deps: { lsp: Lsp; ws: RungWorkspace }, uri?: vscode.Uri, position?: vscode.Position): DeclarationsPanel {
    const active = vscode.window.activeTextEditor;
    const target = uri ?? (active?.document.languageId === "scl" ? active.document.uri : undefined);
    const pos = position ?? (active && target && active.document.uri.toString() === target.toString() ? active.selection.active : undefined);
    if (DeclarationsPanel.current) {
      const p = DeclarationsPanel.current;
      if (target) p.bind({ pinned: p.binding.pinned && !uri, uri: target.toString() }, pos);
      p.panel.reveal(undefined, true);
      return p;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Declarations", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, DeclarationsPanel.options(ctx));
    return (DeclarationsPanel.current = new DeclarationsPanel(ctx, deps, panel, { pinned: false, ...(target ? { uri: target.toString() } : {}) }, pos));
  }

  /** Restores the panel VS Code kept across a reload, bound as it was. */
  static register(ctx: vscode.ExtensionContext, deps: { lsp: Lsp; ws: RungWorkspace }): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => {
        panel.webview.options = DeclarationsPanel.options(ctx);
        const saved = ctx.workspaceState.get<Binding>(BINDING_KEY) ?? { pinned: false };
        DeclarationsPanel.current = new DeclarationsPanel(ctx, deps, panel, saved);
      },
    });
  }

  private static options(ctx: vscode.ExtensionContext): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "out", "webview")] };
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly deps: { lsp: Lsp; ws: RungWorkspace },
    private readonly panel: vscode.WebviewPanel,
    binding: Binding,
    position?: vscode.Position,
  ) {
    this.binding = binding;
    this.position = position;
    const web = panel.webview;
    const asset = (f: string) => web.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "webview", f)).toString();
    web.html = webviewHtml({ cspSource: web.cspSource, nonce: nonce(), script: asset("declarations.js"), styles: [asset("codicon.css"), asset("tokens.css"), asset("rung.css")], title: "Declarations" });
    this.subs.push(
      web.onDidReceiveMessage((m: unknown) => {
        if (isViewToHost(m)) void this.handle(m);
      }),
      panel.onDidDispose(() => this.dispose()),
      // hidden, the webview is gone (no retained context); shown again, it loads and says ready
      panel.onDidChangeViewState((e) => {
        if (!e.webviewPanel.visible) this.ready = false;
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        const next = retarget(this.binding, ed ? { uri: ed.document.uri.toString(), languageId: ed.document.languageId } : undefined);
        if (next.uri !== this.binding.uri) this.bind(next, ed?.selection.active);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.binding.uri) this.scheduleRefresh(150);
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.toString() === this.binding.uri) this.scheduleRefresh(0);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (this.binding.pinned || e.textEditor.document.uri.toString() !== this.binding.uri) return;
        this.position = e.selections[0]?.active;
        this.scheduleReveal(e.textEditor.document);
      }),
    );
  }

  private bind(b: Binding, position?: vscode.Position) {
    const moved = b.uri !== this.binding.uri;
    this.binding = b;
    if (moved) this.position = position;
    void this.ctx.workspaceState.update(BINDING_KEY, b);
    this.scheduleRefresh(0);
  }

  private post(m: HostToView) {
    if (this.ready) void this.panel.webview.postMessage(m);
  }

  private scheduleRefresh(ms: number) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), ms);
  }

  private scheduleReveal(doc: vscode.TextDocument) {
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealTimer = setTimeout(() => {
      if (!this.model || !this.position) return;
      const row = rowAt(this.model, doc.offsetAt(this.position));
      if (row) this.post({ v: 1, kind: "reveal", rowId: row.id });
    }, 300);
  }

  private document(): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.binding.uri);
  }

  private context(doc?: vscode.TextDocument): ViewContext {
    const fsPath = doc?.uri.fsPath ?? (this.binding.uri ? vscode.Uri.parse(this.binding.uri).fsPath : "");
    const rel = (this.deps.ws.rel(fsPath) ?? vscode.workspace.asRelativePath(fsPath)).replace(/\\/g, "/");
    const plc = /^plc\/([^/]+)\//.exec(rel)?.[1];
    return { ...(plc ? { plc } : {}), file: rel, dirty: doc?.isDirty ?? false, pinned: this.binding.pinned };
  }

  async refresh(): Promise<void> {
    if (!this.ready || !this.panel.visible) return;
    if (!this.binding.uri) {
      this.post({ v: 1, kind: "state", state: "noBlock" });
      return;
    }
    const uri = vscode.Uri.parse(this.binding.uri);
    const doc = this.document() ?? (await vscode.workspace.openTextDocument(uri).then((d) => d, () => undefined));
    const model = await this.deps.lsp.request<DeclModel | null>("rung/declarations", { textDocument: { uri: this.binding.uri }, ...(this.position ? { position: this.position } : {}) }).catch(() => undefined);
    if (model === undefined) {
      this.post({ v: 1, kind: "state", state: "noServer", context: this.context(doc) });
      return;
    }
    if (!model || !model.block) {
      this.model = undefined;
      this.post({ v: 1, kind: "state", state: "noBlock", context: this.context(doc) });
      return;
    }
    this.model = model;
    this.panel.title = `${model.block.name} · Declarations`;
    this.post({ v: 1, kind: "model", model, context: this.context(doc) });
  }

  private async handle(m: ViewToHost) {
    switch (m.kind) {
      case "ready":
        this.ready = true;
        await this.refresh();
        return;
      case "pin":
        this.bind({ ...this.binding, pinned: m.pinned });
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
        const at = doc.positionAt(row.ranges.type.start);
        const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", doc.uri, at);
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
    }
  }

  /** The bound file in its editor (the one already showing it, else the first column), with a range selected. */
  private async showText(start?: number, end?: number) {
    if (!this.binding.uri) return;
    const uri = vscode.Uri.parse(this.binding.uri);
    const shown = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.binding.uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    const selection = start !== undefined ? new vscode.Range(doc.positionAt(start), doc.positionAt(end ?? start)) : undefined;
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: shown?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: false, ...(selection ? { selection } : {}) });
    if (selection) editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  dispose(): void {
    if (DeclarationsPanel.current === this) DeclarationsPanel.current = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.revealTimer) clearTimeout(this.revealTimer);
    for (const s of this.subs) s.dispose();
    this.panel.dispose();
  }
}
