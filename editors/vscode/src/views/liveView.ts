// SPDX-License-Identifier: MIT
// Live Values: values pinned from the PLC (its Web API, or rung simulate), read twice a second while the view is
// visible, each with its age and a short history (`rung live watch <names> --json`, read-only). For commissioning:
// the handful of values that matter, side by side, wherever they live.
import { spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import { sparkline } from "../core/sparkline";
import type { RungCli } from "../runner/cli";
import { killTree } from "../runner/terminal";
import type { RungWorkspace } from "../workspace";

interface Seen {
  value?: unknown;
  error?: string;
  at: number;
  history: unknown[];
}

const KEY = "rung.liveValues";
const INTERVAL = 500;
const shown = (v: unknown) => (typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "string" ? `'${v}'` : JSON.stringify(v));

export class LiveView implements vscode.TreeDataProvider<string>, vscode.Disposable {
  private names: string[];
  readonly seen = new Map<string, Seen>();
  private proc?: ChildProcess;
  private paused = false;
  private retry?: NodeJS.Timeout;
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<string>;
  private readonly timer: NodeJS.Timeout;
  private readonly subs: vscode.Disposable[] = [this.changed];

  constructor(
    private readonly ws: RungWorkspace,
    private readonly cli: RungCli,
    private readonly memento: vscode.Memento,
  ) {
    this.names = memento.get<string[]>(KEY, []);
    this.view = vscode.window.createTreeView("rung.live", { treeDataProvider: this });
    this.subs.push(
      this.view,
      // read only while someone looks: no PLC traffic for a hidden view
      this.view.onDidChangeVisibility(() => this.restart()),
      vscode.commands.registerCommand("rung.live.add", (arg?: unknown) => this.add(typeof arg === "string" ? arg : undefined)),
      vscode.commands.registerCommand("rung.live.remove", (name: string) => this.remove(name)),
      vscode.commands.registerCommand("rung.live.clear", () => this.set([])),
      vscode.commands.registerCommand("rung.live.pause", () => this.pause(true)),
      vscode.commands.registerCommand("rung.live.resume", () => this.pause(false)),
    );
    // ages go on while values come in (or stop coming)
    this.timer = setInterval(() => this.view.visible && this.names.length && this.changed.fire(undefined), 1000);
    void vscode.commands.executeCommand("setContext", "rung.live.paused", false);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.stop();
    for (const s of this.subs) s.dispose();
  }

  /** The pinned names (tests). */
  get pinned(): readonly string[] {
    return this.names;
  }

  private set(names: string[]) {
    this.names = names;
    void this.memento.update(KEY, names);
    for (const k of [...this.seen.keys()]) if (!names.includes(k)) this.seen.delete(k);
    this.changed.fire(undefined);
    this.restart();
  }

  async add(name?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : undefined;
    const typed =
      name ??
      (await vscode.window.showInputBox({
        title: "Pin a value from the PLC",
        prompt: 'A PLC tag or a DB member, as TIA Portal writes it: "Line_DB".Speed, "Start_PB"',
        value: selected ?? "",
        validateInput: (v) => (/^#/.test(v.trim()) ? "A block's local (#name) lives in an instance: write it through its DB, \"Motor_DB\".name" : undefined),
      }));
    const n = typed?.trim();
    if (!n || this.names.includes(n)) return;
    this.set([...this.names, n]);
  }

  private remove(name: string) {
    this.set(this.names.filter((n) => n !== name));
  }

  private pause(on: boolean) {
    this.paused = on;
    void vscode.commands.executeCommand("setContext", "rung.live.paused", on);
    this.restart();
  }

  private stop() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    // through the rung.cmd shim the watch is a child of cmd.exe: end the whole tree
    if (this.proc) killTree(this.proc);
    this.proc = undefined;
  }

  private restart() {
    this.stop();
    if (this.paused || !this.view.visible || !this.names.length || !this.ws.root) return;
    const inv = this.cli.invocation(["live", "watch", ...this.names, "--json", "--interval", String(INTERVAL)]);
    const proc = spawn(inv.file, inv.args, { cwd: this.ws.root, windowsVerbatimArguments: inv.shell, windowsHide: true });
    this.proc = proc;
    let buf = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.take(line);
      }
    });
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      if (code) this.view.message = `${err.trim().split(/\r?\n/).pop()?.replace(/^rung live:\s*/, "") || `rung live watch ended (${code})`} (trying again)`;
      // the PLC may come back (switched on, network back): try again while someone looks
      this.retry = setTimeout(() => this.restart(), 5000);
    });
    this.view.message = undefined;
  }

  private take(line: string) {
    let m: { at?: number; values?: Record<string, unknown>; errors?: Record<string, string> };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.at === undefined) return; // the plan line
    for (const n of this.names) {
      const s = this.seen.get(n) ?? { at: 0, history: [] };
      if (m.errors?.[n]) s.error = m.errors[n];
      else if (m.values && n in m.values) {
        s.error = undefined;
        s.value = m.values[n];
        s.history.push(s.value);
        if (s.history.length > 32) s.history.shift();
      }
      s.at = m.at;
      this.seen.set(n, s);
    }
    this.changed.fire(undefined);
  }

  getChildren(): string[] {
    return this.names;
  }

  getTreeItem(name: string): vscode.TreeItem {
    const s = this.seen.get(name);
    const item = new vscode.TreeItem(name);
    item.contextValue = "rung.liveValue";
    if (!s) {
      item.description = this.paused ? "paused" : "…";
      item.iconPath = new vscode.ThemeIcon("circle-outline");
      return item;
    }
    const age = Date.now() - s.at;
    const stale = age > INTERVAL * 4;
    if (s.error) {
      item.description = s.error;
      item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
    } else {
      const line = sparkline(s.history);
      item.description = `${shown(s.value)}${line ? `  ${line}` : ""}${stale ? `  · ${Math.round(age / 1000)} s old` : ""}`;
      item.iconPath = new vscode.ThemeIcon(stale ? "circle-outline" : "circle-filled", stale ? undefined : new vscode.ThemeColor("charts.green"));
    }
    item.tooltip = `${name}\nread ${new Date(s.at).toLocaleTimeString(undefined, { hour12: false })}${s.history.length > 1 ? `\nlast values: ${s.history.slice(-10).map(shown).join(", ")}` : ""}`;
    return item;
  }
}
