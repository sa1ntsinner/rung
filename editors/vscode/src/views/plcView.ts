// SPDX-License-Identifier: MIT
// "PLC" view: rung watch, writes, then one row per PLC with its online state; its actions are the row's inline
// buttons and context menu.
import * as vscode from "vscode";
import type { OnlineMonitor } from "../online";
import type { WatchController } from "../runner/watch";
import type { RungWorkspace } from "../workspace";
import type { RungCli } from "../runner/cli";
import type { LiveAccess } from "../liveAccess";
import { stopLive, startProcess } from "../runner/terminal";
import type { ChildProcess } from "node:child_process";

type Node =
  | { type: "watch" }
  | { type: "writes" }
  | { type: "plc"; device: string }
  | { type: "connection"; device: string }
  | { type: "state" | "alarms"; device: string }
  | { type: "detail"; device: string; text: string };


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
  private readonly alarmJobs = new Map<string, ChildProcess>();
  private readonly alarmOpening = new Set<string>();
  private readonly alarmExpanded = new Set<string>();
  private readonly alarmRows = new Map<string, { alarms: { id: string; active: boolean; text: string; cpuTimestamp?: string; receivedAt: number }[]; connectionState?: string; scope: { address: string } }>();
  private readonly alarmErrors = new Map<string, string>();
  private generation = 0;

  constructor(
    private readonly ws: RungWorkspace,
    private readonly online: OnlineMonitor,
    private readonly watch: WatchController,
    private readonly cli?: RungCli,
    private readonly access?: LiveAccess,
  ) {
    this.view = vscode.window.createTreeView("rung.plc", { treeDataProvider: this });
    const fire = () => this.changed.fire(undefined);
    this.subs.push(this.view, ws.onDidChange(fire), online.onDidChange(fire), watch.onDidChange(fire));
    if (cli && access) {
      let workspace = access.scope;
      this.subs.push(ws.onDidChange(() => { if (workspace !== access.scope) { workspace = access.scope; this.stopAlarms(); this.alarmRows.clear(); this.alarmErrors.clear(); fire(); } }),
        this.view.onDidChangeVisibility(() => { if (!this.view.visible) this.stopAlarms(); else fire(); }),
        online.onDidChange(() => { this.alarmErrors.clear(); fire(); }),
        this.view.onDidExpandElement(({ element }) => { if (element.node.type === "alarms") { this.alarmExpanded.add(element.node.device); void this.startAlarms(element.node.device); } }),
        this.view.onDidCollapseElement(({ element }) => { if (element.node.type === "alarms") { this.alarmExpanded.delete(element.node.device); const child = this.alarmJobs.get(element.node.device); if (child) stopLive(child); this.alarmJobs.delete(element.node.device); } }));
    }
  }

  getTreeItem(e: PlcItem): vscode.TreeItem {
    return e;
  }

  getChildren(e?: PlcItem): PlcItem[] | Promise<PlcItem[]> {
    if (!this.ws.hasConfig) return [];
    if (!e) return [this.watchItem(), this.writesItem(), ...this.ws.devices().map((d) => this.plcItem(d))];
    if (e.node.type === "plc") {
      const d = e.node.device;
      // the actions are the row's inline buttons and context menu (and the rung quick pick), not rows of their own
      return [this.connectionItem(d), ...(this.cli && this.ws.config?.live?.plc[d]?.transport === "s7commplus" ? [
        new PlcItem({ type: "state", device: d }, "CPU diagnostics", vscode.TreeItemCollapsibleState.Collapsed),
        new PlcItem({ type: "alarms", device: d }, "PLC alarms", vscode.TreeItemCollapsibleState.Collapsed),
      ] : [])];
    }
    if (e.node.type === "state") return this.cpuDetails(e.node.device);
    if (e.node.type === "alarms") {
      const d = e.node.device; void this.startAlarms(d);
      const frame = this.alarmRows.get(d);
      if (!frame) return [this.detail(d, this.alarmErrors.get(d) ?? "Reading PLC alarms…")];
      // ponytail: tree shows 200 rows; the CLI JSON snapshot exposes the complete bounded set.
      const rows = frame.alarms.slice(0, 200).map(a => this.detail(d, `${a.active ? "ACTIVE" : "CLEARED"} ${a.id} · ${a.text}`, `CPU: ${a.cpuTimestamp ?? "unavailable"}\nReceived: ${new Date(a.receivedAt).toLocaleString()}\n${frame.scope.address} · ${frame.connectionState ?? "connected"}`));
      return [this.detail(d, `${frame.connectionState ?? "connected"} · ${frame.scope.address}`), ...(rows.length ? rows : [this.detail(d, "No active alarms")]), ...(frame.alarms.length > 200 ? [this.detail(d, `${frame.alarms.length - 200} more; use rung live alarms --json`)] : [])];
    }
    return [];
  }

  private detail(device: string, text: string, tooltip?: string): PlcItem {
    const item = new PlcItem({ type: "detail", device, text }, text, vscode.TreeItemCollapsibleState.None);
    item.tooltip = tooltip ?? text; return item;
  }
  private async cpuDetails(device: string): Promise<PlcItem[]> {
    const connection = await this.access?.select(device); if (!connection || !this.cli) return [];
    const env = await this.access!.environment(connection); if (!env) return [];
    const result = await this.cli.capture(["live", "state", "--device", device, "--json"], { env, quiet: true, timeoutMs: 30_000 });
    if (connection.workspace !== this.access!.scope) return [];
    try {
      if (result.code !== 0) throw new Error();
      const frame = JSON.parse(result.output) as { scope: { address: string }; identity: { plcName: string; cpu: string; serial: string }; state: { mode: string; cycleMs?: number; memory?: { name: string; usedBytes: number; totalBytes: number }[] } };
      return [this.detail(device, `${frame.state.mode} · ${frame.scope.address}`), this.detail(device, `${frame.identity.plcName} · ${frame.identity.cpu} · ${frame.identity.serial}`),
        this.detail(device, frame.state.cycleMs == null ? "Cycle unavailable" : `Cycle: ${frame.state.cycleMs} ms`),
        ...(frame.state.memory?.map(m => this.detail(device, `${m.name}: ${m.usedBytes}/${m.totalBytes} bytes`)) ?? [this.detail(device, "Memory unavailable")])];
    } catch { return [this.detail(device, "CPU diagnostics unavailable; see rung output")]; }
  }
  private async startAlarms(device: string): Promise<void> {
    if (!this.cli || !this.access || !this.view.visible || !this.alarmExpanded.has(device) || this.alarmJobs.has(device) || this.alarmOpening.has(device) || this.alarmErrors.has(device)) return;
    this.alarmOpening.add(device); const generation = this.generation;
    try {
      const connection = await this.access.select(device); if (!connection) return;
      const env = await this.access.environment(connection); if (!env || generation !== this.generation || !this.alarmExpanded.has(device) || connection.workspace !== this.access.scope || !this.view.visible) return;
      let partial = "";
      const { child, done } = startProcess(this.cli.invocation(["live", "alarms", "--device", device, "--stream", "--json", "--parent-stdio"]), this.ws.root, chunk => {
        if (generation !== this.generation) return;
        partial += chunk; if (partial.length > 2 * 1024 * 1024) { stopLive(child); return; }
        let end: number;
        while ((end = partial.indexOf("\n")) >= 0) {
          const line = partial.slice(0, end); partial = partial.slice(end + 1);
          try { const frame = JSON.parse(line); if (Array.isArray(frame.alarms) && frame.scope?.device === device) { this.alarmRows.set(device, frame); this.changed.fire(undefined); } } catch { }
        }
      }, env, true);
      this.alarmJobs.set(device, child);
      void done.then(result => { if (this.alarmJobs.get(device) !== child) return; this.alarmJobs.delete(device); this.alarmErrors.set(device, result.code ? "PLC alarms unavailable; see rung output" : "Alarm stream disconnected"); this.changed.fire(undefined); });
    } finally { this.alarmOpening.delete(device); }
  }
  private stopAlarms(): void { this.generation++; for (const child of this.alarmJobs.values()) stopLive(child); this.alarmJobs.clear(); }

  /** What rung watch waits for when only a person can go on (Openness access); undefined while it works. */
  private waiting: string | undefined;

  /** rung watch's events: a refusal that waits for the person shows on its row, a pass clears it. */
  listen(events: { onEvent: vscode.Event<{ event: string; params: unknown }> }): vscode.Disposable {
    return events.onEvent(({ event, params }) => {
      const p = params as { blocked?: boolean; code?: string; message?: string } | undefined;
      const next = event === "error" && p?.blocked ? (p.code === "ACCESS_DENIED" ? "Openness access" : (p.message ?? "you")) : event === "report" || event === "connected" || event === "disconnected" ? undefined : this.waiting;
      if (next !== this.waiting) {
        this.waiting = next;
        this.changed.fire(undefined);
      }
    });
  }

  private watchItem(): PlcItem {
    const status = this.watch.status;
    const pid = this.ws.owner?.pid;
    if (status === "running" && this.waiting) {
      const it = new PlcItem({ type: "watch" }, "rung watch", vscode.TreeItemCollapsibleState.None);
      it.id = "watch";
      it.description = `waiting for ${this.waiting}`;
      it.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
      it.contextValue = "rung.watch.running";
      it.tooltip = this.waiting === "Openness access" ? "rung's bridge is not registered with TIA Portal Openness. Register it once (rung setup openness, asks for administrator rights); watch then goes on." : `rung watch waits for ${this.waiting}.`;
      if (this.watch.owned) it.command = { command: "rung.watch.show", title: "Show watch terminal" };
      return it;
    }
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
      it.description = `on · backup ${at.toDateString() === new Date().toDateString() ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : at.toLocaleDateString([], { month: "short", day: "numeric" })}`;
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
    this.stopAlarms();
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}
