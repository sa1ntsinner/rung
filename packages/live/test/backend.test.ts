// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it, vi } from "vitest";
import * as live from "../src/index.js";
import type { OnlineReadResult, OnlineNativeCapture } from "@rung/bridge-client";
import type { WebApiClient } from "../src/webapi.js";
import { createServer } from "node:https";
import { readFileSync } from "node:fs";

afterEach(() => vi.useRealTimers());

describe("subscription backend", () => {
  it("routes capture through the existing session and rejects completion after close", async () => {
    const scope = { device: "P", address: "192.168.250.1", transport: "s7commplus" as const, epoch: 1 };
    let finish!: (value: OnlineNativeCapture) => void;
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const backend = await live.createS7Backend({ onEvent() {}, async request(method, params) {
      calls.push({ method, params });
      if (method === "online.connect") return { sessionId: "s", scope };
      if (method === "online.capture") return new Promise<OnlineNativeCapture>(resolve => { finish = resolve; });
      return {};
    } }, { device: "P", address: scope.address, certificateSha256: "A".repeat(64) });
    const pending = backend.capture!("F", "DB", scope);
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(calls.at(-1)).toEqual({ method: "online.capture", params: { sessionId: "s", block: "F", instance: "DB", scope } });
    const closing = backend.close();
    finish({ scope, coherence: "subscription-sample", capture: { bodies: [], scalars: [], route: { instance: "DB", database: 4, functionBlock: 4, sac: 118, compilationUnit: "1", element: "258" }, codeSignature: "signature", samples: [] } });
    await expect(pending).rejects.toMatchObject({ code: "BRIDGE_EXITED" });
    await closing;
  });
  it("retains startup alarms and marks them disconnected if the host exits", async () => {
    let emit!: (event: { event: string; params: unknown }) => void;
    const scope = { device: "P", address: "192.168.250.1", transport: "s7commplus" as const, epoch: 1 };
    const before = { at: 10, scope, lcid: 1033, alarms: [] };
    const during = { ...before, at: 11, sessionId: "s", subscriptionId: "a" };
    const frames: unknown[] = [];
    const backend = await live.createS7Backend({ onEvent(cb) { emit = cb; }, async request(method) {
      if (method === "online.connect") return { sessionId: "s", scope };
      if (method === "online.alarms") { emit({ event: "online.alarms", params: during }); return { subscriptionId: "a", snapshot: before }; }
      return {};
    } }, { device: "P", address: scope.address, certificateSha256: "A".repeat(64) });
    const lease = await backend.subscribeAlarms!(1033, frame => frames.push(frame));
    expect(frames).toEqual([before, during]);
    emit({ event: "exit", params: {} });
    expect(frames.at(-1)).toMatchObject({ at: expect.any(Number), connectionState: "disconnected", alarms: [] });
    await lease.close(); await backend.close();
  });
  it("stops after a real HTTPS certificate validation failure", async () => {
    const server = createServer({
      key: readFileSync(new URL("./fixtures/localhost.key", import.meta.url)),
      cert: readFileSync(new URL("./fixtures/localhost.crt", import.meta.url)),
    });
    let attempts = 0;
    server.on("connection", () => { attempts++; });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const address = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    const backend = live.createWebApiBackend(new live.WebApiClient({ url: address, user: "u", password: "p" }), { device: "P", address, transport: "webapi", epoch: 1 });
    const out: OnlineReadResult[] = [];
    try {
      await backend.subscribe(["x"], 100, frame => { out.push(frame); });
      expect(out[0]).toMatchObject({ connectionState: "disconnected", errorCode: "CERTIFICATE_UNTRUSTED" });
      await new Promise(r => setTimeout(r, 250));
      expect(attempts).toBe(1);
    } finally { await backend.close(); await new Promise<void>(r => server.close(() => r())); }
  });
  it("marks the last complete snapshot disconnected when the online host exits", async () => {
    let emit!: (event: { event: string; params: unknown }) => void;
    let dead = false;
    const scope = { device: "P", address: "192.168.250.1", transport: "s7commplus", epoch: 1 };
    const out: OnlineReadResult[] = [];
    const backend = await live.createS7Backend({ onEvent(cb) { emit = cb; }, async request(method) {
      if (dead) throw Object.assign(new Error("host exited"), { code: "BRIDGE_EXITED" });
      if (method === "online.connect") return { sessionId: "s", scope };
      if (method === "online.subscribe") return { subscriptionId: "sub", snapshot: { at: 10, scope, items: [{ name: "x", value: 0, observedAt: 10 }] } };
      return {};
    } }, { device: "P", address: scope.address, certificateSha256: "A".repeat(64) });
    const lease = await backend.subscribe(["x"], 250, frame => { out.push(frame); });
    dead = true;
    emit({ event: "exit", params: {} });
    expect(out.at(-1)).toMatchObject({ connectionState: "disconnected", errorCode: "BRIDGE_EXITED", items: [{ name: "x", value: 0, observedAt: 10 }] });
    await lease.close();
    await backend.close();
  });
  it("does not lose notifications before subscribe response and filters unrelated and late events", async () => {
    let emit!: (event: { event: string; params: unknown }) => void;
    const calls: string[] = [], out: OnlineReadResult[] = [];
    const scope = { device: "P", address: "192.168.250.1", transport: "s7commplus", epoch: 1 };
    const snapshot = { at: 10, scope, items: [{ name: "DB.x", value: 0, display: "0.0", type: "REAL", observedAt: 10 }] };
    const rpc = {
      onEvent(cb: typeof emit) { emit = cb; },
      async request(method: string) {
        calls.push(method);
        if (method === "online.connect") return { sessionId: "s", scope, identity: {}, capabilities: ["online.subscribe"] };
        if (method === "online.subscribe") {
          emit({ event: "online.values", params: { ...snapshot, at: 11, sessionId: "s", subscriptionId: "sub", items: [{ name: "DB.x", value: 1, display: "1.0", type: "REAL", observedAt: 11 }] } });
          return { subscriptionId: "sub", snapshot };
        }
        return {};
      },
    };
    const backend = await live.createS7Backend(rpc, { device: "P", address: scope.address, certificateSha256: "A".repeat(64) });
    const lease = await backend.subscribe(["DB.x"], 250, f => { out.push(f); });
    expect(out.map(x => x.at)).toEqual([10, 11]);
    emit({ event: "online.values", params: { ...snapshot, sessionId: "other", subscriptionId: "sub" } });
    expect(out).toHaveLength(2);
    await lease.close(); await lease.close();
    emit({ event: "online.values", params: { ...snapshot, sessionId: "s", subscriptionId: "sub" } });
    expect(out).toHaveLength(2); await backend.close();
    expect(calls).toEqual(["online.connect", "online.subscribe", "online.unsubscribe", "online.disconnect"]);
  });
  it("rejects invalid subscription cycles before a host request", async () => {
    const calls: string[] = [];
    const backend = await live.createS7Backend({ onEvent() {}, async request(method: string) { calls.push(method); return { sessionId: "s" }; } }, { device: "P", address: "192.168.250.1", certificateSha256: "A".repeat(64) });
    await expect(backend.subscribe(["DB.x"], NaN, () => {})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls).toEqual(["online.connect"]); await backend.close();
  });
  it("closes a subscription that completes while the backend is closing", async () => {
    const calls: string[] = []; let finish!: (value: unknown) => void;
    const backend = await live.createS7Backend({ onEvent() {}, async request(method: string) {
      calls.push(method);
      if (method === "online.connect") return { sessionId: "s" };
      if (method === "online.subscribe") return new Promise(r => { finish = r; });
      return {};
    } }, { device: "P", address: "192.168.250.1", certificateSha256: "A".repeat(64) });
    const lease = backend.subscribe(["DB.x"], 250, () => { throw new Error("late callback"); });
    const rejected = expect(lease).rejects.toMatchObject({ code: "BRIDGE_EXITED" });
    const closing = backend.close(); finish({ subscriptionId: "sub" });
    await rejected; await closing;
    expect(calls).toEqual(["online.connect", "online.subscribe", "online.unsubscribe", "online.disconnect"]);
  });
  it("Web API polling keeps measurement age on failure and advances epoch on recovery", async () => {
    vi.useFakeTimers(); let reads = 0, logouts = 0;
    const client = { async read(names: string[]) {
      reads++;
      if (reads === 2) throw Object.assign(new Error("PLC off"), { code: "NETWORK" });
      return names.map(name => ({ name, value: reads }));
    }, async logout() { logouts++; } } as unknown as WebApiClient;
    const out: OnlineReadResult[] = [];
    const backend = live.createWebApiBackend(client, { device: "P", address: "192.168.250.1", transport: "webapi", epoch: 1 });
    const lease = await backend.subscribe(["DB.x", "DB.y"], 250, f => { out.push(f); });
    await vi.advanceTimersByTimeAsync(250);
    expect(out[1]).toMatchObject({ connectionState: "stale", items: [{ name: "DB.x", value: 1, error: "PLC off", observedAt: out[0]!.at }, { name: "DB.y", value: 1, error: "PLC off" }] });
    await vi.advanceTimersByTimeAsync(250);
    expect(out[2]).toMatchObject({ scope: { epoch: 2 }, items: [{ value: 3 }, { value: 3 }] });
    await lease.close(); await vi.advanceTimersByTimeAsync(1000); expect(reads).toBe(3);
    await backend.close(); expect(logouts).toBe(1);
  });
  it("Web API authentication failure stops polling retries", async () => {
    vi.useFakeTimers(); let reads = 0;
    const client = { async read() { reads++; throw Object.assign(new Error("denied"), { code: 100 }); }, async logout() {} } as unknown as WebApiClient;
    const out: OnlineReadResult[] = [];
    const backend = live.createWebApiBackend(client, { device: "P", address: "192.168.250.1", transport: "webapi", epoch: 1 });
    await backend.subscribe(["DB.x"], 250, x => { out.push(x); });
    await vi.advanceTimersByTimeAsync(10000);
    expect(reads).toBe(1); expect(out[0]?.connectionState).toBe("disconnected"); await backend.close();
  });
});
