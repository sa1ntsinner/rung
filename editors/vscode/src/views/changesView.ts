// SPDX-License-Identifier: MIT
// "Changes" view: what the next sync would send to TIA Portal and bring into the files, kept on screen while you
// look at each diff (rung sync --preview --json, the sync engine itself). Sync Now applies only the plan you saw:
// it asks for the plan again first, and a plan that changed meanwhile is shown, not synced.
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { CompareItem } from "../core/args";
import { ICON, SENT, describe, parsePreview, type PlanEntry } from "../core/preview";
import type { OwnerEvents } from "../ownerEvents";
import { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";

type Group = "send" | "receive" | "conflict" | "delete";
type Node =
  | { type: "group"; group: Group; entries: PlanEntry[] }
  | { type: "entry"; entry: PlanEntry }
  | { type: "compared"; device: string }
  | { type: "difference"; item: CompareItem };

const COMPARED: Record<string, [string, string]> = { Different: ["differs", "diff"], OnlyInProject: ["only in the project", "file-add"], OnlyOnPlc: ["only on the PLC", "circuit-board"] };

const GROUPS: { group: Group; label: string; icon: string; actions: PlanEntry["action"][] }[] = [
  { group: "conflict", label: "Conflicts", icon: "warning", actions: ["conflict"] },
  { group: "send", label: "To TIA Portal", icon: "arrow-right", actions: ["create", "update", "merge"] },
  { group: "receive", label: "From TIA Portal", icon: "arrow-left", actions: ["export", "restore", "remove"] },
  { group: "delete", label: "Deleted here, waiting", icon: "circle-slash", actions: ["pending-delete"] },
];

/** Identifies a plan: two previews with the same changes have the same id. */
export function planId(entries: PlanEntry[]): string {
  const h = createHash("sha256");
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path) || a.action.localeCompare(b.action))) h.update(`${e.path}\0${e.action}\0${e.before ?? ""}\0${e.after ?? ""}\0`);
  return h.digest("hex").slice(0, 16);
}

/** Virtual documents for the diffs: rung-preview:/<plan>/<side>/<file>. */
class PreviewDocs implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  set(key: string, text: string): vscode.Uri {
    this.texts.set(key, text);
    return vscode.Uri.from({ scheme: "rung-preview", path: "/" + key });
  }
  clear(): void {
    this.texts.clear();
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.path.slice(1)) ?? "";
  }
}

