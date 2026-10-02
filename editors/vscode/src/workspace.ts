// SPDX-License-Identifier: MIT
// The rung workspace in the open folder: rung.toml, .rung/state.json and .rung/owner.json (all read-only
// here). Fires onDidChange when any of them changes and keeps the when-clause context keys up to date.
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import * as vscode from "vscode";
import { lastBackupOf, parseRungToml, writesState, type RungToml } from "./core/rungToml";
import { devicesInState, objectsOf, parseState, summarize, type ObjectInfo, type StateDoc } from "./core/state";
import type { Output } from "./output";

export interface OwnerInfo {
  pid: number;
  startedAt?: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export class RungWorkspace implements vscode.Disposable {
  /** Folder with rung.toml, else the first workspace folder. */
  root: string | undefined;
  hasConfig = false;
  config: RungToml | undefined;
  configError: string | undefined;
  state: StateDoc | undefined;
  objects: ObjectInfo[] = [];
  owner: OwnerInfo | undefined;
  /** may rung write into the project from here (rung writes on; .rung/writes.json) */
  writes: "on" | "off" | "manual" = "manual";
  /** the archive rung had TIA Portal make before its first write of the day (.rung/backups.json) */
  lastBackup: { at: number; path: string } | undefined;

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private ownerTimer: NodeJS.Timeout | undefined;

  constructor(private readonly out: Output) {
    this.subs.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.locate()));
  }

  async start(): Promise<void> {
    await this.locate();
  }

  private async locate(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const withToml = folders.find((f) => f.uri.scheme === "file" && isFile(join(f.uri.fsPath, "rung.toml")));
    const root = (withToml ?? folders.find((f) => f.uri.scheme === "file"))?.uri.fsPath;
    if (root !== this.root || !this.watcher) {
      this.root = root;
      this.watcher?.dispose();
      this.watcher = undefined;
      if (root) {
        this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "{rung.toml,.rung/state.json,.rung/owner.json,.rung/writes.json,.rung/backups.json}"));
        const poke = () => this.scheduleReload();
        this.watcher.onDidChange(poke);
        this.watcher.onDidCreate(poke);
        this.watcher.onDidDelete(poke);
      }
    }
    await this.reload();
  }

  /** Coalesces bursts of file events (state.json is rewritten atomically on every pass). */
  scheduleReload(delayMs = 250): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reload(), delayMs);
  }

  async reload(): Promise<void> {
    this.timer = undefined;
    const root = this.root;
    this.hasConfig = !!root && isFile(join(root, "rung.toml"));
    this.config = undefined;
    this.configError = undefined;
    if (root && this.hasConfig) {
      try {
        this.config = parseRungToml(await readFile(join(root, "rung.toml"), "utf8"));
      } catch (e) {
        this.configError = (e as Error).message;
      }
    }
    this.state = root ? parseState(await readFile(join(root, ".rung", "state.json"), "utf8").catch(() => "")) : undefined;
    this.lastBackup = root ? lastBackupOf(await readFile(join(root, ".rung", "backups.json"), "utf8").catch(() => "")) : undefined;
    this.writes = writesState(this.config, root ? await readFile(join(root, ".rung", "writes.json"), "utf8").catch(() => "") : "");
    this.objects = objectsOf(this.state);
    this.readOwner();
    this.out.debug(`workspace: ${root ?? "(none)"}, rung.toml ${this.hasConfig ? "found" : "missing"}, ${this.objects.length} objects, watch ${this.owner ? `pid ${this.owner.pid}` : "not running"}`);
    await this.updateContext();
    this.changed.fire();
  }

  private readOwner(): void {
    this.owner = undefined;
    if (!this.root) return;
    try {
      const info = JSON.parse(readFileSync(join(this.root, ".rung", "owner.json"), "utf8")) as { pid?: unknown; startedAt?: unknown };
      if (typeof info.pid === "number" && alive(info.pid)) this.owner = { pid: info.pid, ...(typeof info.startedAt === "number" ? { startedAt: info.startedAt } : {}) };
    } catch {
      /* no owner */
    }
    // owner.json stays behind when watch exits: notice the process going away.
    if (this.owner && !this.ownerTimer) {
      this.ownerTimer = setInterval(() => {
        if (!this.owner || !alive(this.owner.pid)) {
          clearInterval(this.ownerTimer);
          this.ownerTimer = undefined;
          void this.reload();
        }
      }, 3000);
    }
  }

  get watching(): boolean {
    return !!this.owner;
  }

  get conflicts(): string[] {
    return summarize(this.objects).conflicts;
  }

  /** PLCs of this workspace: rung.toml devices, else [plc.*] tables and devices seen in state.json. */
  devices(): string[] {
    const c = this.config;
    if (c?.devices.length) return c.devices;
    const set = new Set<string>([...Object.keys(c?.plc ?? {}), ...devicesInState(this.state)]);
    return set.size ? [...set] : ["PLC_1"];
  }

  /** Workspace-relative POSIX path, or undefined outside the workspace. */
  rel(fsPath: string): string | undefined {
    if (!this.root) return undefined;
    const r = relative(this.root, fsPath);
    if (!r || r.startsWith("..") || /^[a-zA-Z]:/.test(r)) return undefined;
    return r.split(sep).join("/");
  }

  objectAt(fsPath: string): ObjectInfo | undefined {
    const r = this.rel(fsPath)?.replace(/\.(conflict|tia)$/, "");
    if (!r) return undefined;
    return this.objects.find((o) => o.path === r) ?? this.objects.find((o) => r.startsWith(o.path.replace(/\.[^./]+$/, "") + "."));
  }

  private async updateContext(): Promise<void> {
    const set = (k: string, v: unknown) => vscode.commands.executeCommand("setContext", k, v);
    await Promise.all([
      set("rung.workspace", this.hasConfig),
      set("rung.hasConflicts", this.conflicts.length > 0),
      set("rung.hasObjects", this.objects.length > 0),
    ]);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.ownerTimer) clearInterval(this.ownerTimer);
    this.watcher?.dispose();
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}
