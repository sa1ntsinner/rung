// SPDX-License-Identifier: MIT
// "Environment" view: what `rung check --json` finds on this PC (TIA Portal, Openness, PLCSIM, TwinCAT, CODESYS,
// editors, agents) and how to get the rest. It needs no workspace.
import * as vscode from "vscode";
import { onPath } from "../bundled";
import { parseCheck, type CheckItem } from "../core/args";
import { tiaReadiness } from "../core/firstUse";
import { findExecutable } from "../core/exec";
import { RungCli } from "../runner/cli";
import { isFile } from "../workspace";

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
    if (!this.loading) void vscode.commands.executeCommand("setContext", "rung.tiaReady", false);
    this.loading ??= this.cli
      .capture(["check", "--json"], { quiet: true, timeoutMs: 120_000 })
      .then((r) => {
        this.items = parseCheck(r.output);
        this.error = this.items ? undefined : RungCli.summary(r.output) || "rung check gave no answer";
        const readiness = tiaReadiness(r.error ? undefined : this.items);
        this.view.message = this.error ?? readiness.message;
        void vscode.commands.executeCommand("setContext", "rung.tiaReady", readiness.ok);
        // the extension's own rung works here; terminals and agents need it on PATH
        if (this.items && RungCli.bundled) {
          const ok = (!!RungCli.bundledBase && onPath(RungCli.bundledBase)) || !!findExecutable("rung", { platform: process.platform, env: process.env, isFile });
          this.items.push({
            id: "rung-command",
            group: "base",
            name: "rung command in terminals and agents",
            status: ok ? "ok" : "missing",
            ...(ok ? { detail: "on PATH" } : {}),
            enables: "rung in a terminal and for AI agents (the extension has its own)",
            ...(ok ? {} : { fix: "Click to put rung on your PATH" }),
          });
        }
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
    if (i.id === "rung-command" && i.status !== "ok") t.command = { command: "rung.installCommand", title: "Put rung on PATH" };
    else if (i.status !== "ok" && FIXES[i.id]) t.command = { command: "rung.env.fix", title: FIXES[i.id]!.label, arguments: [i] };
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
