// SPDX-License-Identifier: MIT
// The read-only ladder view of a LAD/FBD block (SimaticML): one panel per file, redrawn when the file changes.
// Monitoring reads the networks' operands from the PLC (`rung live watch --json`, read-only) for TIA Portal's
// green-power picture.
import { spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import type { LadderBlock } from "../core/ladderLayout";
import { nonce, webviewHtml } from "../host/webviewHtml";
import type { LiveAccess } from "../liveAccess";
import type { RungCli } from "../runner/cli";
import { stopLive } from "../runner/terminal";
import type { RungWorkspace } from "../workspace";

interface Lsp {
  request<T>(method: string, params: unknown): Promise<T | undefined>;
}
export interface LadderDeps {
  lsp: Lsp;
  ws: RungWorkspace;
  cli: RungCli;
  access: LiveAccess;
}

export class LadderPanel implements vscode.Disposable {
  private static readonly open = new Map<string, LadderPanel>();
  private readonly subs: vscode.Disposable[] = [];
  private disposed = false;
  private live?: ChildProcess;
  private generation = 0;

  private constructor(
    ctx: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly uri: vscode.Uri,
    private readonly deps: LadderDeps,
  ) {
    const asset = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "out", "webview", file)).toString();
    panel.webview.html = webviewHtml({ cspSource: panel.webview.cspSource, nonce: nonce(), script: asset("ladder.js"), styles: [asset("codicon.css"), asset("tokens.css"), asset("rung.css")], title: "Ladder" });
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, ".."), uri.path.split("/").pop()!));
    this.subs.push(
      watcher,
      watcher.onDidChange(() => void this.post()),
      panel.webview.onDidReceiveMessage((m) => void this.message(m)),
      // nothing is read while nobody looks
      panel.onDidChangeViewState((e) => (e.webviewPanel.visible ? undefined : this.stopLive("paused while hidden"))),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  static show(ctx: vscode.ExtensionContext, deps: LadderDeps, uri: vscode.Uri): void {
    const known = this.open.get(uri.toString());
    if (known) return known.panel.reveal();
    const name = uri.path.split("/").pop()!.replace(/\.xml$/i, "");
    const panel = vscode.window.createWebviewPanel("rung.ladder", name, vscode.ViewColumn.Active, { enableScripts: true, enableFindWidget: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "out", "webview")], retainContextWhenHidden: true });
    panel.iconPath = new vscode.ThemeIcon("type-hierarchy-sub");
    const instance = new LadderPanel(ctx, panel, uri, deps);
    this.open.set(uri.toString(), instance);
    ctx.subscriptions.push(instance);
  }

  private async post(): Promise<void> {
    const r = await this.deps.lsp.request<LadderBlock | { error: string }>("rung/ladder", { textDocument: { uri: this.uri.toString() } }).catch((e: Error) => ({ error: e.message }));
    if (this.disposed) return;
    if (!r) return void this.panel.webview.postMessage({ kind: "ladder", error: "The rung language server is not running." });
    void this.panel.webview.postMessage("error" in r ? { kind: "ladder", error: r.error } : { kind: "ladder", block: r });
  }

  private async message(m: { kind?: string; name?: string; names?: string[] }): Promise<void> {
    if (m?.kind === "ready") return this.post();
    if (m?.kind === "openText") return void vscode.commands.executeCommand("vscode.openWith", this.uri, "default");
    if (m?.kind === "monitor") return Array.isArray(m.names) ? this.startLive(m.names) : this.stopLive();
    if (m?.kind === "operand" && m.name) {
      // "Tank".Level → Tank; #Motor.Run → Motor (a local of this block: the declarations are in the XML)
      const root = m.name.replace(/^#/, "").replace(/^"([^"]+)".*$/, "$1").split(/[.[]/)[0]!;
      await vscode.commands.executeCommand("workbench.action.quickOpen", `#${root}`);
    }
  }

  private status(message: string, state: "live" | "off" | "error" = "off") {
    void this.panel.webview.postMessage({ kind: "monitorState", state, message });
  }

  private async startLive(names: string[]): Promise<void> {
    this.stopLive();
    const generation = ++this.generation;
    if (!names.length) return this.status("Nothing in these networks the PLC can be asked for (temporaries and constants only).", "error");
    const { access, cli, ws } = this.deps;
    const connection = await access.select();
    if (!connection || generation !== this.generation) return this.status("No PLC chosen.", "error");
    const env = await access.environment(connection);
    if (!env || generation !== this.generation) return this.status("No password given.", "error");
    const inv = cli.invocation(["live", "watch", ...names, "--json", "--parent-stdio", "--device", connection.device, "--interval", connection.target.transport === "s7commplus" ? "250" : "500"]);
    const proc = spawn(inv.file, inv.args, { cwd: ws.root, env: { ...process.env, ...env }, windowsVerbatimArguments: inv.shell, windowsHide: true });
    this.live = proc;
    this.status(`${connection.device} · ${connection.target.transport} · ${connection.target.address}`, "live");
    let buf = "", err = "";
    proc.stdout.on("data", (d: Buffer) => {
      if (this.live !== proc) return;
      buf += d.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const f = JSON.parse(line) as { at?: number; values?: Record<string, unknown>; errors?: Record<string, string>; state?: string };
          if (f.at !== undefined) void this.panel.webview.postMessage({ kind: "values", values: f.values ?? {}, errors: f.errors ?? {}, state: f.state ?? "live" });
        } catch { /* not a frame */ }
      }
    });
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("exit", (code) => {
      if (this.live !== proc) return;
      this.live = undefined;
      this.status(code ? err.trim().split(/\r?\n/).pop()?.replace(/^rung live:\s*/, "") || `rung live watch ended (${code})` : "Monitoring ended.", code ? "error" : "off");
    });
  }

  private stopLive(message?: string): void {
    this.generation++;
    const proc = this.live;
    this.live = undefined;
    if (proc) stopLive(proc);
    if (message && proc) this.status(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLive();
    LadderPanel.open.delete(this.uri.toString());
    for (const s of this.subs) s.dispose();
    this.panel.dispose();
  }
}
