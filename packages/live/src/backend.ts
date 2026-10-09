// SPDX-License-Identifier: BUSL-1.1
import { BridgeError, type OnlineConnectRequest, type OnlineReadResult, type OnlineAlarmResult, type LiveScope } from "@rung/bridge-client";
import { S7CommPlusClient, type OnlineRpc } from "./s7commplus.js";
import { WebApiClient } from "./webapi.js";
import type { LiveBackend } from "./hub.js";

export interface OnlineEventRpc extends OnlineRpc {
  onEvent(callback: (event: { event: string; params: unknown }) => void): void;
  close?(): Promise<void>;
}
type ValuesEvent = OnlineReadResult & { sessionId: string; subscriptionId: string };

/** Owns the host and its read session, including callbacks arriving during subscribe. */
export async function createS7Backend(rpc: OnlineEventRpc, target: OnlineConnectRequest): Promise<LiveBackend> {
  const client = new S7CommPlusClient(rpc);
  const info = await client.connect(target);
  const callbacks = new Map<string, (frame: OnlineReadResult) => void>();
  const latest = new Map<string, OnlineReadResult>();
  const early = new Map<string, ValuesEvent>();
  const alarmCallbacks = new Map<string, (frame: OnlineAlarmResult) => void>();
  const alarmLatest = new Map<string, OnlineAlarmResult>();
  const alarmEarly = new Map<string, OnlineAlarmResult>();
  const opening = new Set<Promise<unknown>>();
  let openingCount = 0;
  let closed = false;
  rpc.onEvent(event => {
    if (closed) return;
    if (event.event === "exit") {
      for (const [id, callback] of alarmCallbacks) { const frame = alarmLatest.get(id); if (frame) callback({ ...frame, at: Date.now(), connectionState: "disconnected", errorCode: "BRIDGE_EXITED" }); }
      for (const [id, callback] of callbacks) {
        const frame = latest.get(id);
        if (frame) callback({ ...frame, at: Date.now(), connectionState: "disconnected", errorCode: "BRIDGE_EXITED" });
      }
      return;
    }
    if (event.event === "online.alarms") {
      const frame = event.params as OnlineAlarmResult & { sessionId: string; subscriptionId: string };
      if (frame.sessionId !== info.sessionId || !Array.isArray(frame.alarms)) return;
      const callback = alarmCallbacks.get(frame.subscriptionId);
      if (callback) { alarmLatest.set(frame.subscriptionId, frame); callback(frame); }
      else if (openingCount && alarmEarly.size < 8) alarmEarly.set(frame.subscriptionId, frame);
      return;
    }
    if (event.event !== "online.values") return;
    const frame = event.params as ValuesEvent;
    if (frame.sessionId !== info.sessionId || !Array.isArray(frame.items)) return;
    const callback = callbacks.get(frame.subscriptionId);
    if (callback) { latest.set(frame.subscriptionId, frame); callback(frame); }
    else if (openingCount && early.size < 512) early.set(frame.subscriptionId, frame);
  });
  return {
    read: names => client.readFrame(names),
    state: () => client.state(),
    alarms: lcid => client.call("online.alarms", { sessionId: info.sessionId, lcid }),
    async subscribeAlarms(lcid, callback) {
      if (closed) throw new BridgeError("BRIDGE_EXITED", "Online backend is closed");
      openingCount++;
      const pending = client.call<{ subscriptionId: string; snapshot: OnlineAlarmResult }>("online.alarms", { sessionId: info.sessionId, lcid, subscribe: true });
      opening.add(pending);
      try {
        const result = await pending;
        if (closed) { await client.call("online.unsubscribe", { subscriptionId: result.subscriptionId }); throw new BridgeError("BRIDGE_EXITED", "Online backend closed during alarm subscription"); }
        alarmCallbacks.set(result.subscriptionId, callback); alarmLatest.set(result.subscriptionId, result.snapshot); callback(result.snapshot);
        const early = alarmEarly.get(result.subscriptionId);
        if (early && early.scope.epoch >= result.snapshot.scope.epoch && early.at >= result.snapshot.at) { alarmLatest.set(result.subscriptionId, early); callback(early); }
        alarmEarly.delete(result.subscriptionId);
        return { close: async () => { alarmLatest.delete(result.subscriptionId); if (!alarmCallbacks.delete(result.subscriptionId) || closed) return; await client.call("online.unsubscribe", { subscriptionId: result.subscriptionId }); } };
      } finally { opening.delete(pending); openingCount--; if (!openingCount) alarmEarly.clear(); }
    },
    async subscribe(names, cycleMs, onFrame) {
      if (closed) throw new BridgeError("BRIDGE_EXITED", "Online backend is closed");
      if (!Number.isInteger(cycleMs) || cycleMs < 100 || cycleMs > 60_000) throw new BridgeError("BAD_REQUEST", "Subscription cycle must be 100–60000 ms");
      if (!names.length || names.length > 512) throw new BridgeError("RESOURCE_LIMIT", "Subscribe to 1–512 names");
      openingCount++;
      const pending = client.call<{ subscriptionId: string; snapshot: OnlineReadResult }>("online.subscribe", { sessionId: info.sessionId, names, cycleMs });
      opening.add(pending);
      try {
        const result = await pending;
        if (closed) { await client.call("online.unsubscribe", { subscriptionId: result.subscriptionId }); throw new BridgeError("BRIDGE_EXITED", "Online backend closed during subscription"); }
        let active = true;
        callbacks.set(result.subscriptionId, onFrame);
        latest.set(result.subscriptionId, result.snapshot);
        onFrame(result.snapshot);
        const buffered = early.get(result.subscriptionId);
        if (buffered && buffered.scope.epoch >= result.snapshot.scope.epoch && buffered.at >= result.snapshot.at) { latest.set(result.subscriptionId, buffered); onFrame(buffered); }
        early.delete(result.subscriptionId);
        return { close: async () => {
          if (!active) return; active = false;
          callbacks.delete(result.subscriptionId); latest.delete(result.subscriptionId); early.delete(result.subscriptionId);
          try { await client.call("online.unsubscribe", { subscriptionId: result.subscriptionId }); }
          catch (error) { if ((error as { code?: string }).code !== "BRIDGE_EXITED") throw error; }
        } };
      } finally { opening.delete(pending); openingCount--; if (!openingCount) early.clear(); }
    },
    async close() {
      if (closed) return; closed = true; callbacks.clear(); latest.clear(); early.clear(); alarmCallbacks.clear(); alarmEarly.clear(); alarmLatest.clear();
      await Promise.allSettled(opening);
      try { await client.close(); }
      catch (error) { if ((error as { code?: string }).code !== "BRIDGE_EXITED") throw error; }
      finally { await rpc.close?.(); }
    },
  };
}

