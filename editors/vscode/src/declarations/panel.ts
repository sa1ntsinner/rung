// SPDX-License-Identifier: MIT
// The declarations panel beside an SCL editor: one declarations view (DeclarationsSession) that follows the active
// SCL editor unless pinned, shows the block under the cursor, and comes back bound as it was after a reload.
import * as vscode from "vscode";
import { retarget, type Binding } from "../core/binding";
import { nonce, webviewHtml } from "../host/webviewHtml";
import type { Lsp } from "../lsp";
import type { DeclModel, DeclRow, HostToView } from "../protocol/declarations";
import type { RungWorkspace } from "../workspace";
import type { Monitor } from "../monitor";
import { DeclarationsSession } from "./session";

const VIEW_TYPE = "rung.declarations";
const BINDING_KEY = "rung.declarations.binding";

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

/** The view's page: the same for the panel and the UDT table editor. */
export function declarationsHtml(ctx: vscode.ExtensionContext, web: vscode.Webview): string {
  const asset = (f: string) => web.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "webview", f)).toString();
  return webviewHtml({ cspSource: web.cspSource, nonce: nonce(), script: asset("declarations.js"), styles: [asset("codicon.css"), asset("tokens.css"), asset("rung.css")], title: "Declarations" });
}

export function declarationsOptions(ctx: vscode.ExtensionContext): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "out", "webview")] };
}

export class DeclarationsPanel implements vscode.Disposable {
  private static current: DeclarationsPanel | undefined;
  /** the open panel (for the integration tests) */
  static get open(): DeclarationsPanel | undefined {
    return DeclarationsPanel.current;
  }
  private binding: Binding;
  private position: vscode.Position | undefined;
  private readonly session: DeclarationsSession;
  private readonly subs: vscode.Disposable[] = [];
  private revealTimer: NodeJS.Timeout | undefined;

  /** Opens the panel beside the editor (or shows it), bound to `uri` or the active SCL editor. */
  static show(ctx: vscode.ExtensionContext, deps: { lsp: Lsp; ws: RungWorkspace; monitor?: Monitor }, uri?: vscode.Uri, position?: vscode.Position): DeclarationsPanel {
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
  static register(ctx: vscode.ExtensionContext, deps: { lsp: Lsp; ws: RungWorkspace; monitor?: Monitor }): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => {
        panel.webview.options = DeclarationsPanel.options(ctx);
        const saved = ctx.workspaceState.get<Binding>(BINDING_KEY) ?? { pinned: false };
        DeclarationsPanel.current = new DeclarationsPanel(ctx, deps, panel, saved);
      },
    });
  }

  private static options(ctx: vscode.ExtensionContext): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { ...declarationsOptions(ctx), retainContextWhenHidden: false };
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    deps: { lsp: Lsp; ws: RungWorkspace; monitor?: Monitor },
    private readonly panel: vscode.WebviewPanel,
    binding: Binding,
    position?: vscode.Position,
  ) {
    this.binding = binding;
    this.position = position;
    // remembered from the start, so a reload restores this file even if nothing moves it
    void ctx.workspaceState.update(BINDING_KEY, binding);
    this.session = new DeclarationsSession(panel.webview, deps, {
      uri: () => this.binding.uri,
      position: () => this.position,
      visible: () => this.panel.visible,
      title: (name) => (this.panel.title = `${name} · Declarations`),
      pinned: () => this.binding.pinned,
      pin: (pinned) => this.bind({ ...this.binding, pinned }),
      focus: () => this.panel.reveal(this.panel.viewColumn, false),
    });
    panel.webview.html = declarationsHtml(ctx, panel.webview);
    this.subs.push(
      this.session,
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState((e) => {
        if (!e.webviewPanel.visible) this.session.hidden();
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        const next = retarget(this.binding, ed ? { uri: ed.document.uri.toString(), languageId: ed.document.languageId } : undefined);
        if (next.uri !== this.binding.uri) this.bind(next, ed?.selection.active);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (this.binding.pinned || e.textEditor.document.uri.toString() !== this.binding.uri) return;
        this.position = e.selections[0]?.active;
        this.scheduleReveal(e.textEditor.document);
      }),
    );
  }

  /** The model the view shows. */
  get shown(): DeclModel | undefined {
    return this.session.shown;
  }

  /** The Monitor value column as the view has it, row id → value (for the integration tests). */
  get monitoredValues(): Record<string, string> | undefined {
    return this.session.monitoredValues;
  }

  /** A message as if the view sent it; the answer the view would get (for the integration tests). */
  receive(m: unknown): Promise<HostToView | undefined> {
    return this.session.receive(m);
  }

  private bind(b: Binding, position?: vscode.Position) {
    const moved = b.uri !== this.binding.uri;
    this.binding = b;
    // a position names the block (a second block's CodeLens in the same file); a new file without one starts at its first
    if (position || moved) this.position = position;
    void this.ctx.workspaceState.update(BINDING_KEY, b);
    this.session.scheduleRefresh(0);
  }

  private scheduleReveal(doc: vscode.TextDocument) {
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealTimer = setTimeout(() => {
      const model = this.session.shown;
      if (!model || !this.position) return;
      const offset = doc.offsetAt(this.position);
      const block = model.block?.range;
      // the cursor went into another block of the file: that block's table
      if (block && (offset < block.start || offset > block.end)) return void this.session.refresh();
      const row = rowAt(model, offset);
      if (row) this.session.post({ v: 1, kind: "reveal", rowId: row.id });
    }, 300);
  }

  refresh(): Promise<void> {
    return this.session.refresh();
  }

  dispose(): void {
    if (DeclarationsPanel.current === this) DeclarationsPanel.current = undefined;
    if (this.revealTimer) clearTimeout(this.revealTimer);
    for (const s of this.subs) s.dispose();
    this.panel.dispose();
  }
}
