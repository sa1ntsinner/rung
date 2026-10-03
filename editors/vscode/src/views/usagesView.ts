// SPDX-License-Identifier: MIT
// The Usages view: who writes and who reads a name, kept in the sidebar while you open the places it lists. Filled by
// Who Writes This? and by a declaration's "Where used"; the language server finds the uses (rung/usages).
import * as vscode from "vscode";
import { usagesTree, type UNode, type Usages } from "../core/usagesTree";
import type { Lsp } from "../lsp";

export class UsagesView implements vscode.TreeDataProvider<UNode>, vscode.Disposable {
  private nodes: UNode[] = [];
  private last: { uri: vscode.Uri; position: vscode.Position; symbol: string } | undefined;
  private readonly changed = new vscode.EventEmitter<UNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<UNode>;

  constructor(private readonly lsp: Lsp) {
    this.view = vscode.window.createTreeView("rung.usages", { treeDataProvider: this, showCollapseAll: true });
  }

  /** Finds the uses of the name at `position` and shows them, the view brought to front. */
  async show(uri: vscode.Uri, position: vscode.Position, symbol: string): Promise<void> {
    this.last = { uri, position, symbol };
    const r = await this.lsp.request<Usages>("rung/usages", { textDocument: { uri: uri.toString() }, position });
    if (!r) {
      void vscode.window.showWarningMessage("The rung language server is not running.");
      return;
    }
    this.nodes = usagesTree(r, (u) => vscode.workspace.asRelativePath(vscode.Uri.parse(u)));
    this.view.title = "Usages";
    this.view.description = symbol;
    await vscode.commands.executeCommand("setContext", "rung.hasUsages", true);
    this.changed.fire(undefined);
    await vscode.commands.executeCommand("rung.usages.focus");
  }

  async refresh(): Promise<void> {
    if (this.last) await this.show(this.last.uri, this.last.position, this.last.symbol);
  }

  getTreeItem(n: UNode): vscode.TreeItem {
    const group = !n.location && !!n.children;
    const item = new vscode.TreeItem(
      n.label,
      !n.children ? vscode.TreeItemCollapsibleState.None : group || n.id.startsWith("writes-") ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = n.id;
    if (n.description) item.description = n.description;
    if (n.tooltip) item.tooltip = n.tooltip;
    if (n.icon) item.iconPath = new vscode.ThemeIcon(n.icon);
    if (n.location) {
      const r = n.location.range;
      const selection = new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
      item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.parse(n.location.uri), { selection, preserveFocus: true, preview: true }] };
    }
    item.accessibilityInformation = { label: [n.label, n.description].filter(Boolean).join(", ") };
    return item;
  }

  getChildren(n?: UNode): UNode[] {
    return n ? (n.children ?? []) : this.nodes;
  }

  dispose(): void {
    this.view.dispose();
    this.changed.dispose();
  }
}
