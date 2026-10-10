// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "@rung/core";
import type { OnlineNativeCapture } from "@rung/bridge-client";
import { startLiveServer, brokerReader, liveSelection } from "../src/liveServer.js";
import { webApiFor } from "../src/live.js";
import { main } from "../src/main.js";
import { WebApiClient } from "@rung/live";
import {OwnerClient} from "@rung/sync";
import * as trust from "../src/liveTrust.js";

const closing: (() => Promise<void>)[] = [];
it.each(["values","alarms"])("closes IPC after a stalled %s release during reader shutdown",async kind=>{
 const root=await mkdtemp(join(tmpdir(),"rung-release-timeout-")),config=defaultConfig("fixture.ap20","V20","",["A"]);config.live={plc:{A:{transport:"s7commplus",address:"192.168.250.1",certificateSha256:"a".repeat(64)}}};await saveConfig(root,config);
 const close=vi.fn(),owner={subscribe:async()=>{},close,request:async(method:string)=>method==="release"?new Promise(()=>{}):{}};vi.spyOn(OwnerClient,"connect").mockResolvedValue(owner as unknown as OwnerClient);
 const reader=await brokerReader(root,{},{});if(kind==="values")await reader.subscribe!({Count:"Count"},100,()=>{});else await reader.subscribeAlarms!(1033,()=>{});
 vi.useFakeTimers();try{const result=reader.close().then(()=>undefined,error=>error);await vi.advanceTimersByTimeAsync(5100);expect(await result).toMatchObject({message:expect.stringMatching(/release timed out/)});expect(close).toHaveBeenCalledOnce();}finally{vi.useRealTimers();}
});
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
it("confirms a typed PLC preview once and cancels without sending", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-mutation-test-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["A"]);
  config.live = { plc: { A: { transport: "s7commplus", address: "192.168.250.1", allowWrites: true, certificateSha256: "a".repeat(64) } } };
  await saveConfig(root, config);
  const commit = vi.fn(async () => ({ outcome: "acknowledged" }));
  const close = vi.fn(async () => {});
  vi.spyOn(trust, "onlineHost").mockImplementation(async (_env, policy) => ({ close, request: async (method: string) => {
    const identity = { cpu: "S7-1500", serial: "fixture", plcName: "RungProve", firmware: "3.1" };
    const scope = { device: "A", address: policy!.address, transport: "s7commplus", epoch: 1 };
    if (method === "online.connect") return { sessionId: "s", identity, scope };
    if (method === "online.state") return { identity, scope };
    if (method === "online.prepare") return { operationId: "host", preview: "A · RungProve · 192.168.250.1\nINT := 17\nObserved: 3", expiresAt: Date.now() + 30_000,
      context: { binding: { ...policy, ...identity, epoch: 1, programRevision: "catalog" } } };
    if (method === "online.commit") return commit();
    throw new Error(method);
  } }) as unknown as Awaited<ReturnType<typeof trust.onlineHost>>);
  const server = await startLiveServer(root, {}); closing.push(() => server.close());
  const output: string[] = [];
  const io = { cwd: root, env: {}, stdout: (s: string) => output.push(s), stderr: () => {}, prompt: async () => "A" };
  expect(await main(["live", "modify", '"DB".Count', "17", "--device", "A"], io)).toBe(0);
  expect(output.join("")).toContain("INT := 17");
  expect(commit).toHaveBeenCalledOnce();
  expect(await main(["live", "stop", "--device", "A"], { ...io, prompt: async () => "cancel" })).toBe(1);
  expect(commit).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledTimes(2);
  const a = await brokerReader(root, {}, { device: "A" }), b = await brokerReader(root, {}, { device: "A" });
  closing.push(() => a.close(), () => b.close());
  const prepared = await a.prepare!({ action: "stop" });
  await expect(b.commit!(prepared.operationId, prepared.preview, true)).rejects.toMatchObject({ code: "STALE_PREPARATION" });
  config.live.plc!.A!.allowWrites = false; await saveConfig(root, config);
  await expect(a.commit!(prepared.operationId, prepared.preview, true)).rejects.toMatchObject({ code: "STALE_PREPARATION" });
  expect(commit).toHaveBeenCalledOnce();
  await expect(a.commit!(prepared.operationId, prepared.preview, true)).rejects.toMatchObject({ code: "STALE_PREPARATION" });
});

it("refuses noninteractive PLC mutations before starting a host", async () => {
  const host = vi.spyOn(trust, "onlineHost");
  const errors: string[] = [];
  expect(await main(["live", "run"], { cwd: process.cwd(), env: {}, stdout: () => {}, stderr: s => errors.push(s) })).toBe(1);
  expect(errors.join("")).toMatch(/interactive confirmation/);
  expect(host).not.toHaveBeenCalled();
});

