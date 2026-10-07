// SPDX-License-Identifier: MIT
// "Activity" view: what rung watch did, newest first (core/activity.ts), so nobody has to read the watch terminal.
import { join } from "node:path";
import * as vscode from "vscode";
import type { Activity, ActivityEntry } from "../core/activity";
import type { OwnerEvents } from "../ownerEvents";
import type { RungWorkspace } from "../workspace";

const ICON: Record<ActivityEntry["kind"], [string, string?]> = {
  import: ["arrow-right"],
  create: ["add"],
  export: ["arrow-left"],
  merge: ["git-merge"],
  remove: ["trash"],
  restore: ["history"],
  refused: ["circle-slash", "list.errorForeground"],
  error: ["debug-disconnect", "list.warningForeground"],
};

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export class ActivityView implements vscode.TreeDataProvider<ActivityEntry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<ActivityEntry>;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly ws: RungWorkspace,
    private readonly activity: Activity,
    events: OwnerEvents,
  ) {
    this.view = vscode.window.createTreeView("rung.activity", { treeDataProvider: this });
    this.sub = events.onEvent(({ event }) => {
      if (event === "report" || event === "error") this.changed.fire();
    });
  }

  getChildren(e?: ActivityEntry): ActivityEntry[] {
    return e ? [] : this.activity.entries;
  }

  getTreeItem(e: ActivityEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(e.label, vscode.TreeItemCollapsibleState.None);
    const [icon, color] = e.errors ? ["error", "list.errorForeground"] : ICON[e.kind];
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.description = time(e.at) + (e.count ? `  ×${e.count}` : "") + (e.ms !== undefined && e.ms >= 1000 ? `  ${(e.ms / 1000).toFixed(1)} s` : "");
    item.tooltip = [e.label, e.path, `${new Date(e.at).toLocaleString()}${e.ms !== undefined ? `, ${e.ms} ms` : ""}`].filter(Boolean).join("\n");
    // the file, at TIA Portal's first error when there is one (the rest are in Problems)
    if (e.path && this.ws.root && e.kind !== "remove") {
      const at = e.line ? { selection: new vscode.Range(e.line - 1, 0, e.line - 1, 0) } : {};
      item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(join(this.ws.root, e.path)), at] };
    }
    return item;
  }

  dispose(): void {
    this.sub.dispose();
    this.view.dispose();
    this.changed.dispose();
  }
}
