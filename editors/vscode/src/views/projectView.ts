// SPDX-License-Identifier: MIT
// "Project" view: mirrored objects from .rung/state.json, device → kind → folders → objects.
import { open } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { detectBlockType, type BlockType } from "../core/headers";
import { buildTree, objectsOf, type ContainerNode, type ObjectInfo, type TreeNode } from "../core/state";
import { readSettings } from "../settings";
import type { RungWorkspace } from "../workspace";

const SNIFF_BYTES = 4096;
const SNIFF_FORMS = new Set(["scl", "awl", "s7dcl", "xml", "protected.yaml"]);

const TYPE_ICON: Readonly<Record<BlockType, [string, string]>> = {
  OB: ["symbol-event", "charts.purple"],
  FB: ["symbol-class", "charts.orange"],
  FC: ["symbol-method", "charts.blue"],
  DB: ["database", "charts.green"],
  UDT: ["symbol-structure", "charts.yellow"],
};

const KIND_ICON: Readonly<Record<string, string>> = {
  block: "symbol-misc",
  type: "symbol-structure",
  tagtable: "symbol-variable",
  techobject: "settings",
  watchtable: "eye",
  forcetable: "pinned",
  hardware: "server-environment",
};

const SECTION_ICON: Readonly<Record<string, string>> = {
  block: "symbol-namespace",
  type: "symbol-structure",
  tagtable: "tag",
  techobject: "settings-gear",
  watchtable: "eye",
  forcetable: "pinned",
  hardware: "server-environment",
};

export class ProjectItem extends vscode.TreeItem {
  constructor(
    readonly node: TreeNode,
    root: string,
  ) {
    super(node.label, node.type === "object" ? vscode.TreeItemCollapsibleState.None : ProjectItem.collapse(node));
    this.id = node.id;
    if (node.type === "object") this.initObject(node.object, node.description, root);
    else this.initContainer(node);
  }

  private static collapse(n: ContainerNode): vscode.TreeItemCollapsibleState {
    return n.type === "device" || n.type === "section" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
  }

  private initContainer(n: ContainerNode) {
    const parts = [`${n.count}`];
    if (n.conflicts) parts.push(`${n.conflicts} conflict${n.conflicts > 1 ? "s" : ""}`);
    this.description = parts.join(" · ");
    this.contextValue = `rung.${n.type}`;
    const icon = n.type === "device" ? "circuit-board" : n.type === "unit" ? "package" : n.type === "section" ? SECTION_ICON[n.kind] ?? "folder" : "folder";
    this.iconPath = new vscode.ThemeIcon(icon, n.conflicts ? new vscode.ThemeColor("list.warningForeground") : undefined);
    if (n.type === "device") this.tooltip = `PLC ${n.device}: ${n.count} mirrored objects`;
  }