/** The same complete-frame contract for the existing read-only polling transport. */
export function createWebApiBackend(client: WebApiClient, initialScope: LiveScope): LiveBackend {
  let scope = { ...initialScope }, closed = false, failed = false;
  const stops = new Set<() => Promise<void>>();
  const read = async (names: string[]): Promise<OnlineReadResult> => {
    if (closed) throw new BridgeError("BRIDGE_EXITED", "Web API backend is closed");
    const items = await client.read(names);
    if (failed) { scope = { ...scope, epoch: scope.epoch + 1 }; failed = false; }
    const at = Date.now();
    return { at, scope, items: items.map(row => ({ ...row, ...(row.error ? {} : { observedAt: at }) })) };
  };
  return {
    read,
    async subscribe(names, cycleMs, callback) {
      if (!Number.isInteger(cycleMs) || cycleMs < 100 || cycleMs > 60_000) throw new BridgeError("BAD_REQUEST", "Subscription cycle must be 100–60000 ms");
      let active = true, timer: NodeJS.Timeout | undefined, running: Promise<void> = Promise.resolve();
      let last: OnlineReadResult | undefined;
      const tick = async () => {
        try {
          const frame = await read(names);
          if (active) { last = frame; callback(frame); }
        } catch (error) {
          failed = true;
          if (active) {
            const err = error as { code?: string | number; message?: string };
            const fatal = err.code === "AUTHENTICATION_FAILED" || err.code === "CERTIFICATE_UNTRUSTED" || err.code === "ACCESS_DENIED" || err.code === 100 || err.code === 401 || err.code === 403;
            callback({ at: Date.now(), scope, connectionState: fatal ? "disconnected" : "stale", errorCode: String(err.code ?? "NETWORK"), items: names.map(name => ({ ...last?.items.find(row => row.name === name), name, error: err.message ?? String(error) })) });
            if (fatal) active = false;
          }
        }
        if (active && !closed) timer = setTimeout(() => { running = tick(); }, cycleMs);
      };
      const stop = async () => { active = false; clearTimeout(timer); await running; stops.delete(stop); };
      stops.add(stop); running = tick(); await running;
      return { close: stop };
    },
    async close() {
      if (closed) return; closed = true;
      await Promise.allSettled([...stops].map(stop => stop()));
      await client.logout();
    },
  };
}
