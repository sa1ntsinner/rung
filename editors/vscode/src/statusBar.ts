// SPDX-License-Identifier: MIT
// Status bar item: one phrase for the save loop (core/activity.ts) and the online PLCs, click → rung.quickPick.
import * as vscode from "vscode";
import { statusPhrase, type Activity } from "./core/activity";
import type { OnlineMonitor } from "./online";
import type { OwnerEvents } from "./ownerEvents";
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
    private readonly activity: Activity,
    events: OwnerEvents,
  ) {
    this.item.name = "rung";
    this.item.command = "rung.quickPick";
    const u = () => this.update();
    this.subs.push(
      this.item,
      ws.onDidChange(u),
      watch.onDidChange(u),
      online.onDidChange(u),
      events.onEvent(u),
      // a phase without news for a while turns into "waiting for TIA Portal": looked at again every few seconds
      new vscode.Disposable(((t) => () => clearInterval(t))(setInterval(() => this.activity.now && u(), 5000))),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("rung.statusBar")) u();
      }),
    );
    this.update();
  }

  /** Current text and visibility (for tests). */
  visible = false;

  get text(): string {
    return this.item.text;
  }

  get tooltipText(): string {
    const t = this.item.tooltip;
    return typeof t === "string" ? t : (t?.value ?? "");
  }

  update(): void {
    if (!readSettings().statusBar || !this.ws.hasConfig) {
      this.item.hide();
      this.visible = false;
      return;
    }
    const conflicts = this.ws.conflicts.length;
    const status = this.watch.status;
    const parts: string[] = [];
    // one phrase: what the save loop is doing now, else the most important standing fact
    if (status === "starting" || status === "stopping") {
      parts.push(`$(sync~spin) rung · ${status === "starting" ? "starting watch" : "stopping watch"}`);
      this.item.backgroundColor = undefined;
    }
    else {
      const phrase = statusPhrase(this.activity, { watching: status === "running", writes: this.ws.writes, conflicts });
      parts.push(phrase.text);
      this.item.backgroundColor = phrase.tone === "error" ? new vscode.ThemeColor("statusBarItem.errorBackground") : phrase.tone === "warning" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    }
    const online = this.online.online();
    if (online.length) parts.push(`$(plug) ${online.length === 1 ? `${online[0]} online` : `${online.length} PLCs online`}`);
    this.item.text = parts.join("  ");
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**rung** · ${this.ws.objects.length} mirrored objects\n\n`);
    md.appendMarkdown(status === "running" ? `$(sync) rung watch is running (pid ${this.ws.owner?.pid}), writes to TIA Portal ${this.ws.writes === "on" ? "on" : "off"}\n\n` : "$(circle-slash) rung watch is not running\n\n");
    const last = this.activity.entries[0];
    if (last) md.appendMarkdown(`Last: ${last.label}\n\n`);
    if (conflicts) md.appendMarkdown(`$(warning) conflicts: ${this.ws.conflicts.map((c) => `\`${c}\``).join(", ")}\n\n`);
    for (const d of this.ws.devices()) {
      const s = this.online.get(d);
      md.appendMarkdown(`$(circuit-board) ${d}: ${s.state ?? (s.checking ? "checking…" : "online state not checked")}\n\n`);
    }
    md.appendMarkdown("Click for rung actions (Alt+Q Q)");
    this.item.tooltip = md;
    this.item.show();
    this.visible = true;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