it("delivers each selected PLC's credentials through private IPC rather than the broker startup environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-broker-test-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["A", "B"]);
  config.live = { plc: Object.fromEntries(["A", "B"].map(device => [device, {
    transport: "s7commplus" as const, address: device === "A" ? "192.168.250.1" : "192.168.250.2", allowWrites: false, certificateSha256: "a".repeat(64),
  }])) };
  await saveConfig(root, config);
  vi.spyOn(trust, "onlineHost").mockImplementation(async () => {
    let target: any;
    return { onEvent() {}, close: async () => {}, request: async (method: string, params: any) => {
      if (method === "online.connect") {
        target = params;
        if (params.password !== (params.device === "A" ? "alpha" : "beta")) throw new Error("PLC authentication failed");
        return { sessionId: params.device, scope: { device: params.device, address: params.address, transport: "s7commplus", epoch: 1 } };
      }
      if (method === "online.read") return { at: 1, scope: { device: target.device, address: target.address, transport: "s7commplus", epoch: 1 }, items: [{ name: "x", value: target.device }] };
      return {};
    } } as unknown as Awaited<ReturnType<typeof trust.onlineHost>>;
  });
  const server = await startLiveServer(root, {}); closing.push(() => server.close());
  const a = await brokerReader(root, { RUNG_PLC_PASSWORD: "alpha" }, { device: "A" }); closing.push(() => a.close());
  const b = await brokerReader(root, { RUNG_PLC_PASSWORD: "beta" }, { device: "B" }); closing.push(() => b.close());
  expect(await a.read(["x"])).toEqual([{ name: "x", value: "A" }]);
  expect(await b.read(["x"])).toEqual([{ name: "x", value: "B" }]);
  expect(await readFile(join(root, ".rung", "live-owner.json"), "utf8")).not.toMatch(/alpha|beta/);
});
it("uses the PLC user environment for the shared native session", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-broker-test-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["A"]);
  config.live = { plc: { A: { transport: "s7commplus", address: "192.168.250.1", allowWrites: false, certificateSha256: "a".repeat(64) } } };
  await saveConfig(root, config);
  let credentials: Record<string, unknown> | undefined;
  const scope = { device: "A", transport: "s7commplus", address: "192.168.250.1", epoch: 1 };
  vi.spyOn(trust, "onlineHost").mockResolvedValue({ onEvent() {}, close: async () => {}, request: async (method: string, params: Record<string, unknown>) => {
    if (method === "online.connect") { credentials = params; return { sessionId: "s", scope }; }
    if (method === "online.read") return { at: 1, scope, items: [{ name: "x", value: 0 }] };
    return {};
  } } as unknown as Awaited<ReturnType<typeof trust.onlineHost>>);
  const env = { RUNG_PLC_USER: "reader", RUNG_PLC_PASSWORD: "secret" };
  const server = await startLiveServer(root, env);
  closing.push(() => server.close());
  const reader = await brokerReader(root, env, {});
  closing.push(() => reader.close());
  await reader.read(["x"]);
  expect(credentials).toMatchObject({ user: "reader", password: "secret" });
});
it("routes diagnostics to the explicitly selected PLC fallback in a multi-PLC workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-broker-test-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["A", "B"]);
  config.live = { plc: { A: { transport: "s7commplus", address: "192.168.250.1", allowWrites: false,
    webapi: { url: "https://192.168.250.1", user: "reader" } } } };
  await saveConfig(root, config);
  const diag = vi.spyOn(WebApiClient.prototype, "diagnosticBuffer").mockResolvedValue([]);
  vi.spyOn(WebApiClient.prototype, "logout").mockResolvedValue(undefined);
  const errors: string[] = [];
  expect(await main(["live", "diag", "--device", "A", "--transport", "webapi"], {
    cwd: root, env: { RUNG_WEBAPI_PASSWORD: "secret" }, stdout: () => {}, stderr: s => errors.push(s),
  })).toBe(0);
  expect(errors).toEqual([]);
  expect(diag).toHaveBeenCalledOnce();
});
it("shares a broker read session and releases socket subscription leases", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-broker-test-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]);
  config.live = { plc: { PLC_1: { transport: "s7commplus", address: "192.168.250.1", allowWrites: false, certificateSha256: "a".repeat(64) } } };
  await saveConfig(root, config);
  const scope = { device: "PLC_1", transport: "s7commplus" as const, address: "192.168.250.1", epoch: 1 };
  const released = vi.fn(async () => {});
  const factory = vi.fn(async () => ({
    read: async (names: string[]) => ({ at: 1, scope, items: names.map((name) => ({ name, value: 7 })) }),
    subscribe: async (names: string[], _cycle: number, cb: (frame: any) => void) => { cb({ at: 1, scope, items: names.map((name) => ({ name, value: 7 })) }); return { close: released }; },
    close: async () => {},
    subscribeAlarms: async (_lcid: number, cb: (frame: any) => void) => { cb({ at: 1, scope, alarms: [], connectionState: "connected" }); return { close: released }; },
  }));
  const server = await startLiveServer(root, {}, { backendFactory: factory, idleMs: 60_000 });
  closing.push(() => server.close());
  const a = await brokerReader(root, {}, {}), b = await brokerReader(root, {}, {});
  closing.push(() => b.close(), () => a.close());
  expect(await a.read(["x"])).toEqual([{ name: "x", value: 7 }]);
  expect(await b.read(["x"])).toEqual([{ name: "x", value: 7 }]);
  expect(factory).toHaveBeenCalledTimes(1);
  let got: unknown;
  await a.subscribe!({ label: "x" }, 250, (frame) => { got = frame; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(got).toMatchObject({ values: { label: 7 }, scope });
  await a.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(released).toHaveBeenCalled();
  await expect(a.subscribe!({ label: "x" }, 250, () => {})).rejects.toThrow(/closed/);
  const received: any[] = [];
  await b.subscribe!({ label: "x" }, 250, frame => { received.push(frame); });
  const alarms: any[] = [];
  await b.subscribeAlarms!(1033, frame => { alarms.push(frame); });
  await server.close();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(received.at(-1)).toMatchObject({ state: "disconnected", values: { label: 7 }, errors: { label: "Live broker disconnected" } });
  expect(alarms.at(-1)).toMatchObject({ connectionState: "disconnected", errorCode: "OWNER_GONE", alarms: [] });
});
it("rejects ambiguous pinned targets before starting a broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-broker-test-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["A", "B"]);
  await saveConfig(root, config);
  await expect(brokerReader(root, {}, {})).rejects.toThrow(/device/);
});
it("uses an explicit Web API fallback for the chosen PLC and refuses a conflicting source scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-broker-test-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["A", "B"]);
  config.live = { plc: { A: { transport: "s7commplus", address: "192.168.250.1", allowWrites: false, certificateSha256: "a".repeat(64), webapi: { url: "https://192.168.250.1", user: "reader" } } } };
  await saveConfig(root, config);
  expect(await liveSelection(root, { device: "A", transport: "webapi" })).toMatchObject({ device: "A", transport: "webapi", target: { address: "192.168.250.1" } });
  await expect(liveSelection(root, { device: "A", file: "plc/B/blocks/X.scl" })).rejects.toThrow(/conflicts/);
  await expect(webApiFor(root, { RUNG_WEBAPI_PASSWORD: "secret" }, { device: "A", transport: "webapi" })).resolves.toBeDefined();
  await expect(webApiFor(root, { RUNG_WEBAPI_PASSWORD: "secret" }, { device: "A" })).rejects.toThrow(/transport webapi/);
});

