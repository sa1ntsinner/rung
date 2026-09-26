// SPDX-License-Identifier: MIT
// "PLC" view: rung watch, then each PLC with its online state and actions.
import * as vscode from "vscode";
import type { OnlineMonitor } from "../online";
import type { WatchController } from "../runner/watch";
import type { RungWorkspace } from "../workspace";

type Node =
  | { type: "watch" }
  | { type: "plc"; device: string }
  | { type: "connection"; device: string }
  | { type: "action"; device: string; label: string; command: string; icon: string; tooltip: string };

const ACTIONS: readonly Omit<Extract<Node, { type: "action" }>, "type" | "device">[] = [
  { label: "Go online", command: "rung.goOnline", icon: "plug", tooltip: "rung online: connect TIA Portal to this PLC" },
  { label: "Go offline", command: "rung.goOffline", icon: "debug-disconnect", tooltip: "rung online --off" },
  { label: "Compile PLC", command: "rung.compilePlc", icon: "tools", tooltip: "rung compile: compile the software in TIA Portal" },
  { label: "Compile hardware", command: "rung.compileHardware", icon: "circuit-board", tooltip: "rung compile --hw" },
  { label: "Interfaces…", command: "rung.interfaces", icon: "radio-tower", tooltip: "rung interfaces --scan: PG/PC interfaces and reachable devices; can write [plc.X] into rung.toml" },
  { label: "Download…", command: "rung.download", icon: "desktop-download", tooltip: "rung download: asks for confirmation first" },
];

const STATE_ICON: Readonly<Record<string, [string, string | undefined]>> = {
  Online: ["pass-filled", "testing.iconPassed"],
  Offline: ["circle-large-outline", undefined],
  Connecting: ["sync~spin", undefined],
  Disconnecting: ["sync~spin", undefined],
  NotReachable: ["error", "list.errorForeground"],
  Incompatible: ["warning", "list.warningForeground"],
  Protected: ["lock", "list.warningForeground"],
};

export class PlcItem extends vscode.TreeItem {
  constructor(
    readonly node: Node,
    label: string,
    state: vscode.TreeItemCollapsibleState,
  ) {
    super(label, state);
  }
  /** PLC name for commands invoked from this item's context menu. */
  get device(): string | undefined {
    return "device" in this.node ? this.node.device : undefined;
  }
}

export class PlcView implements vscode.TreeDataProvider<PlcItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<PlcItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<PlcItem>;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly ws: RungWorkspace,
    private readonly online: OnlineMonitor,
    private readonly watch: WatchController,
  ) {
    this.view = vscode.window.createTreeView("rung.plc", { treeDataProvider: this });
    const fire = () => this.changed.fire(undefined);
    this.subs.push(this.view, ws.onDidChange(fire), online.onDidChange(fire), watch.onDidChange(fire));
  }

  getTreeItem(e: PlcItem): vscode.TreeItem {
    return e;
  }

  getChildren(e?: PlcItem): PlcItem[] {
    if (!this.ws.hasConfig) return [];
    if (!e) return [this.watchItem(), ...this.ws.devices().map((d) => this.plcItem(d))];
    if (e.node.type === "plc") {
      const d = e.node.device;
      return [this.connectionItem(d), ...ACTIONS.map((a) => this.actionItem({ type: "action", device: d, ...a }))];
    }
    return [];
  }

  private watchItem(): PlcItem {
    const status = this.watch.status;
    const pid = this.ws.owner?.pid;
    const text: Record<typeof status, string> = {
      running: this.watch.owned ? "running" : `running outside VS Code (pid ${pid})`,
      starting: "starting…",
      stopping: "stopping…",
      stopped: "not running",
    };
    const it = new PlcItem({ type: "watch" }, "rung watch", vscode.TreeItemCollapsibleState.None);
    it.id = "watch";
    it.description = text[status];
    it.iconPath = new vscode.ThemeIcon(status === "running" ? "eye" : status === "stopped" ? "eye-closed" : "sync~spin", status === "running" ? new vscode.ThemeColor("testing.iconPassed") : undefined);
    it.contextValue = status === "running" || status === "starting" ? "rung.watch.running" : "rung.watch.stopped";
    it.tooltip =
      status === "running"
        ? "rung watch keeps files and TIA Portal in sync and runs other rung commands through its TIA session."
        : "Start rung watch to keep files and TIA Portal in sync (two-way).";
    // start/stop are inline buttons; a click only brings up the watch terminal
    if (this.watch.owned) it.command = { command: "rung.watch.show", title: "Show watch terminal" };
    return it;
  }

  private plcItem(device: string): PlcItem {
    const it = new PlcItem({ type: "plc", device }, device, vscode.TreeItemCollapsibleState.Expanded);
    it.id = `plc:${device}`;
    const s = this.online.get(device);
    const [icon, color] = s.checking ? ["sync~spin", undefined] : s.state ? STATE_ICON[s.state] ?? ["question", undefined] : s.error ? ["warning", "list.warningForeground"] : ["circle-large-outline", undefined];
    it.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    it.description = s.checking ? "checking…" : s.state ? s.state : s.error ? "state unknown" : "state not checked";
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${device}**  \n`);
    md.appendMarkdown(s.state ? `online state: ${s.state}` : s.error ? `last check failed: ${s.error}` : "online state not checked yet (refresh button in the view title)");
    if (s.at) md.appendMarkdown(`  \nchecked ${new Date(s.at).toLocaleTimeString()}`);
    it.tooltip = md;
    it.contextValue = `rung.plc${s.state === "Online" ? " online" : ""}`;
    return it;
  }

  private connectionItem(device: string): PlcItem {
    const c = this.ws.config?.plc[device];
    const it = new PlcItem({ type: "connection", device }, c ? c.pcInterface : "No connection configured", vscode.TreeItemCollapsibleState.None);
    it.id = `conn:${device}`;
    it.iconPath = new vscode.ThemeIcon(c ? "link" : "warning", c ? undefined : new vscode.ThemeColor("list.warningForeground"));
    it.description = c ? [c.mode, c.targetInterface].filter(Boolean).join(" · ") : "run Interfaces…";
    it.tooltip = c
      ? `[plc.${device}] in rung.toml\nmode = ${c.mode}\npc_interface = ${c.pcInterface} (number ${c.pcInterfaceNumber})${c.targetInterface ? `\ntarget_interface = ${c.targetInterface}` : ""}`
      : `Online and download need [plc.${device}] in rung.toml. Interfaces… lists the options and can write it for you.`;
    it.command = c ? { command: "rung.openConfig", title: "Open rung.toml" } : { command: "rung.interfaces", title: "Interfaces…", arguments: [device] };
    it.contextValue = "rung.connection";
    return it;
  }

  private actionItem(n: Extract<Node, { type: "action" }>): PlcItem {
    const it = new PlcItem(n, n.label, vscode.TreeItemCollapsibleState.None);
    it.id = `act:${n.device}:${n.command}`;
    it.iconPath = new vscode.ThemeIcon(n.icon);
    it.tooltip = n.tooltip;
    it.command = { command: n.command, title: n.label, arguments: [n.device] };
    it.contextValue = "rung.action";
    return it;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}
