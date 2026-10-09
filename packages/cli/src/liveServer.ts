// SPDX-License-Identifier: BUSL-1.1
import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { loadConfig, WorkspaceError } from "@rung/core";
import { BridgeError, type OnlineAlarmResult } from "@rung/bridge-client";
import { OwnerClient, OwnerServer } from "@rung/sync";
import { LiveHub, createS7Backend, createWebApiBackend, selectLiveTarget, WebApiClient, plainHttpRefusal, type LiveBackend, type LiveFrame, type OnlineReadResult } from "@rung/live";
import { onlineHost } from "./liveTrust.js";
import type { Io } from "./common.js";
import type { LiveReader } from "./live.js";
import { rungCommand } from "./paths.js";
import { liveMutations } from "./liveMutation.js";

export interface BackendOptions { device?: string; file?: string; transport?: string }
export async function liveSelection(root: string, options: BackendOptions) {
  const config = await loadConfig(root);
  if (!Object.keys(config.live?.plc ?? {}).length) {
    const w = config.live?.webapi;
    if (!w) throw new WorkspaceError("CONFIG_INVALID", 'no [live.webapi] in rung.toml or [live.plc.<device>] live target');
    const devices = [...new Set([...config.devices, ...Object.keys(config.plc), ...(await readdir(resolve(root, "plc")).catch(() => []))])];
    if (devices.length > 1) throw new WorkspaceError("CONFIG_INVALID", "Legacy [live.webapi] is ambiguous; configure [live.plc.<device>] for each PLC");
    const device = devices[0] ?? options.device;
    if (!device || (options.device && device !== options.device)) throw new WorkspaceError("CONFIG_INVALID", "Choose --device <PLC>; the workspace has no unambiguous live target");
    if (options.transport && options.transport !== "webapi") throw new WorkspaceError("CONFIG_INVALID", "Legacy [live.webapi] only supports --transport webapi");
    return { device, transport: "webapi", target: { transport: "webapi" as const, address: new URL(w.url).hostname, allowWrites: false, webapi: w } };
  }
  const selected = selectLiveTarget(config, { ...options, ...(options.file ? { file: relative(root, resolve(root, options.file)).split(sep).join("/") } : {}) });
  const transport = options.transport ?? selected.target.transport;
  if (transport !== "webapi" && transport !== "s7commplus") throw new WorkspaceError("BAD_ARGUMENT", "--transport must be s7commplus or webapi");
  if (transport === "webapi" && !selected.target.webapi) throw new WorkspaceError("CONFIG_INVALID", `No Web API configured for ${selected.device}`);
  return { ...selected, transport };
}

