// SPDX-License-Identifier: MIT
// Status bar item: watching / idle / conflicts / online, click → rung.quickPick.
import * as vscode from "vscode";
import type { OnlineMonitor } from "./online";
import type { WatchController } from "./runner/watch";
import { readSettings } from "./settings";
import type { RungWorkspace } from "./workspace";

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("rung.status", vscode.StatusBarAlignment.Left, 50);
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly ws: RungWorkspace,
    private readonly watch: WatchController,
    private readonly online: OnlineMonitor,
  ) {
    this.item.name = "rung";
    this.item.command = "rung.quickPick";
    const u = () => this.update();
    this.subs.push(
      this.item,
      ws.onDidChange(u),
      watch.onDidChange(u),
      online.onDidChange(u),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("rung.statusBar")) u();
      }),
    );
    this.update();
  }

  update(): void {
    if (!readSettings().statusBar || !this.ws.hasConfig) {
      this.item.hide();
      return;
    }
    const conflicts = this.ws.conflicts.length;
    const status = this.watch.status;
    const parts: string[] = [];
    if (conflicts) parts.push(`$(warning) rung: ${conflicts} conflict${conflicts > 1 ? "s" : ""}`);
    else if (status === "running") parts.push("$(eye) rung: watching");
    else if (status === "starting" || status === "stopping") parts.push(`$(sync~spin) rung: ${status}`);
    else parts.push("$(circle-slash) rung: idle");
    const online = this.online.online();
    if (online.length) parts.push(`$(plug) ${online.length === 1 ? `${online[0]} online` : `${online.length} PLCs online`}`);
    this.item.text = parts.join("  ");
    this.item.backgroundColor = conflicts ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**rung** · ${this.ws.objects.length} mirrored objects\n\n`);
    md.appendMarkdown(status === "running" ? `$(eye) rung watch is running (pid ${this.ws.owner?.pid})\n\n` : "$(circle-slash) rung watch is not running\n\n");
    if (conflicts) md.appendMarkdown(`$(warning) conflicts: ${this.ws.conflicts.map((c) => `\`${c}\``).join(", ")}\n\n`);
    for (const d of this.ws.devices()) {
      const s = this.online.get(d);
      md.appendMarkdown(`$(circuit-board) ${d}: ${s.state ?? (s.checking ? "checking…" : "online state not checked")}\n\n`);
    }
    md.appendMarkdown("Click for rung actions (Alt+Q Q)");
    this.item.tooltip = md;
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
