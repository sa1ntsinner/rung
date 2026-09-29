// SPDX-License-Identifier: MIT
// "Environment" view: what `rung check --json` finds on this PC (TIA Portal, Openness, PLCSIM, TwinCAT, CODESYS,
// editors, agents) and how to get the rest. It needs no workspace.
import * as vscode from "vscode";
import { parseCheck, type CheckItem } from "../core/args";
import { RungCli } from "../runner/cli";

export type { CheckItem };

const GROUPS: readonly [string, string][] = [
  ["plc", "PLC platforms"],
  ["editor", "Editors"],
  ["agent", "AI agents"],
  ["base", "Basics"],
];

/** Problems rung fixes itself; the command runs in a terminal so the person sees what happens. */
export const FIXES: Readonly<Record<string, { args: string[]; label: string }>> = {
  whitelist: { args: ["setup", "openness"], label: "Register the rung bridge with TIA Portal Openness" },
};

type Node = { type: "group"; group: string; label: string } | { type: "item"; item: CheckItem } | { type: "message"; text: string };

export class EnvironmentView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<Node>;
  items: CheckItem[] | undefined;
  private error: string | undefined;
  private loading: Promise<void> | undefined;

  constructor(private readonly cli: RungCli) {
    this.view = vscode.window.createTreeView("rung.environment", { treeDataProvider: this });
  }

  /** Runs rung check again (a click on refresh, or after a fix). */
  refresh(): Promise<void> {
    this.loading ??= this.cli
      .capture(["check", "--json"], { quiet: true, timeoutMs: 120_000 })
      .then((r) => {
        this.items = parseCheck(r.output);
        this.error = this.items ? undefined : RungCli.summary(r.output) || "rung check gave no answer";
      })
      .finally(() => {
        this.loading = undefined;
        this.changed.fire(undefined);
      });
    return this.loading;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.type === "message") return new vscode.TreeItem(n.text);
    if (n.type === "group") {
      const all = this.items!.filter((i) => i.group === n.group);
      const t = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
      t.description = `${all.filter((i) => i.status === "ok").length} of ${all.length}`;
      return t;
    }
    const i = n.item;
    const t = new vscode.TreeItem(i.name);
    t.description = i.status === "ok" ? i.detail ?? "" : i.status === "warn" ? i.detail ?? "needs attention" : "not installed";
    t.iconPath =
      i.status === "ok"
        ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"))
        : i.status === "warn"
          ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"))
          : new vscode.ThemeIcon("circle-large-outline");
    const md = new vscode.MarkdownString(`**${i.name}**${i.detail ? ` · ${i.detail}` : ""}\n\n${i.enables ? `For ${i.enables}.` : ""}${i.fix ? `\n\n${i.fix}` : ""}${i.link ? `\n\n${i.link}` : ""}`);
    t.tooltip = md;
    t.contextValue = `env.${i.status}${FIXES[i.id] ? ".fixable" : ""}${i.link ? ".link" : ""}`;
    if (i.status !== "ok" && FIXES[i.id]) t.command = { command: "rung.env.fix", title: FIXES[i.id]!.label, arguments: [i] };
    else if (i.status !== "ok" && i.link) t.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.parse(i.link)] };
    return t;
  }

  getChildren(n?: Node): Node[] {
    if (!n) {
      if (!this.items) {
        if (!this.loading && !this.error) void this.refresh();
        return [{ type: "message", text: this.error ?? "Checking this PC…" }];
      }
      return GROUPS.filter(([g]) => this.items!.some((i) => i.group === g)).map(([group, label]) => ({ type: "group" as const, group, label }));
    }
    if (n.type === "group") return this.items!.filter((i) => i.group === n.group).map((item) => ({ type: "item" as const, item }));
    return [];
  }

  dispose(): void {
    this.view.dispose();
    this.changed.dispose();
  }
}