export async function startLiveServer(root: string, env: Io["env"], options: { backendFactory?: (key: string) => Promise<LiveBackend>; idleMs?: number } = {}) {
  const credentials = new Map<string, { user?: string; password?: string }>();
  const mutations = liveMutations(root, env, options => liveSelection(root, options));
  const hub = new LiveHub(options.backendFactory ?? (async (key) => {
    const selected = await liveSelection(root, JSON.parse(key) as BackendOptions);
    const auth = credentials.get(key) ?? {};
    if (selected.transport === "s7commplus") {
      const host = await onlineHost(env);
      const user = auth.user ?? selected.target.user;
      try { return await createS7Backend(host, { device: selected.device, address: selected.target.address, certificateSha256: selected.target.certificateSha256 ?? "", ...(user ? { user } : {}), ...(auth.password ? { password: auth.password } : {}) }); }
      catch (error) { await host.close(); throw error; }
    }
    const w = selected.target.webapi!;
    if (!auth.password) throw new WorkspaceError("CONFIG_INVALID", "set RUNG_WEBAPI_PASSWORD for the PLC web server user");
    const refused = plainHttpRefusal(w.url, env);
    if (refused) throw new WorkspaceError("CONFIG_INVALID", refused);
    return createWebApiBackend(new WebApiClient({ ...w, password: auth.password }), { device: selected.device, address: selected.target.address, transport: "webapi", epoch: 1 });
  }));
  const leases = new Map<string, { clientId: string; close(): Promise<void> }>();
  const opening = new Set<string>();
  const consumers = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const idle = () => { clearTimeout(timer); if (!consumers.size && !closed) timer = setTimeout(() => void close(), options.idleMs ?? 30_000); };
  const touch = (clientId: string) => { consumers.add(clientId); clearTimeout(timer); };
  const bind = async (p: Record<string, unknown>) => {
    if (typeof p.key !== "string") throw new BridgeError("BAD_REQUEST", "Missing live target");
    const selected = await liveSelection(root, JSON.parse(p.key) as BackendOptions);
    const auth = (p.credentials ?? {}) as { user?: string; password?: string };
    if ([auth.user, auth.password].some(value => value !== undefined && (typeof value !== "string" || value.length > 4096))) throw new BridgeError("BAD_REQUEST", "Invalid live credentials");
    if (p.key !== liveKey(selected, auth.user)) throw new BridgeError("CONFIG_INVALID", "Live target configuration changed; start monitoring again");
    if (!credentials.has(p.key) && credentials.size >= 256) throw new BridgeError("RESOURCE_LIMIT", "Too many live targets");
    credentials.set(p.key, auth);
    return p.key;
  };
  const server = await OwnerServer.start(root, {
    prepare: async (p, c) => {
      touch(c.clientId);
      const key = await bind(p);
      const operation = await mutations.prepare(c.clientId, JSON.parse(key), p.action as Parameters<typeof mutations.prepare>[2], credentials.get(key)!);
      if (!consumers.has(c.clientId) || closed) { await mutations.cancel(c.clientId, operation.operationId); throw new BridgeError("BRIDGE_EXITED", "Client disconnected during preparation"); }
      return operation;
    },
    commit: async (p, c) => mutations.commit(c.clientId, String(p.operationId), String(p.preview), p.confirmed === true),
    cancel: async (p, c) => mutations.cancel(c.clientId, String(p.operationId)),
    read: async (p, c) => { touch(c.clientId); return hub.read(await bind(p), p.names as string[]); },
    state: async (p, c) => { touch(c.clientId); return hub.state(await bind(p)); },
    alarms: async (p, c) => { touch(c.clientId); return hub.alarms(await bind(p), Number(p.lcid)); },
    alarmLease: async (p, c) => {
      touch(c.clientId);
      const id = String(p.id);
      if (!/^[a-f0-9-]{36}$/i.test(id) || opening.has(id) || leases.has(id) || leases.size + opening.size >= 256) throw new BridgeError("BAD_REQUEST", "Invalid or duplicate alarm subscription ID");
      opening.add(id);
      try {
        const lease = await hub.subscribeAlarms(await bind(p), Number(p.lcid), frame => server.emitTo(c.clientId, "alarms", { id, frame }));
        if (!consumers.has(c.clientId) || closed) await lease.close(); else leases.set(id, { clientId: c.clientId, close: lease.close });
        return { id };
      } finally { opening.delete(id); }
    },
    lease: async (p, c) => {
      touch(c.clientId);
      const id = String(p.id);
      if (!/^[a-f0-9-]{36}$/i.test(id) || opening.has(id) || leases.has(id)) throw new BridgeError("BAD_REQUEST", "Invalid or duplicate subscription ID");
      if (leases.size + opening.size >= 256) throw new BridgeError("RESOURCE_LIMIT", "Too many broker subscriptions");
      opening.add(id);
      try {
        const lease = await hub.subscribe(await bind(p), p.labels as Record<string, string>, Number(p.cycleMs), (frame) => server.emitTo(c.clientId, "values", { id, subscriptionId: id, frame }));
        if (!consumers.has(c.clientId) || closed) await lease.close();
        else leases.set(id, { clientId: c.clientId, close: lease.close });
        return { id };
      } finally { opening.delete(id); }
    },
    release: async (p, c) => { const lease = leases.get(String(p.id)); if (lease?.clientId === c.clientId) { leases.delete(String(p.id)); await lease.close(); } return {}; },
  }, { service: "live", onDisconnect: (clientId) => {
    consumers.delete(clientId);
    void mutations.disconnect(clientId);
    for (const [id, lease] of leases) if (lease.clientId === clientId) { leases.delete(id); void lease.close().catch(() => {}); }
    idle();
  } });
  async function close() { if (closed) return; closed = true; clearTimeout(timer); await server.close(); await mutations.close(); await hub.close(); credentials.clear(); }
  idle();
  return { close };
}

function liveKey(selected: Awaited<ReturnType<typeof liveSelection>>, user?: string): string {
  return JSON.stringify({ device: selected.device, transport: selected.transport, target: selected.target, user: user ?? selected.target.user ?? "" });
}

