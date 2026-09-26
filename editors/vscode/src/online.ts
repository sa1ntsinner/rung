// SPDX-License-Identifier: MIT
// Online state per PLC from `rung online --state`. Refreshed on demand and after PLC actions; the optional
// interval (rung.online.refreshInterval) only runs while rung watch is up, so it never starts extra
// TIA Portal sessions in the background.
import * as vscode from "vscode";
import { Args, parseOnlineState } from "./core/args";
import type { RungCli } from "./runner/cli";
import { readSettings } from "./settings";
import type { RungWorkspace } from "./workspace";

export interface OnlineInfo {
  state?: string;
  checking: boolean;
  error?: string;
  at?: number;
}

export class OnlineMonitor implements vscode.Disposable {
  private readonly states = new Map<string, OnlineInfo>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private timer: NodeJS.Timeout | undefined;
  private timerSecs = 0;
  private running: Promise<void> | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly ws: RungWorkspace,
    private readonly cli: RungCli,
  ) {
    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("rung.online.refreshInterval")) this.schedule();
      }),
      ws.onDidChange(() => this.schedule()),
    );
  }

  get(device: string): OnlineInfo {
    return this.states.get(device) ?? { checking: false };
  }

  /** Devices currently "Online". */
  online(): string[] {
    return [...this.states].filter(([, s]) => s.state === "Online").map(([d]) => d);
  }

  set(device: string, info: OnlineInfo): void {
    this.states.set(device, info);
    this.changed.fire();
  }

  /** Checks one PLC or all; concurrent calls share the running check. */
  refresh(device?: string): Promise<void> {
    if (!this.ws.hasConfig) return Promise.resolve();
    if (this.running) return this.running;
    const devices = device ? [device] : this.ws.devices();
    this.running = (async () => {
      for (const d of devices) {
        this.set(d, { ...this.get(d), checking: true });
        const r = await this.cli.capture(Args.onlineState(d), { timeoutMs: 120_000, quiet: true });
        const parsed = r.code === 0 ? parseOnlineState(r.output) : undefined;
        this.set(d, parsed ? { state: parsed.state, checking: false, at: Date.now() } : { checking: false, error: r.error?.message ?? (r.output.trim().split(/\r?\n/).pop() || `exit code ${r.code}`), at: Date.now() });
      }
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  private schedule(): void {
    const secs = readSettings().onlineRefresh;
    const want = secs > 0 && this.ws.hasConfig && this.ws.watching;
    if (this.timer && (!want || secs !== this.timerSecs)) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (!want || this.timer) return;
    this.timerSecs = secs;
    this.timer = setInterval(() => void this.refresh(), secs * 1000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}
