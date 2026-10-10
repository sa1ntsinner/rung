// SPDX-License-Identifier: MIT
// The read-only ladder view of a LAD/FBD block (SimaticML): one panel per file, redrawn when the file changes.
import * as vscode from "vscode";
import type { LadderBlock } from "../core/ladderLayout";
import { nonce, webviewHtml } from "../host/webviewHtml";

interface Lsp {
  request<T>(method: string, params: unknown): Promise<T | undefined>;
}

export class LadderPanel implements vscode.Disposable {
  private static readonly open = new Map<string, LadderPanel>();
  private readonly subs: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(
    ctx: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly uri: vscode.Uri,
    private readonly lsp: Lsp,
  ) {
    const asset = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "webview", file)).toString();
    panel.webview.html = webviewHtml({ cspSource: panel.webview.cspSource, nonce: nonce(), script: asset("ladder.js"), styles: [asset("codicon.css"), asset("tokens.css"), asset("rung.css")], title: "Ladder" });
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, ".."), uri.path.split("/").pop()!));
    this.subs.push(
      watcher,
      watcher.onDidChange(() => void this.post()),
      panel.webview.onDidReceiveMessage((m) => void this.message(m)),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  static show(ctx: vscode.ExtensionContext, lsp: Lsp, uri: vscode.Uri): void {
    const known = this.open.get(uri.toString());
    if (known) return known.panel.reveal();
    const name = uri.path.split("/").pop()!.replace(/\.xml$/i, "");
    const panel = vscode.window.createWebviewPanel("rung.ladder", name, vscode.ViewColumn.Active, { enableScripts: true, enableFindWidget: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "out", "webview")], retainContextWhenHidden: true });
    panel.iconPath = new vscode.ThemeIcon("type-hierarchy-sub");
    const instance = new LadderPanel(ctx, panel, uri, lsp);
    this.open.set(uri.toString(), instance);
    ctx.subscriptions.push(instance);
  }

  private async post(): Promise<void> {
    const r = await this.lsp.request<LadderBlock | { error: string }>("rung/ladder", { textDocument: { uri: this.uri.toString() } }).catch((e: Error) => ({ error: e.message }));
    if (this.disposed) return;
    if (!r) return void this.panel.webview.postMessage({ kind: "ladder", error: "The rung language server is not running." });
    void this.panel.webview.postMessage("error" in r ? { kind: "ladder", error: r.error } : { kind: "ladder", block: r });
  }

  private async message(m: { kind?: string; name?: string }): Promise<void> {
    if (m?.kind === "ready") return this.post();
    if (m?.kind === "openText") return void vscode.commands.executeCommand("vscode.openWith", this.uri, "default");
    if (m?.kind === "operand" && m.name) {
      // "Tank".Level → Tank; #Motor.Run → Motor (a local of this block: the declarations are in the XML)
      const root = m.name.replace(/^#/, "").replace(/^"([^"]+)".*$/, "$1").split(/[.[]/)[0]!;
      await vscode.commands.executeCommand("workbench.action.quickOpen", `#${root}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    LadderPanel.open.delete(this.uri.toString());
    for (const s of this.subs) s.dispose();
    this.panel.dispose();
  }
}
