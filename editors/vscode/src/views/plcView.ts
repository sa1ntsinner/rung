// SPDX-License-Identifier: MIT
// "PLC" view: rung watch, writes, then one row per PLC with its online state; its actions are the row's inline
// buttons and context menu.
import * as vscode from "vscode";
import type { OnlineMonitor } from "../online";
import type { WatchController } from "../runner/watch";
import type { RungWorkspace } from "../workspace";

type Node =
  | { type: "watch" }
  | { type: "writes" }
  | { type: "plc"; device: string }
  | { type: "connection"; device: string };


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
    if (!e) return [this.watchItem(), this.writesItem(), ...this.ws.devices().map((d) => this.plcItem(d))];
    if (e.node.type === "plc") {
      const d = e.node.device;
      // the actions are the row's inline buttons and context menu (and the rung quick pick), not rows of their own
      return [this.connectionItem(d)];
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
    it.iconPath = new vscode.ThemeIcon(status === "running" ? "sync" : status === "stopped" ? "circle-slash" : "sync~spin", status === "running" ? new vscode.ThemeColor("testing.iconPassed") : undefined);
    it.contextValue = status === "running" || status === "starting" ? "rung.watch.running" : "rung.watch.stopped";
    it.tooltip =
      status === "running"
        ? "rung watch keeps files and TIA Portal in sync and runs other rung commands through its TIA session."
        : "Start rung watch to keep files and TIA Portal in sync (two-way).";
    // start/stop are inline buttons; a click only brings up the watch terminal
    if (this.watch.owned) it.command = { command: "rung.watch.show", title: "Show watch terminal" };
    return it;
  }

  private writesItem(): PlcItem {
    const w = this.ws.writes;
    const it = new PlcItem({ type: "writes" }, "Writes to TIA Portal", vscode.TreeItemCollapsibleState.None);
    it.id = "writes";
    it.description = w === "on" ? "on" : w === "off" ? "off · click to turn on" : "off (sync.import = manual)";
    it.iconPath = new vscode.ThemeIcon(w === "on" ? "unlock" : "lock", w === "on" ? undefined : new vscode.ThemeColor("list.warningForeground"));
    it.tooltip =
      w === "on"
        ? "Your edits go to TIA Portal: rung imports them, compiles them and writes TIA Portal's version back. Click to stop that (rung writes off)."
        : w === "off"
          ? "rung brings TIA Portal's changes into the files, but your edits stay in the files. Click to let rung send them to the project (rung writes on)."
          : 'rung.toml has sync.import = "manual": no copy of this workspace writes into the project.';
    if (w !== "manual") it.command = { command: w === "on" ? "rung.writes.off" : "rung.writes.on", title: w === "on" ? "Turn off writes" : "Turn on writes" };
    it.contextValue = `rung.writes.${w}`;
    const b = this.ws.lastBackup;
    if (w === "on" && b) {
      const at = new Date(b.at);
      it.description = `on · archived ${at.toDateString() === new Date().toDateString() ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : at.toLocaleDateString()}`;
      it.tooltip += `\n\nBefore its first write of each day rung has TIA Portal archive the project. Last: ${b.path} (TIA Portal's Project → Retrieve opens it).`;
    }
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
    const it = new PlcItem({ type: "connection", device }, c ? c.pcInterface : "Connection: found when going online", vscode.TreeItemCollapsibleState.None);
    it.id = `conn:${device}`;
    it.iconPath = new vscode.ThemeIcon(c ? "link" : "search");
    it.description = c ? [c.mode, c.targetInterface].filter(Boolean).join(" · ") : "or click to choose";
    it.tooltip = c
      ? `[plc.${device}] in rung.toml\nmode = ${c.mode}\npc_interface = ${c.pcInterface} (number ${c.pcInterfaceNumber})${c.targetInterface ? `\ntarget_interface = ${c.targetInterface}` : ""}\n\nClick to choose another connection.`
      : `No [plc.${device}] in rung.toml yet. Go online (or download) finds ${device} on the network by its project address and saves the connection; click to look now and choose.`;
    it.command = { command: "rung.connect", title: "Connect…", arguments: [device] };
    it.contextValue = c ? "rung.connection" : "rung.connection.none";
    return it;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}