it("native captures belong to the client's existing value-reader lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-native-broker-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["A"]);
  config.live = { plc: { A: { transport: "s7commplus", address: "192.168.250.1", allowWrites: false, certificateSha256: "a".repeat(64) } } };
  await saveConfig(root, config);
  const scope = { device: "A", address: "192.168.250.1", transport: "s7commplus" as const, epoch: 1 };
  const native: OnlineNativeCapture = { scope, coherence: "subscription-sample", capture: { bodies: [], scalars: [], route: { instance: "DB", database: 4, functionBlock: 4, sac: 118, compilationUnit: "1", element: "258" }, codeSignature: "signature", samples: [] } };
  const capture = vi.fn(async () => native);
  const server = await startLiveServer(root, {}, { backendFactory: async () => ({ capture, read: async () => ({ at: 10, scope, items: [] }),
    subscribe: async (_names, _cycle, push) => { push({ at: 10, scope, items: [{ name: "X", value: 1 }] }); return { close: async () => {} }; }, close: async () => {} }) });
  closing.push(() => server.close());
  const a = await brokerReader(root, {}, { device: "A" }), b = await brokerReader(root, {}, { device: "A" });
  closing.push(() => a.close(), () => b.close());
  const lease = await a.subscribe!({ x: "X" }, 250, () => {});
  expect(await a.capture!("F", "DB", scope)).toEqual(native);
  await expect(b.capture!("F", "DB", scope)).rejects.toThrow(/reader/i);
  await lease.close();
  await expect(a.capture!("F", "DB", scope)).rejects.toThrow(/reader/i);
  expect(capture).toHaveBeenCalledOnce();
});