export async function brokerReader(root: string, env: Io["env"], options: BackendOptions): Promise<LiveReader> {
  const selected = await liveSelection(root, options); // refuse ambiguous scope before starting a process
  if (selected.transport === "webapi") {
    if (!env.RUNG_WEBAPI_PASSWORD) throw new WorkspaceError("CONFIG_INVALID", "set RUNG_WEBAPI_PASSWORD for the PLC web server user");
    const refused = plainHttpRefusal(selected.target.webapi!.url, env);
    if (refused) throw new WorkspaceError("CONFIG_INVALID", refused);
  }
  const credentials = selected.transport === "s7commplus" ? { user: env.RUNG_PLC_USER ?? selected.target.user, password: env.RUNG_PLC_PASSWORD } : { password: env.RUNG_WEBAPI_PASSWORD };
  const key = liveKey(selected, credentials.user);
  let owner = await OwnerClient.connect(root, { service: "live" });
  if (!owner) {
    const inv = rungCommand(["live-server", root], env);
    const childEnv = { ...process.env, ...env, ...inv.env };
    delete childEnv.RUNG_PLC_PASSWORD; delete childEnv.RUNG_PLC_USER; delete childEnv.RUNG_WEBAPI_PASSWORD;
    const child = spawn(inv.command, inv.args, { detached: true, stdio: "ignore", windowsHide: true, env: childEnv });
    child.on("error", () => {});
    child.unref();
    for (let i = 0; i < 100 && !owner; i++) { await new Promise((r) => setTimeout(r, 50)); owner = await OwnerClient.connect(root, { service: "live" }); }
  }
  if (!owner) throw new WorkspaceError("CONFIG_INVALID", "The live broker could not start; build the CLI packages first");
  const client = owner;
  const listeners = new Map<string, (frame: LiveFrame) => void>();
  const alarmListeners = new Map<string, (frame: OnlineAlarmResult) => void>();
  const alarmLatest = new Map<string, OnlineAlarmResult>();
  const latest = new Map<string, LiveFrame>();
  let closed = false;
  await client.subscribe((event, params) => {
    if (closed) return;
    if (event === "disconnect") {
      for (const [id, cb] of alarmListeners) { const frame = alarmLatest.get(id); if (frame) cb({ ...frame, at: Date.now(), connectionState: "disconnected", errorCode: "OWNER_GONE" }); }
      for (const [id, cb] of listeners) {
        const frame = latest.get(id);
        if (frame) cb({ ...frame, at: Date.now(), state: "disconnected", errors: Object.fromEntries(Object.keys(frame.values).concat(Object.keys(frame.errors)).map(name => [name, "Live broker disconnected"])) });
      }
      return;
    }
    const p = params as { id: string; frame: LiveFrame };
    if (event === "alarms") { const alarm = params as { id: string; frame: OnlineAlarmResult }; if (alarmListeners.has(alarm.id)) { alarmLatest.set(alarm.id, alarm.frame); alarmListeners.get(alarm.id)!(alarm.frame); } }
    if (event === "values" && listeners.has(p.id)) { latest.set(p.id, p.frame); listeners.get(p.id)!(p.frame); }
  });
  const readFrame = (names: string[]) => client.request<OnlineReadResult>("read", { key, names, credentials });
  return {
    alarms: lcid => client.request("alarms", { key, lcid, credentials }),
    subscribeAlarms: async (lcid, callback) => {
      if (closed) throw new BridgeError("BRIDGE_EXITED", "Live reader is closed");
      const id = randomUUID(); alarmListeners.set(id, callback);
      try { await client.request("alarmLease", { id, key, lcid, credentials }); }
      catch (error) { alarmListeners.delete(id); alarmLatest.delete(id); throw error; }
      if (closed) { alarmListeners.delete(id); alarmLatest.delete(id); await client.request("release", { id }).catch(() => {}); throw new BridgeError("BRIDGE_EXITED", "Live reader is closed"); }
      return { close: async () => { alarmLatest.delete(id); if (!alarmListeners.delete(id) || closed) return; try { await client.request("release", { id }); } catch (error) { if ((error as { code?: string }).code !== "OWNER_GONE") throw error; } } };
    },
    prepare: action => client.request("prepare", { key, action, credentials }),
    commit: (operationId, preview, confirmed) => client.request("commit", { operationId, preview, confirmed }),
    cancel: operationId => client.request("cancel", { operationId }),
    readFrame, read: async (names) => (await readFrame(names)).items,
    subscribe: async (labels, cycleMs, cb) => {
      if (closed) throw new BridgeError("BRIDGE_EXITED", "Live reader is closed");
      const id = randomUUID(); listeners.set(id, cb);
      try { await client.request("lease", { id, key, labels, cycleMs, credentials }); }
      catch (error) { listeners.delete(id); latest.delete(id); throw error; }
      if (closed) { listeners.delete(id); await client.request("release", { id }).catch(() => {}); throw new BridgeError("BRIDGE_EXITED", "Live reader is closed"); }
      return { close: async () => {
        latest.delete(id); if (!listeners.delete(id) || closed) return;
        try { await client.request("release", { id }); }
        catch (error) { if ((error as { code?: string }).code !== "OWNER_GONE") throw error; }
      } };
    },
    state: () => client.request("state", { key, credentials }),
    close: async () => { if (closed) return; closed = true; const ids = [...listeners.keys(), ...alarmListeners.keys()]; listeners.clear(); alarmListeners.clear(); alarmLatest.clear(); latest.clear(); await Promise.allSettled(ids.map(id => client.request("release", { id }))); client.close(); },
  };
}
