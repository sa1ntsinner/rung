// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it, vi } from "vitest";
import * as live from "../src/index.js";
import type { LiveFrame, OnlineReadResult } from "@rung/bridge-client";

const scope = { device: "P", address: "192.168.250.1", transport: "s7commplus" as const, epoch: 1 };
const frame = (names: string[], at = 10, epoch = 1): OnlineReadResult => ({ at, scope: { ...scope, epoch }, items: names.map(name => ({ name, value: at, observedAt: at, type: "REAL", display: `${at}.0` })) });
function fixture() {
  const subscriptions: { names: string[]; cycle: number; push: (f: OnlineReadResult) => void; closed: boolean }[] = [];
  let opens = 0, closes = 0;
  const hub = new live.LiveHub(async () => {
    opens++;
    return {
      read: async (names: string[]) => frame(names),
      async subscribe(names: string[], cycle: number, push: (f: OnlineReadResult) => void) {
        const sub = { names, cycle, push, closed: false }; subscriptions.push(sub);
        push(frame(names));
        return { close: async () => { sub.closed = true; } };
      },
      close: async () => { closes++; },
    };
  }, { idleMs: 30 });
  return { hub, subscriptions, get opens() { return opens; }, get closes() { return closes; } };
}
afterEach(() => vi.useRealTimers());
async function settled<T>(pending: Promise<T>): Promise<T> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(100);
  return pending;
}
describe("shared live hub", () => {
  it("shares one alarm subscription per PLC and language and closes it with the last consumer", async () => {
    let subscriptions = 0, releases = 0;
    const snapshot = { at: 1, scope, lcid: 1033, alarms: [] };
    const hub = new live.LiveHub(async () => ({ read: async names => frame(names), subscribe: async () => ({ close: async () => {} }),
      alarms: async () => snapshot,
      subscribeAlarms: async (_lcid, callback) => { subscriptions++; callback(snapshot); return { close: async () => { releases++; } }; }, close: async () => {} }));
    try {
      const a: unknown[] = [], b: unknown[] = [];
      const first = await hub.subscribeAlarms("P", 1033, frame => a.push(frame));
      const second = await hub.subscribeAlarms("P", 1033, frame => b.push(frame));
      expect(subscriptions).toBe(1); expect(a).toEqual([snapshot]); expect(b).toEqual([snapshot]);
      await first.close(); expect(releases).toBe(0);
      await second.close(); expect(releases).toBe(1);
    } finally { await hub.close(); }
  });
  it("keeps the old lease until a replacement union is ready", async () => {
    let active = 0;
    const hub = new live.LiveHub(async () => ({ read: async names => frame(names), async subscribe(names, _cycle, callback) {
      if (names.length > 1 && active === 0) throw new Error("Recovery lost its last lease");
      active++; callback(frame(names));
      return { close: async () => { active--; } };
    }, close: async () => {} }));
    try {
      await hub.subscribe("P", { x: "X" }, 250, () => {});
      await hub.subscribe("P", { y: "Y" }, 250, () => {});
      expect(active).toBe(1);
    } finally { await hub.close(); }
  });
  it("limits fast UI consumers to ten complete frames per second", async () => {
    vi.useFakeTimers(); const f = fixture(), out: LiveFrame[] = [];
    try {
      await settled(f.hub.subscribe("P", { x: "DB.x" }, 100, x => { out.push(x); }));
      await vi.advanceTimersByTimeAsync(0);
      for (let n = 11; n <= 1000; n++) f.subscriptions.at(-1)!.push(frame(["DB.x"], n));
      await vi.advanceTimersByTimeAsync(99);
      expect(out.map(x => x.at)).toEqual([10]);
      await vi.advanceTimersByTimeAsync(1);
      expect(out.map(x => x.at)).toEqual([10, 1000]);
    } finally { await f.hub.close(); }
  });
  it("marks retained measurements stale for every consumer without refreshing their age", async () => {
    const f = fixture(), out: LiveFrame[] = [];
    try {
      await f.hub.subscribe("P", { speed: "DB.x" }, 250, frame => { out.push(frame); });
      const snapshot = frame(["DB.x"], 10);
      f.subscriptions.at(-1)!.push({ ...snapshot, at: 20, connectionState: "reconnecting" });
      expect(out.at(-1)).toMatchObject({ state: "stale", values: { speed: 10 }, errors: { speed: "PLC stale" }, observedAt: { speed: 10 } });
      f.subscriptions.at(-1)!.push({ ...snapshot, at: 30, connectionState: "disconnected" });
      await Promise.resolve();
      expect(out.at(-1)?.errors).toEqual({ speed: "PLC disconnected" });
    } finally { await f.hub.close(); }
  });
  it("opens one session for simultaneous consumers, unions symbols, preserves labels and releases leases", async () => {
    const f = fixture(), a: LiveFrame[] = [], b: LiveFrame[] = [];
    try {
      const [one, two] = await Promise.all([
        f.hub.subscribe("P", { local: "DB.x", alias: "DB.x" }, 500, x => { a.push(x); }),
        f.hub.subscribe("P", { other: "DB.x", y: "DB.y" }, 250, x => { b.push(x); }),
      ]);
      await Promise.resolve();
      expect(f.opens).toBe(1);
      expect(f.subscriptions).toHaveLength(1);
      expect(f.subscriptions.at(-1)).toMatchObject({ names: ["DB.x", "DB.y"], cycle: 250 });
      expect(a.at(-1)).toMatchObject({ values: { local: 10, alias: 10 }, display: { local: "10.0", alias: "10.0" } });
      expect(b.at(-1)?.values).toEqual({ other: 10, y: 10 });
      await two.close();
      expect(f.subscriptions.at(-1)?.names).toEqual(["DB.x"]);
      await one.close(); await one.close();
      expect(f.subscriptions.every(s => s.closed)).toBe(true);
    } finally { await f.hub.close(); }
  });
  it("rejects notifications from replaced generations and older epochs", async () => {
    const f = fixture(), out: LiveFrame[] = [];
    try {
      const old = await f.hub.subscribe("P", { x: "DB.x" }, 250, x => { out.push(x); });
      const removed = f.subscriptions.at(-1)!;
      await old.close();
      await f.hub.subscribe("P", { x: "DB.x" }, 250, x => { out.push(x); });
      const active = f.subscriptions.at(-1)!;
      active.push(frame(["DB.x"], 20, 2)); await new Promise(r => setTimeout(r, 110));
      removed.push(frame(["DB.x"], 999, 3));
      active.push(frame(["DB.x"], 998, 1)); await Promise.resolve();
      expect(out.at(-1)).toMatchObject({ values: { x: 20 }, scope: { epoch: 2 } });
    } finally { await f.hub.close(); }
  });
  it("closes the last idle backend, but leaves a quiet active subscription alone", async () => {
    vi.useFakeTimers(); const f = fixture();
    const lease = await settled(f.hub.subscribe("P", { x: "DB.x" }, 250, () => {}));
    await vi.advanceTimersByTimeAsync(1000); expect(f.closes).toBe(0);
    await settled(lease.close()); await vi.advanceTimersByTimeAsync(30); expect(f.closes).toBe(1);
    await f.hub.close(); expect(f.closes).toBe(1);
  });
  it("coalesces a slow consumer to the latest complete snapshot", async () => {
    const f = fixture(), out: number[] = [];
    let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    try {
      await f.hub.subscribe("P", { x: "DB.x", y: "DB.y" }, 250, async x => { out.push(x.at); if (out.length === 1) await wait; });
      await Promise.resolve();
      for (let n = 11; n <= 1000; n++) f.subscriptions.at(-1)!.push(frame(["DB.x", "DB.y"], n));
      expect(out).toEqual([10]); release();
      await new Promise(r => setTimeout(r, 110)); expect(out).toEqual([10, 1000]);
    } finally { await f.hub.close(); }
  });
  it("keeps separate PLC sessions even when their wire names match", async () => {
    const f = fixture();
    await Promise.all([f.hub.read("P", ["DB.x"]), f.hub.read("Q", ["DB.x"])]);
    expect(f.opens).toBe(2); await f.hub.close();
  });
  it("does not dispose a session while a one-shot read is still opening", async () => {
    vi.useFakeTimers(); let finish!: () => void, reads = 0, closes = 0;
    const waiting = new Promise<void>(r => { finish = r; });
    const hub = new live.LiveHub(async () => ({ read: async names => { if (++reads === 2) await waiting; return frame(names); }, subscribe: async () => ({ close: async () => {} }), close: async () => { closes++; } }), { idleMs: 30 });
    await hub.read("P", ["DB.y"]);
    const slow = hub.read("P", ["DB.x"]);
    await hub.read("P", ["DB.y"]);
    await vi.advanceTimersByTimeAsync(50); expect(closes).toBe(0);
    finish(); await slow; await vi.advanceTimersByTimeAsync(30); expect(closes).toBe(1); await hub.close();
  });
  it("restores existing consumers when a larger subscription union is refused", async () => {
    const out: LiveFrame[] = []; let push!: (frame: OnlineReadResult) => void;
    const hub = new live.LiveHub(async () => ({ read: async names => frame(names), async subscribe(names, _cycle, callback) {
      if (names.includes("bad")) throw new Error("PLC resource limit");
      push = callback; callback(frame(names)); return { close: async () => { push = () => {}; } };
    }, close: async () => {} }));
    try {
      await hub.subscribe("P", { a: "A" }, 250, f => { out.push(f); });
      await expect(hub.subscribe("P", { b: "bad" }, 250, () => {})).rejects.toThrow("resource limit");
      push(frame(["A"], 20)); await new Promise(r => setTimeout(r, 110));
      expect(out.at(-1)?.values).toEqual({ a: 20 });
    } finally { await hub.close(); }
  });
  it("preserves labels that match object prototype property names", async () => {
    const f = fixture(); let got: LiveFrame | undefined;
    try {
      await f.hub.subscribe("P", Object.fromEntries([["__proto__", "DB.x"], ["constructor", "DB.x"]]), 250, x => { got = x; });
      expect(Object.keys(got!.values)).toEqual(["__proto__", "constructor"]);
      expect(Object.hasOwn(got!.display!, "__proto__")).toBe(true);
    } finally { await f.hub.close(); }
  });
});
