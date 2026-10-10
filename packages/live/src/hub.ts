// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { BridgeError, type LiveFrame, type OnlineReadResult, type OnlineStateResult, type OnlineAlarmResult, type OnlineNativeCapture, type LiveScope } from "@rung/bridge-client";

export interface LiveLease { id: string; close(): Promise<void> }
export interface LiveBackend {
  capture?(block: string, instance: string, scope: LiveScope): Promise<OnlineNativeCapture>;
  read(names: string[]): Promise<OnlineReadResult>;
  subscribe(names: string[], cycleMs: number, onFrame: (frame: OnlineReadResult) => void): Promise<{ close(): Promise<void> }>;
  state?(): Promise<OnlineStateResult>;
  alarms?(lcid: number): Promise<OnlineAlarmResult>;
  subscribeAlarms?(lcid: number, callback: (frame: OnlineAlarmResult) => void): Promise<{ close(): Promise<void> }>;
  /** False once the host behind it has exited: the hub opens a fresh backend for the next request. */
  alive?(): boolean;
  close(): Promise<void>;
}
interface Consumer {
  labels: Record<string, string>; cycle: number; active: boolean;
  callback: (frame: LiveFrame) => void | Promise<void>; pending?: LiveFrame; delivering: boolean;
  sentAt?: number; timer?: NodeJS.Timeout; received?: boolean;
}
interface Entry {
  alarmGroups: Map<number, { callbacks: Map<string, (frame: OnlineAlarmResult) => void>; subscription?: { close(): Promise<void> }; latest?: OnlineAlarmResult }>;
  backend: LiveBackend; consumers: Map<string, Consumer>; generation: number; epoch: number;
  subscription?: { close(): Promise<void> }; signature?: string; latest?: OnlineReadResult;
  tail: Promise<unknown>; busy: number; idle?: NodeJS.Timeout;
}

/** One connection and one symbol union per target; host owns transport recovery. */
export class LiveHub {
  private readonly entries = new Map<string, Promise<Entry>>();
  private closed = false;
  constructor(private readonly open: (key: string) => Promise<LiveBackend>, private readonly options: { idleMs?: number } = {}) {}