  private initObject(o: ObjectInfo, description: string, root: string) {
    this.resourceUri = vscode.Uri.file(join(root, o.path));
    this.description = description;
    const type = o.blockType;
    let icon = type ? TYPE_ICON[type][0] : KIND_ICON[o.kind] ?? "file";
    let color: string | undefined = type ? TYPE_ICON[type][1] : undefined;
    if (o.readOnly) icon = "lock";
    if (o.flag === "conflict") {
      icon = "warning";
      color = "list.errorForeground";
    } else if (o.flag === "recovery") {
      icon = "error";
      color = "list.errorForeground";
    }
    this.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    const tags = ["rung.object"];
    const compilable = !o.readOnly && (o.kind === "block" || o.kind === "type");
    if (compilable) tags.push("compilable");
    if (o.kind === "block" && (type === "FB" || type === "FC" || type === undefined) && !o.readOnly) tags.push("testable");
    if (o.kind !== "tagtable" || o.form === "tags.st") tags.push("openable"); // a SimaticML table is not for reading
    if (o.flag === "conflict" && o.status === "conflicted") tags.push("conflicted");
    if (o.readOnly) tags.push("readonly");
    this.contextValue = tags.join(" ");
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${o.name}**${type ? ` (${type})` : ""}  \n`);
    md.appendMarkdown(`\`${o.path}\`  \n`);
    md.appendMarkdown(`status: ${o.status}${o.readOnly ? " · read-only in rung" : ""}`);
    for (const w of o.warnings.slice(0, 5)) md.appendMarkdown(`  \n$(warning) ${w.replace(/[\\`*_[\]]/g, "\\$&")}`);
    this.tooltip = md;
    this.command = { command: "vscode.open", title: "Open", arguments: [this.resourceUri] };
  }
}

export class ProjectView implements vscode.TreeDataProvider<ProjectItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ProjectItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: TreeNode[] = [];
  /** path → block type sniffed from the file header, keyed by size and mtime. */
  private readonly types = new Map<string, { size: number; mtime: number; type: BlockType | undefined }>();
  private sniffing: Promise<void> | undefined;
  readonly view: vscode.TreeView<ProjectItem>;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly ws: RungWorkspace) {
    this.view = vscode.window.createTreeView("rung.project", { treeDataProvider: this, showCollapseAll: true });
    this.subs.push(
      this.view,
      ws.onDidChange(() => this.rebuild()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("rung.projectView")) this.rebuild();
      }),
    );
    this.rebuild();
  }

  refresh(): void {
    this.types.clear();
    void this.ws.reload();
  }

  private rebuild(): void {
    const s = readSettings().projectView;
    const objects = objectsOf(this.ws.state, { blockType: (o) => this.types.get(o.path)?.type });
    this.roots = buildTree(objects, { grouping: s.grouping, showReadOnly: s.showReadOnly });
    const conflicts = objects.filter((o) => o.flag === "conflict").length;
    this.view.badge = conflicts ? { value: conflicts, tooltip: `${conflicts} unresolved conflict${conflicts > 1 ? "s" : ""}` } : undefined;
    this.view.message = this.ws.configError ? `rung.toml: ${this.ws.configError}` : undefined;
    this.changed.fire(undefined);
    void this.sniff(objects);
  }

  /** Reads the first bytes of block files to tell FB/FC/OB/DB apart (state.json does not store it). */
  private sniff(objects: ObjectInfo[]): Promise<void> {
    if (this.sniffing || !this.ws.root) return this.sniffing ?? Promise.resolve();
    const root = this.ws.root;
    const todo = objects.filter((o) => o.kind === "block" && SNIFF_FORMS.has(o.form));
    this.sniffing = (async () => {
      let changed = false;
      const queue = [...todo];
      const worker = async () => {
        for (let o = queue.pop(); o; o = queue.pop()) {
          const file = join(root, o.path);
          let fh;
          try {
            fh = await open(file, "r");
            const st = await fh.stat();
            const cached = this.types.get(o.path);
            if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) continue;
            const buf = Buffer.alloc(Math.min(SNIFF_BYTES, st.size));
            await fh.read(buf, 0, buf.length, 0);
            const type = detectBlockType(o.form, buf.toString("utf8"));
            if (cached?.type !== type) changed = true;
            this.types.set(o.path, { size: st.size, mtime: st.mtimeMs, type });
          } catch {
            /* file missing: leave the generic icon */
          } finally {
            await fh?.close();
          }
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      return changed;
    })().then(
      (changed) => {
        this.sniffing = undefined;
        if (changed) this.rebuild();
      },
      () => (this.sniffing = undefined),
    );
    return this.sniffing;
  }

  getTreeItem(e: ProjectItem): vscode.TreeItem {
    return e;
  }

  getChildren(e?: ProjectItem): ProjectItem[] {
    const root = this.ws.root;
    if (!root || !this.ws.hasConfig) return [];
    const nodes = e ? (e.node.type === "object" ? [] : e.node.children) : this.roots;
    return nodes.map((n) => new ProjectItem(n, root));
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}

/** Badges in the Explorer and the project view: ! conflict, R read-only, D delete pending. */
export class ObjectDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private byPath = new Map<string, ObjectInfo>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly ws: RungWorkspace) {
    // the workspace is already loaded when this is created: take its objects now, not only on the next change
    this.byPath = new Map(ws.objects.map((o) => [o.path, o]));
    this.subs.push(
      vscode.window.registerFileDecorationProvider(this),
      ws.onDidChange(() => {
        this.byPath = new Map(ws.objects.map((o) => [o.path, o]));
        this.changed.fire(undefined);
      }),
    );
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return undefined;
    const rel = this.ws.rel(uri.fsPath);
    const o = rel ? this.byPath.get(rel) : undefined;
    if (!o) return undefined;
    if (o.flag === "conflict") return new vscode.FileDecoration("!", "rung: unresolved conflict", new vscode.ThemeColor("list.errorForeground"));
    if (o.flag === "recovery") return new vscode.FileDecoration("!", "rung: needs recovery", new vscode.ThemeColor("list.errorForeground"));
    if (o.flag === "pendingDelete") return new vscode.FileDecoration("D", "rung: deleted in TIA Portal, waiting for confirm-delete", new vscode.ThemeColor("list.warningForeground"));
    if (o.readOnly) return new vscode.FileDecoration("R", "rung: read-only (protected, F- or GRAPH block)");
    return undefined;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}
