// SPDX-License-Identifier: BUSL-1.1
// rung watch: repeats syncOnce on file changes and on a poll timer, restarting the bridge with backoff.
import { watch, type FSWatcher } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RungConfig, StateStore } from "@rung/core";
import { BridgeError } from "@rung/bridge-client";
import { syncOnce, type SyncBridge, type SyncReport } from "./sync.js";

export interface ClosableBridge extends SyncBridge {
  close(): Promise<void>;
}

export interface WatcherOptions {
  config: RungConfig;
  /** Starts a new bridge process (called again after a crash). */
  bridgeFactory: () => Promise<ClosableBridge>;
  onReport?: (r: SyncReport) => void;
  onError?: (e: Error, retryInMs: number) => void;
  debounceMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

export class Watcher {
  private bridge: ClosableBridge | null = null;
  private fsWatcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private running: Promise<SyncReport | null> | null = null;
  private queued: Promise<SyncReport | null> | null = null;
  private stopped = false;
  private failures = 0;
  private retryAt = 0;
  lastReport: SyncReport | null = null;
  lastPassAt = 0;
  lastError: string | null = null;

  constructor(
    private readonly root: string,
    private readonly state: StateStore,
    private readonly opts: WatcherOptions,
  ) {}

  start(): void {
    const plc = join(this.root, "plc");
    mkdirSync(plc, { recursive: true });
    this.fsWatcher = watch(plc, { recursive: true }, (_event, file) => {
      if (file && /(^|[\\/])\./.test(String(file))) return; // our own temp files
      this.poke();
    });
    this.timer = setInterval(() => void this.syncNow().catch(() => {}), this.opts.config.sync.pollMs);
    void this.syncNow().catch(() => {});
  }

  /** Debounced trigger for file events. */
  poke(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncNow().catch(() => {}), this.opts.debounceMs ?? 300);
  }

  /**
   * Runs a pass now, or right after the current one. At most one pass runs and one waits;
   * callers arriving while one waits join it (events coalesce).
   */
  syncNow(): Promise<SyncReport | null> {
    if (this.stopped) return Promise.resolve(null);
    if (this.queued) return this.queued;
    const prev = this.running ?? Promise.resolve(null);
    const next = prev
      .catch(() => null)
      .then(async () => {
        this.queued = null;
        const run = this.pass();
        this.running = run;
        try {
          return await run;
        } finally {
          if (this.running === run) this.running = null;
        }
      });
    this.queued = next;
    return next;
  }

  private async pass(): Promise<SyncReport | null> {
    const now = (this.opts.now ?? Date.now)();
    if (now < this.retryAt) return null;
    try {
      this.bridge ??= await this.opts.bridgeFactory();
      const r = await syncOnce(this.root, this.bridge, this.state, { config: this.opts.config });
      this.failures = 0;
      this.lastReport = r;
      this.lastPassAt = now;
      this.lastError = null;
      this.opts.onReport?.(r);
      return r;
    } catch (e) {
      const err = e as Error;
      this.lastError = err.message;
      // Bridge-level trouble: drop the bridge and retry with exponential backoff; the workspace stays safe.
      if (!(e instanceof BridgeError) || ["BRIDGE_EXITED", "PORTAL_DISPOSED", "TIMEOUT", "TIA_NOT_RUNNING", "NO_PROJECT"].includes(e.code)) {
        await this.bridge?.close().catch(() => {});
        this.bridge = null;
      }
      this.failures++;
      const wait = Math.min(1000 * 2 ** (this.failures - 1), this.opts.maxBackoffMs ?? 30_000);
      this.retryAt = now + wait;
      this.opts.onError?.(err, wait);
      return null;
    }
  }

  get bridgeForTools(): ClosableBridge | null {
    return this.bridge;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.fsWatcher?.close();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    await this.running;
    await this.bridge?.close().catch(() => {});
    this.bridge = null;
  }
}