  private async entry(key: string): Promise<Entry> {
    if (this.closed) throw new BridgeError("BRIDGE_EXITED", "Live hub is closed");
    let pending = this.entries.get(key);
    // ponytail: a dead host is replaced on the next request; its running subscriptions end and their clients start again
    const cached = pending && await pending.catch(() => undefined);
    if (cached && cached.backend.alive?.() === false && this.entries.get(key) === pending) {
      this.entries.delete(key); cached.generation++; clearTimeout(cached.idle);
      void cached.backend.close().catch(() => {});
      pending = undefined;
    }
    if (!pending) {
      pending = this.open(key).then(backend => ({ backend, consumers: new Map(), alarmGroups: new Map(), generation: 0, epoch: 0, tail: Promise.resolve(), busy: 0 }));
      this.entries.set(key, pending);
      void pending.catch(() => { if (this.entries.get(key) === pending) this.entries.delete(key); });
    }
    const e = await pending;
    clearTimeout(e.idle);
    return e;
  }
  private serial<T>(e: Entry, action: () => Promise<T>): Promise<T> {
    const next = e.tail.then(action); e.tail = next.catch(() => {}); return next;
  }
  private idle(key: string, e: Entry): void {
    if (e.consumers.size || e.busy || this.closed) return;
    clearTimeout(e.idle);
    e.idle = setTimeout(() => {
      void this.serial(e, async () => {
        if (e.consumers.size || e.busy) return;
        this.entries.delete(key); e.generation++;
        await e.backend.close();
      }).catch(() => {});
    }, this.options.idleMs ?? 30_000);
    e.idle.unref();
  }
  async read(key: string, names: string[]): Promise<OnlineReadResult> {
    const e = await this.entry(key);
    e.busy++;
    try { return await e.backend.read(names); } finally { e.busy--; this.idle(key, e); }
  }
  async capture(key: string, block: string, instance: string, scope: LiveScope): Promise<OnlineNativeCapture> {
    const e = await this.entry(key), generation = e.generation;
    e.busy++;
    try {
      const current = () => {
        if (this.closed || !e.consumers.size || generation !== e.generation) throw new BridgeError("BRIDGE_EXITED", "Native reader generation closed");
        const latest = e.latest;
        if (!scope || !latest || latest.connectionState && latest.connectionState !== "connected"
          || latest.scope.epoch !== scope.epoch || latest.scope.device !== scope.device || latest.scope.address !== scope.address || latest.scope.transport !== scope.transport)
          throw new BridgeError("ONLINE_FAILED", "Native capture scope changed or PLC is stale");
      };
      current();
      if (!e.backend.capture) throw new BridgeError("UNSUPPORTED_CAPABILITY", "Native capture is unavailable for this transport");
      const result = await e.backend.capture(block, instance, scope);
      current();
      if (result.scope.epoch !== scope.epoch || result.scope.device !== scope.device || result.scope.address !== scope.address || result.scope.transport !== scope.transport)
        throw new BridgeError("ONLINE_FAILED", "Native capture result scope changed");
      return result;
    } finally { e.busy--; this.idle(key, e); }
  }
  async state(key: string): Promise<OnlineStateResult> {
    const e = await this.entry(key);
    e.busy++;
    try {
      if (!e.backend.state) throw new BridgeError("UNSUPPORTED_CAPABILITY", "CPU state is unavailable for this transport");
      return await e.backend.state();
    } finally { e.busy--; this.idle(key, e); }
  }
  async alarms(key: string, lcid: number): Promise<OnlineAlarmResult> {
    if (!Number.isInteger(lcid) || lcid < 1 || lcid > 65535) throw new BridgeError("BAD_REQUEST", "LCID must be 1–65535");
    const e = await this.entry(key); e.busy++;
    try { if (!e.backend.alarms) throw new BridgeError("UNSUPPORTED_CAPABILITY", "Alarms are unavailable for this transport"); return await e.backend.alarms(lcid); }
    finally { e.busy--; this.idle(key, e); }
  }
  async subscribeAlarms(key: string, lcid: number, callback: (frame: OnlineAlarmResult) => void): Promise<LiveLease> {
    if (!Number.isInteger(lcid) || lcid < 1 || lcid > 65535) throw new BridgeError("BAD_REQUEST", "LCID must be 1–65535");
    const e = await this.entry(key), id = randomUUID(); e.busy++;
    try {
      await this.serial(e, async () => {
        if (this.closed || !e.backend.subscribeAlarms) throw new BridgeError("UNSUPPORTED_CAPABILITY", "Alarm subscriptions are unavailable");
        let group = e.alarmGroups.get(lcid);
        if (!group) { if (e.alarmGroups.size >= 8) throw new BridgeError("RESOURCE_LIMIT", "At most 8 alarm languages"); group = { callbacks: new Map() }; e.alarmGroups.set(lcid, group); }
        if (group.callbacks.size >= 256) throw new BridgeError("RESOURCE_LIMIT", "Too many alarm consumers");
        group.callbacks.set(id, callback);
        if (!group.subscription) {
          const current = group;
          try { group.subscription = await e.backend.subscribeAlarms(lcid, frame => { if (this.closed || current.latest && frame.scope.epoch < current.latest.scope.epoch) return; current.latest = frame; for (const cb of current.callbacks.values()) cb(frame); }); }
          catch (error) { group.callbacks.delete(id); e.alarmGroups.delete(lcid); throw error; }
        } else if (group.latest) callback(group.latest);
      });
    } catch (error) { e.busy--; this.idle(key, e); throw error; }
    let active = true;
    return { id, close: async () => { if (!active) return; active = false;
      try { await this.serial(e, async () => { const group = e.alarmGroups.get(lcid); if (!group) return; group.callbacks.delete(id); if (!group.callbacks.size) { e.alarmGroups.delete(lcid); await group.subscription?.close(); } }); }
      finally { e.busy--; this.idle(key, e); }
    } };
  }
  async subscribe(key: string, labels: Record<string, string>, cycleMs: number, callback: Consumer["callback"]): Promise<LiveLease> {
    if (!Number.isInteger(cycleMs) || cycleMs < 100 || cycleMs > 60_000) throw new BridgeError("BAD_REQUEST", "Subscription cycle must be 100–60000 ms");
    if (!Object.keys(labels).length || Object.keys(labels).length > 512 || Object.values(labels).some(x => typeof x !== "string" || !x.trim() || x.length > 1024)) throw new BridgeError("RESOURCE_LIMIT", "Subscribe to 1–512 valid names");
    const e = await this.entry(key), id = randomUUID();
    const c: Consumer = { labels: { ...labels }, cycle: cycleMs, active: true, callback, delivering: false };
    if (this.closed) throw new BridgeError("BRIDGE_EXITED", "Live hub is closed");
      if (e.consumers.size >= 256) throw new BridgeError("RESOURCE_LIMIT", "Too many live consumers");
      const union = new Set([...e.consumers.values()].flatMap(x => Object.values(x.labels)).concat(Object.values(labels)));
      if (union.size > 512) throw new BridgeError("RESOURCE_LIMIT", "PLC symbol union exceeds 512 names");
      e.consumers.set(id, c);
      try { await this.serial(e, () => this.rebuild(e)); if (e.latest && !c.received) this.deliver(c, e.latest); }
      catch (err) {
        c.active = false; e.consumers.delete(id);
        await this.serial(e, () => this.rebuild(e)).catch(() => {});
        this.idle(key, e); throw err;
      }
    return { id, close: async () => {
      if (!c.active) return;
      c.active = false; c.pending = undefined; clearTimeout(c.timer);
      e.consumers.delete(id);
      await this.serial(e, async () => { await this.rebuild(e); this.idle(key, e); });
    } };
  }
  private async rebuild(e: Entry): Promise<void> {
    await new Promise(r => setTimeout(r, 100));
    if (this.closed) return;
    const names = [...new Set([...e.consumers.values()].flatMap(c => Object.values(c.labels)))].sort();
    const cycle = Math.min(...[...e.consumers.values()].map(c => c.cycle));
    const signature = JSON.stringify([names, cycle]);
    if (signature === e.signature) return;
    if (!names.length) {
      e.generation++;
      await e.subscription?.close(); e.subscription = undefined; e.signature = undefined; e.latest = undefined;
      return;
    }
    const generation = e.generation + 1;
    let opening = true, buffered: OnlineReadResult | undefined;
    const receive = (frame: OnlineReadResult) => {
      if (opening) { buffered = frame; return; }
      if (this.closed || generation !== e.generation || frame.scope.epoch < e.epoch) return;
      e.epoch = frame.scope.epoch; e.latest = frame;
      for (const c of e.consumers.values()) this.deliver(c, frame);
    };
    const subscription = await e.backend.subscribe(names, cycle, receive);
    opening = false;
    if (this.closed) { await subscription.close(); return; }
    const previous = e.subscription;
    e.generation = generation; e.latest = undefined;
    e.subscription = subscription; e.signature = signature;
    if (buffered) receive(buffered);
    await previous?.close();
  }
  private deliver(c: Consumer, snapshot: OnlineReadResult): void {
    if (!c.active) return;
    c.received = true;
    const frame: LiveFrame = { at: snapshot.at, scope: snapshot.scope, values: Object.create(null), errors: Object.create(null), observedAt: Object.create(null), types: Object.create(null), display: Object.create(null), state: snapshot.connectionState === "disconnected" ? "disconnected" : snapshot.connectionState === "stale" || snapshot.connectionState === "reconnecting" ? "stale" : "live" };
    const rows = new Map(snapshot.items.map(row => [row.name, row]));
    for (const [label, name] of Object.entries(c.labels)) {
      const row = rows.get(name);
      if (!row) frame.errors[label] = "No subscription value";
      else {
        if (row.error) frame.errors[label] = row.error;
        if (row.value !== undefined) frame.values[label] = row.value;
        if (row.observedAt !== undefined) frame.observedAt[label] = row.observedAt;
        if (row.type) frame.types![label] = row.type;
        if (row.display !== undefined) frame.display![label] = row.display;
      }
      if (frame.state !== "live" && !frame.errors[label]) frame.errors[label] = `PLC ${frame.state}`;
    }
    c.pending = frame;
    if (frame.state !== "live") { clearTimeout(c.timer); c.timer = undefined; }
    this.flush(c);
  }
  private flush(c: Consumer): void {
    if (!c.active || !c.pending || c.timer) return;
    if (c.delivering) return;
    const delay = c.pending.state === "live" && c.sentAt !== undefined ? Math.max(0, 100 - (Date.now() - c.sentAt)) : 0;
    if (delay) {
      c.timer = setTimeout(() => { c.timer = undefined; this.flush(c); }, delay);
      return;
    }
    const next = c.pending; c.pending = undefined; c.sentAt = Date.now();
    c.delivering = true;
    void (async () => {
      try { await c.callback(next); }
      catch { c.pending = undefined; }
      finally { c.delivering = false; this.flush(c); }
    })();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.entries.values()].map(async pending => {
      const e = await pending; clearTimeout(e.idle); e.generation++;
      for (const c of e.consumers.values()) { c.active = false; c.pending = undefined; clearTimeout(c.timer); }
      await this.serial(e, async () => { await e.subscription?.close(); for (const group of e.alarmGroups.values()) { group.callbacks.clear(); await group.subscription?.close(); } e.alarmGroups.clear(); await e.backend.close(); });
    }));
    this.entries.clear();
  }
}
