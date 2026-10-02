// SPDX-License-Identifier: BUSL-1.1
// rung watch: a quick pass for the files that changed, a complete pass on a poll timer, restarting the bridge with backoff.
import { watch, type FSWatcher } from "node:fs";
import { mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import type { RungConfig, StateStore } from "@rung/core";
import { BridgeError } from "@rung/bridge-client";
import { syncOnce, syncQuick, type Refusal, type SyncBridge, type SyncOptions, type SyncReport } from "./sync.js";

export interface ClosableBridge extends SyncBridge {
  close(): Promise<void>;
}

export interface WatcherOptions {
  config: RungConfig;
  /** The configuration as it is now (rung.toml and the write right), read before every pass: rung writes off applies at once. */
  reloadConfig?: () => Promise<RungConfig>;
  /** Starts a new bridge process (called again after a crash). */
  bridgeFactory: () => Promise<ClosableBridge>;
  onReport?: (r: SyncReport) => void;
  onError?: (e: Error, retryInMs: number) => void;
  /** What a pass is doing now (SyncOptions.onPhase). */
  onPhase?: SyncOptions["onPhase"];
  validateTags?: SyncOptions["validateTags"];
  debounceMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

/** rung watch checks watch and force tables again (an export each) at most this often; file edits go at once. */
const UNVERSIONED_MS = 60_000;

/**
 * A quick pass's report seen with the last complete one: its own objects as it found them, everything else (a
 * conflict elsewhere, a pending delete) as the complete pass left it. The counts are the quick pass's.
 */
function mergeQuick(last: SyncReport | null, quick: SyncReport): SyncReport {
  if (!last) return quick;
  const mine = new Set(quick.objects ?? []);
  return {
    ...quick,
    conflicts: last.conflicts,
    pendingDeletes: last.pendingDeletes,
    warnings: [...last.warnings.filter((w) => !mine.has(w.address)), ...quick.warnings],
    diagnostics: [...last.diagnostics.filter((d) => !mine.has(d.address) && !quick.diagnostics.some((q) => !q.path && q.address === d.address && q.code === d.code)), ...quick.diagnostics],
    objects: undefined,
  };
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
  /** Workspace-relative files changed since the last pass (file events). */
  private readonly dirty = new Set<string>();
  /** The next pass looks at everything: the first one, a poll tick, rung sync, a conflict resolved, after an error. */
  private wantFull = true;
  lastReport: SyncReport | null = null;
  lastPassAt = 0;
  /** How long the last complete pass took; idle polling waits at least twice as long. */
  lastPassMs = 0;
  private lastPassEnd = 0;
  lastError: string | null = null;
  /** Imports TIA Portal refused: not sent again every poll (SyncOptions.refused). */
  private readonly refused = new Map<string, Refusal>();

  private config: RungConfig;

  constructor(
    private readonly root: string,
    private readonly state: StateStore,
    private readonly opts: WatcherOptions,
  ) {
    this.config = opts.config;
  }

  start(): void {
    const plc = join(this.root, "plc");
    mkdirSync(plc, { recursive: true });
    this.fsWatcher = watch(plc, { recursive: true }, (_event, file) => {
      if (!file) return this.poke(); // the platform did not say which: look at everything
      if (/(^|[\\/])\./.test(String(file))) return; // our own temp files
      this.poke("plc/" + String(file).split(sep).join("/"));
    });
    this.timer = setInterval(() => this.tick(), this.opts.config.sync.pollMs);
    void this.syncNow().catch(() => {});
  }

  /**
   * Poll tick: a complete pass. Unlike file events it never queues behind a running pass, and it keeps the watcher
   * idle at least twice as long as the last complete pass took: a large project costs at most a third of TIA Portal's
   * time, which the engineer is working in meanwhile.
   */
  tick(): void {
    if (this.running || this.queued) return;
    const now = (this.opts.now ?? Date.now)();
    if (now - this.lastPassEnd < 2 * this.lastPassMs) return;
    void this.syncNow().catch(() => {});
  }

  /** Debounced trigger for file events: the files go in a quick pass; without a file, a complete pass. */
  poke(file?: string): void {
    if (file) this.dirty.add(file);
    else this.wantFull = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncNow(false, true).catch(() => {}), this.opts.debounceMs ?? 300);
  }

  /**
   * Runs a pass now, or right after the current one. At most one pass runs and one waits;
   * callers arriving while one waits join it (events coalesce). A person asking (rung sync) retries refused imports.
   * `quick`: only for the files that changed, unless something asked for a complete pass meanwhile.
   */
  syncNow(retry = false, quick = false): Promise<SyncReport | null> {
    if (this.stopped) return Promise.resolve(null);
    if (retry) this.refused.clear();
    if (!quick) this.wantFull = true;
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

  /** What this watch may do now: writes turned off stop the next import; turned on, the bridge (started without import rights) starts again. */
  private async reload(): Promise<void> {
    if (!this.opts.reloadConfig) return;
    const next = await this.opts.reloadConfig().catch(() => this.config);
    const writes = (c: RungConfig) => !c.writesOff && c.sync.import === "auto";
    if (writes(next) && !writes(this.config) && this.bridge) {
      await this.bridge.close().catch(() => undefined);
      this.bridge = await this.opts.bridgeFactory();
    }
    this.config = next;
  }

  private async pass(): Promise<SyncReport | null> {
    const now = (this.opts.now ?? Date.now)();
    if (now < this.retryAt) return null;
    const full = this.wantFull;
    const files = [...this.dirty];
    this.dirty.clear();
    this.wantFull = false;
    try {
      this.bridge ??= await this.opts.bridgeFactory();
      await this.reload();
      const options = { validateTags: this.opts.validateTags, config: this.config, refused: this.refused, unversionedMs: UNVERSIONED_MS, ...(this.opts.onPhase ? { onPhase: this.opts.onPhase } : {}) };
      if (!full) {
        // a saved file goes to TIA Portal without listing the whole project; what it cannot handle, the complete pass does
        const quick = files.length ? await syncQuick(this.root, this.bridge, this.state, options, files) : null;
        if (quick) return this.reported(mergeQuick(this.lastReport, quick), now);
        if (!files.length) return this.lastReport;
      }
      const t0 = Date.now();
      const r = await syncOnce(this.root, this.bridge, this.state, options).finally(() => {
        this.lastPassMs = Date.now() - t0;
        this.lastPassEnd = (this.opts.now ?? Date.now)();
      });
      return this.reported(r, now);
    } catch (e) {
      const err = e as Error;
      this.lastError = err.message;
      // what this pass was to look at is looked at again, completely
      this.wantFull = true;
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

  private reported(r: SyncReport, at: number): SyncReport {
    this.failures = 0;
    this.lastReport = r;
    this.lastPassAt = at;
    this.lastError = null;
    this.opts.onReport?.(r);
    return r;
  }

  get bridgeForTools(): ClosableBridge | null {
    return this.bridge;
  }

  /** rung sync --preview while the watch runs: through its bridge, after the pass in progress, writing nothing. */
  async preview(): Promise<SyncReport | null> {
    await this.running?.catch(() => null);
    if (!this.bridge) return null;
    await this.reload();
    return syncOnce(this.root, this.bridge, this.state, { config: this.config, preview: true });
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