export class ChangesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<Node>;
  private readonly docs = new PreviewDocs();
  private readonly subs: vscode.Disposable[] = [];
  entries: PlanEntry[] | undefined;
  id: string | undefined;
  writesOff = false;
  compile: string[] = [];
  /** the last comparison with a PLC: project (TIA Portal) against what runs on it */
  comparison: { device: string; at: number; identical: number; items: CompareItem[] } | undefined;
  private loading: Promise<boolean> | undefined;

  constructor(
    private readonly ws: RungWorkspace,
    private readonly cli: RungCli,
    events: OwnerEvents,
  ) {
    this.view = vscode.window.createTreeView("rung.changes", { treeDataProvider: this });
    this.subs.push(
      this.view,
      vscode.workspace.registerTextDocumentContentProvider("rung-preview", this.docs),
      // a pass of the watch changes the plan: the list follows while somebody looks at it
      events.onEvent(({ event }) => {
        if (event === "report" && this.view.visible && this.entries) void this.refresh(false);
      }),
      this.view.onDidChangeVisibility((e) => {
        if (e.visible && !this.entries) void this.refresh(false);
      }),
    );
  }

  /** Asks rung for the plan. `progress`: show the notification (a person asked). False when it failed. */
  refresh(progress = true): Promise<boolean> {
    return (this.loading ??= this.load(progress).finally(() => (this.loading = undefined)));
  }

  private async load(progress: boolean): Promise<boolean> {
    if (!this.ws.hasConfig) return false;
    const r = await this.cli.capture(["sync", "--preview", "--json"], progress ? { progress: "rung: what would the next sync do?", cancellable: true } : { quiet: true });
    if (r.error || r.code === null) return false;
    const report = r.code === 0 ? parsePreview(r.output) : undefined;
    if (!report?.plan) {
      if (progress) void vscode.window.showErrorMessage(`rung sync --preview failed: ${RungCli.summary(r.output)}`);
      return false;
    }
    this.entries = report.plan.entries;
    this.compile = report.plan.compile;
    this.writesOff = !!report.writesOff;
    this.id = planId(this.entries);
    this.docs.clear();
    const sends = this.entries.some((e) => SENT.has(e.action));
    this.view.message = !this.entries.length
      ? "Files and TIA Portal agree: the next sync has nothing to do."
      : sends && this.writesOff
        ? "Writes to TIA Portal are off: what goes to TIA Portal waits until you turn them on."
        : undefined;
    this.view.badge = this.entries.length ? { value: this.entries.length, tooltip: `${this.entries.length} change${this.entries.length > 1 ? "s" : ""} for the next sync` } : undefined;
    void vscode.commands.executeCommand("setContext", "rung.changes.sendsWithWritesOff", sends && this.writesOff);
    void vscode.commands.executeCommand("setContext", "rung.changes.any", this.entries.length > 0);
    this.changed.fire();
    return true;
  }

  /** Sync Now from the view: only the plan that is on screen. */
  async syncReviewed(): Promise<void> {
    const seen = this.id;
    if (!seen) return void (await this.refresh());
    if (!(await this.refresh())) return;
    if (this.id !== seen) {
      void vscode.window.showWarningMessage("The changes moved on while you looked (a save, or an edit in TIA Portal). Nothing was synced: the list shows them as they are now.");
      return;
    }
    await vscode.commands.executeCommand("rung.sync");
    await this.refresh(false);
  }

  /** A comparison with the PLC (rung compare): kept here, below what the next sync does. */
  setComparison(device: string, identical: number, items: CompareItem[]): void {
    this.comparison = { device, at: Date.now(), identical, items };
    this.changed.fire();
  }

  getChildren(n?: Node): Node[] {
    if (!n) {
      const groups: Node[] = this.entries
        ? GROUPS.map((g) => ({ type: "group" as const, group: g.group, entries: this.entries!.filter((e) => g.actions.includes(e.action)) })).filter((g) => g.entries.length)
        : [];
      return this.comparison ? [...groups, { type: "compared", device: this.comparison.device }] : groups;
    }
    if (n.type === "compared") return this.comparison!.items.map((item) => ({ type: "difference" as const, item }));
    return n.type === "group" ? n.entries.map((entry) => ({ type: "entry" as const, entry })) : [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.type === "compared") {
      const c = this.comparison!;
      const it = new vscode.TreeItem(`${c.device} · compared ${new Date(c.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`, c.items.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      it.id = "compared";
      it.description = c.items.length ? `${c.items.length} not as in the project · ${c.identical} identical` : `runs what the project has (${c.identical} objects)`;
      it.iconPath = new vscode.ThemeIcon(c.items.length ? "diff-multiple" : "pass-filled", c.items.length ? new vscode.ThemeColor("list.warningForeground") : new vscode.ThemeColor("testing.iconPassed"));
      it.tooltip = `TIA Portal's comparison of the project with ${c.device}, ${new Date(c.at).toLocaleString()}. The files and the project agree when the next sync has nothing to do.`;
      it.contextValue = "rung.compared";
      return it;
    }
    if (n.type === "difference") {
      const [what, icon] = COMPARED[n.item.state] ?? [n.item.state, "question"];
      const it = new vscode.TreeItem(n.item.name.replace(/ \[[^\]]*\]$/, ""), vscode.TreeItemCollapsibleState.None);
      it.id = `difference:${n.item.path}`;
      it.description = what;
      it.tooltip = `${n.item.path}${n.item.file ? `\n${n.item.file}` : ""}`;
      it.iconPath = new vscode.ThemeIcon(icon);
      if (n.item.file && this.ws.root) {
        it.resourceUri = vscode.Uri.joinPath(vscode.Uri.file(this.ws.root), ...n.item.file.split("/"));
        it.command = { command: "vscode.open", title: "Open", arguments: [it.resourceUri] };
      }
      return it;
    }
    if (n.type === "group") {
      const g = GROUPS.find((x) => x.group === n.group)!;
      const it = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Expanded);
      it.id = `group:${n.group}`;
      it.description = String(n.entries.length);
      it.iconPath = new vscode.ThemeIcon(g.icon, n.group === "conflict" ? new vscode.ThemeColor("list.warningForeground") : undefined);
      if (n.group === "send" && this.compile.length) it.tooltip = `Then compiles ${this.compile.length} object${this.compile.length > 1 ? "s" : ""} in TIA Portal`;
      return it;
    }
    const e = n.entry;
    const d = describe(e);
    const file = e.path.split("/").pop() ?? e.path;
    const it = new vscode.TreeItem(file, vscode.TreeItemCollapsibleState.None);
    it.id = `entry:${e.action}:${e.path}`;
    it.description = d.description;
    it.tooltip = `${d.label}\n${e.path}${e.detail ? `\n${e.detail}` : ""}`;
    it.iconPath = new vscode.ThemeIcon(ICON[e.action]);
    it.resourceUri = this.ws.root ? vscode.Uri.joinPath(vscode.Uri.file(this.ws.root), ...e.path.split("/")) : undefined;
    it.contextValue = `rung.change.${e.action}`;
    it.command = { command: "rung.changes.open", title: "Show the change", arguments: [e] };
    return it;
  }

  /** The change as a diff of the side it lands on (TIA Portal for what is sent, the file for what comes back). */
  async open(e: PlanEntry): Promise<void> {
    const file = e.path.split("/").pop() ?? e.path;
    if (e.before !== undefined && e.after !== undefined) {
      const left = this.docs.set(`${this.id}/before/${e.path}`, e.before);
      const right = this.docs.set(`${this.id}/after/${e.path}`, e.after);
      const side = SENT.has(e.action) ? "TIA Portal" : "file";
      await vscode.commands.executeCommand("vscode.diff", left, right, `${file}: ${side} now ↔ after the sync`, { preview: true });
    } else if (this.ws.root) await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(this.ws.root), ...e.path.split("/")), { preview: true });
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}
