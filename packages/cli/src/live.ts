// SPDX-License-Identifier: BUSL-1.1
// rung live: read-only values of a running PLC: an S7-1500 through its Web API, CODESYS through rung's CODESYS bridge.
import { WorkspaceError, loadConfig, pathToAddress } from "@rung/core";
import { WebApiClient, plainHttpRefusal, loadWatchTable, watchTableVariables, type LiveFrame, type OnlineReadResult, type OnlineStateResult } from "@rung/live";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { WorkspaceIndex, uriOf, parseAbsolute, type MonitorValues } from "@rung/lsp";
import { bridgeFor, findWorkspace, type Io } from "./common.js";
import { OwnerClient } from "@rung/sync";
import { monitorPlan, monitorPlanIec, type MonitorPlan } from "./monitor.js";
import { onlineHost, trustLiveCertificate } from "./liveTrust.js";
import { brokerReader, liveSelection, type BackendOptions } from "./liveServer.js";
import type { MutationAction, MutationEvidence } from "@rung/live";
import type { OnlinePreparedWrite } from "@rung/bridge-client";
import type { OnlineAlarmResult, OnlineNativeCapture, LiveScope } from "@rung/bridge-client";
import { createInterface } from "node:readline/promises";
import { frontendConfirmation } from "./liveMutation.js";
import { reconstructionRevision } from "@rung/sim";
import { reconstructNativeSample } from "./liveReconstruction.js";

export async function webApiFor(dir: string, env: Io["env"], opts: BackendOptions = {}): Promise<WebApiClient> {
  const ws = await findWorkspace(dir);
  const config = await loadConfig(ws);
  let w = config.live?.webapi;
  if (Object.keys(config.live?.plc ?? {}).length) {
    const selected = await liveSelection(ws, opts);
    if (selected.transport !== "webapi") throw new WorkspaceError("CONFIG_INVALID", "Diagnostic buffer requires an explicit Web API fallback (--transport webapi)");
    w = selected.target.webapi;
  }
  if (!w) throw new WorkspaceError("CONFIG_INVALID", 'no [live.webapi] in rung.toml (url = "https://<plc-ip>", user = "<web server user>")');
  const password = env.RUNG_WEBAPI_PASSWORD;
  if (!password) throw new WorkspaceError("CONFIG_INVALID", "set RUNG_WEBAPI_PASSWORD for the PLC web server user (it is never stored in rung.toml)");
  const refused = plainHttpRefusal(w.url, env);
  if (refused) throw new WorkspaceError("CONFIG_INVALID", refused);
  return new WebApiClient({ url: w.url, user: w.user, password, ...(w.insecure ? { insecure: true } : {}) });
}

export interface LiveOptions {
  device?: string;
  transport?: string;
  file?: string;
  table?: string;
  instance?: string;
  json?: boolean;
  intervalMs?: number;
  /** --interval as typed, for the message when it is no number. */
  intervalText?: string;
  confirmStdin?: boolean;
  parentStdio?: boolean;
  lcid?: number;
  stream?: boolean;
}

export async function cmdLive(dir: string, sub: string | undefined, args: string[], io: Io, opts: LiveOptions = {}): Promise<number> {
  if (opts.parentStdio) {
    if (!opts.json || !(sub === "watch" || sub === "alarms" && opts.stream)) throw new WorkspaceError("BAD_ARGUMENT", "--parent-stdio requires a read-only JSON watch or alarm stream");
    const input = process.stdin;
    let stop!: () => void;
    const ended = new Promise<void>(resolve => { stop = resolve; });
    input.once("end", stop); process.once("SIGINT", stop);
    if (input.readableEnded) stop(); else input.resume();
    try { return await cmdLive(dir, sub, args, { ...io, stopSignal: io.stopSignal ? Promise.race([io.stopSignal, ended]) : ended }, { ...opts, parentStdio: false }); }
    finally { input.off("end", stop); process.off("SIGINT", stop); input.pause(); }
  }
  try {
  if (sub === "trust") return trustLiveCertificate(dir, io, opts.device);
  if (sub === "state" || sub === "alarms") {
    if (args.length || opts.file || opts.table) throw new WorkspaceError("BAD_ARGUMENT", "State and alarms require a PLC device, not variable arguments");
    const reader = await brokerReader(await findWorkspace(dir), io.env, opts);
    let lease: { close(): Promise<void> } | undefined;
    try {
      if (sub === "state") {
        const result = await reader.state!();
        io.stdout(opts.json ? JSON.stringify(result) + "\n" : `${result.scope.device} · ${result.scope.address} · ${result.identity.plcName}\n${result.state.mode}${result.state.cycleMs == null ? "" : ` · ${result.state.cycleMs} ms`}\n${result.state.memory?.map(m => `${m.name}: ${m.usedBytes}/${m.totalBytes} bytes`).join("\n") ?? "Memory unavailable"}\n`);
      } else {
        const print = (frame: OnlineAlarmResult) => io.stdout(opts.json ? JSON.stringify(frame) + "\n" : `${frame.scope.device} · ${frame.scope.address} · ${frame.connectionState ?? "connected"}\n${frame.alarms.map(a => `${a.active ? "ACTIVE" : "CLEARED"} ${a.id} · ${a.cpuTimestamp ?? "CPU time unavailable"} · ${a.text.replace(/[\x00-\x1f\x7f]/g, " ")}`).join("\n")}\n`);
        if (opts.stream) { lease = await reader.subscribeAlarms!(opts.lcid ?? 1033, print); await (io.stopSignal ?? new Promise<void>(r => process.once("SIGINT", r))); }
        else print(await reader.alarms!(opts.lcid ?? 1033));
      }
      return 0;
    } finally { try { await lease?.close(); } finally { await reader.close(); } }
  }
  if (sub === "modify" || sub === "run" || sub === "stop") {
    if (!opts.confirmStdin && !io.prompt && !process.stdin.isTTY) throw new WorkspaceError("BAD_ARGUMENT", "PLC mutation requires an interactive confirmation");
    if (sub === "modify" ? args.length !== 2 : args.length !== 0) throw new WorkspaceError("BAD_ARGUMENT", "Use live modify <name> <SCL-literal>, live run or live stop");
    const ws = await findWorkspace(dir);
    const selected = await liveSelection(ws, opts);
    const reader = await brokerReader(ws, io.env, opts);
    let operation: OnlinePreparedWrite | undefined;
    const rl = io.prompt || opts.confirmStdin ? undefined : createInterface({ input: process.stdin, output: process.stdout });
    try {
      operation = await reader.prepare!({ action: sub, ...(sub === "modify" ? { name: args[0]!, literal: args[1]! } : {}) });
      io.stdout(opts.confirmStdin ? JSON.stringify({ prepared: operation }) + "\n" : operation.preview.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "") + "\n");
      const question = `To confirm this PLC operation, type ${selected.device}: `;
      const confirmed = opts.confirmStdin ? await frontendConfirmation(process.stdin, operation)
        : await (io.prompt ? io.prompt(question) : rl!.question(question)) === selected.device;
      if (!confirmed) { await reader.cancel!(operation.operationId); io.stderr("PLC operation cancelled\n"); return 1; }
      const result = await reader.commit!(operation.operationId, operation.preview, true);
      io.stdout(opts.json ? JSON.stringify(result) + "\n" : `PLC operation ${result.outcome}\n`);
      return result.outcome === "acknowledged" ? 0 : 2;
    } finally { rl?.close(); if (operation) await reader.cancel!(operation.operationId).catch(() => {}); await reader.close(); }
  }
  if (sub !== "read" && sub !== "diag" && sub !== "watch") {
    io.stderr('rung: usage: rung live read "<DB>".<member> ... | rung live watch --file <block> [--instance <DB>] | rung live watch "<DB>".<member> ... | rung live diag\n');
    return 1;
  }
  // not a number would read the PLC without any pause between reads
  if (opts.intervalMs !== undefined && !Number.isFinite(opts.intervalMs))
    throw new WorkspaceError("BAD_ARGUMENT", `--interval is a number of milliseconds (--interval 500); got ${opts.intervalText ?? opts.intervalMs}`);
  if (opts.table) {
    if (sub !== "watch" || opts.file || args.length) throw new WorkspaceError("BAD_ARGUMENT", "--table requires live watch without --file or variable arguments");
    return watchTableFile(dir, io, opts);
  }
  if (sub === "watch") {
    const ws = await findWorkspace(dir);
    if ((await loadConfig(ws)).project.tiaVersion === "CODESYS") {
      if (!opts.file && args.length) throw new WorkspaceError("BAD_ARGUMENT", "pinned values come from a Siemens PLC's Web API; for CODESYS, watch a POU: rung live watch --file <POU file>");
      return await watchCodesys(ws, io, opts);
    }
  }
  // the plan comes first: a block that cannot be monitored needs no PLC connection to say so
  // rung live watch "DB".x Tag …: pinned values, read together every interval (the editor's Live Values)
  const plan = sub === "watch" ? (!opts.file && args.length ? { block: "pinned values", vars: Object.fromEntries(args.map((a) => [a, a])) } as MonitorPlan : await watchPlan(dir, io, opts)) : undefined;
  const ws = await findWorkspace(dir);
  if (sub !== "diag") {
    const reader = await brokerReader(ws, io.env, opts);
    try {
      if (plan) return await watchValues(reader.read, plan, io, opts, reader);
      if (!args.length) throw new WorkspaceError("BAD_ARGUMENT", "Name at least one variable");
      const frame = await reader.readFrame!(args);
      if (opts.json) io.stdout(JSON.stringify(frame) + "\n");
      else for (const row of frame.items) io.stdout(`${row.name}  ${row.error ? "ERROR " + row.error : row.display ?? JSON.stringify(row.value)}\n`);
      return frame.items.some((r) => r.error) ? 2 : 0;
    } catch (error) { io.stderr(`rung live ${opts.transport ?? "configured transport"}: ${liveError(error)}\n`); return 1; }
    finally { await reader.close(); }
  }
  const selected = await liveSelection(ws, opts);
  if (selected.transport === "s7commplus") {
    const reader = await brokerReader(ws, io.env, opts);
    try {
      const cpu = await reader.state!();
      let diagnosticBuffer: { provenance: string; available: boolean; entries?: unknown; reason?: string } = { provenance: "Web API diagnostic buffer", available: false, reason: "Configure the selected PLC's Web API fallback and credentials to read its diagnostic buffer" };
      if (selected.target.webapi && io.env.RUNG_WEBAPI_PASSWORD) {
        const fallback = await webApiFor(ws, io.env, { device: selected.device, transport: "webapi" });
        try { diagnosticBuffer = { provenance: "Web API diagnostic buffer", available: true, entries: await fallback.diagnosticBuffer() }; }
        catch { diagnosticBuffer.reason = "The selected PLC's Web API diagnostic buffer is unavailable"; }
        finally { await fallback.logout().catch(() => {}); }
      }
      io.stdout(JSON.stringify({ scope: cpu.scope, cpu, diagnosticBuffer }, null, 2) + "\n");
      return 0;
    } finally { await reader.close(); }
  }
  await liveSelection(ws, { ...opts, transport: "webapi" });
  const client = await webApiFor(dir, io.env, opts);
  try {
    if (plan) return await watchValues((names) => client.read(names), plan, io, opts);
    return await liveRun(client, sub, args, io, opts.json);
  } catch (e) {
    // network and PLC errors are expected here (wrong address, PLC off, wrong password): one clear line, no stack
    io.stderr(`rung live: ${liveError(e)}\n`);
    return 1;
  } finally {
    await client.logout().catch(() => undefined);
  }
  } catch (error) {
    if (opts.json && error instanceof WorkspaceError && error.code === "NO_INSTANCE") io.stdout(JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } }) + "\n");
    throw error;
  }
}

async function watchTableFile(dir: string, io: Io, opts: LiveOptions): Promise<number> {
  const ws = await findWorkspace(dir), file = resolve(io.cwd, opts.table!);
  const rel = relative(ws, file).split(sep).join("/");
  const device = /^plc\/([^/]+)\/watch\/[^/]+\.xml$/i.exec(rel)?.[1];
  if (!device || opts.device && device !== opts.device) throw new WorkspaceError("BAD_ARGUMENT", "--table must name a mirrored watch table of the selected PLC");
  const stop = io.stopSignal ?? new Promise<void>(r => process.once("SIGINT", r));
  let stopped = false, changed!: () => void;
  void stop.then(() => { stopped = true; changed?.(); });
  const host = await onlineHost(io.env);
  let watcher: ReturnType<typeof watch> | undefined;
  let editTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: LiveReader | undefined;
  try {
    watcher = watch(dirname(file), (_event, name) => {
      if (name && name.toString() !== basename(file)) return;
      if (editTimer) clearTimeout(editTimer);
      editTimer = setTimeout(() => changed?.(), 100);
    });
    while (!stopped) {
      const edited = new Promise<void>(r => { changed = r; });
      const table = await loadWatchTable(host, await readFile(file, "utf8"));
      const config = await loadConfig(ws);
      const native = (opts.transport ?? config.live?.plc?.[device]?.transport) === "s7commplus";
      const absoluteRows = Object.fromEntries(table.rows.flatMap(row => {
        const address = parseAbsolute(row.name?.trim() || row.address || "");
        return native && address && ["I", "Q", "M"].includes(address.area) && !address.peripheral && address.bits <= 32 ? [[row.key, address.address]] : [];
      }));
      const plan: MonitorPlan = { block: table.name, kind: "watchtable", table, lines: {}, ...watchTableVariables(table, absoluteRows) };
      reader ??= await brokerReader(ws, io.env, { ...opts, device, file: rel });
      await watchValues(reader.read, plan, { ...io, stopSignal: Promise.race([stop, edited]) }, opts, reader);
      if (!stopped) await Promise.race([stop, edited]);
    }
    return 0;
  } finally { watcher?.close(); if (editTimer) clearTimeout(editTimer); try { await reader?.close(); } finally { await host.close(); } }
}

async function watchPlan(dir: string, io: Io, opts: LiveOptions): Promise<MonitorPlan> {
  if (!opts.file) throw new WorkspaceError("BAD_ARGUMENT", "rung live watch needs --file <block file>");
  const ws = await findWorkspace(dir);
  const index = new WorkspaceIndex();
  await index.load(ws);
  const file = resolve(io.cwd, opts.file);
  const uri = uriOf(file);
  if (!index.docs.get(uri)) index.set(uri, await readFile(file, "utf8"), 0);
  return { ...monitorPlan(index, uri, opts.instance), sourceRevision: reconstructionRevision(index, uri) };
}

/** Reads the plan's variables every interval until stopped. */
export type Reader = (names: string[]) => Promise<{ name: string; value?: unknown; error?: string; display?: string }[]>;

/**
 * CODESYS: the values come from the application CODESYS runs, through rung's CODESYS bridge. While rung watch runs
 * it owns that bridge (and CODESYS's simulation lives in it); otherwise this command logs in with its own.
 */
async function watchCodesys(ws: string, io: Io, opts: LiveOptions): Promise<number> {
  if (!opts.file) throw new WorkspaceError("BAD_ARGUMENT", "rung live watch needs --file <POU file>");
  const index = new WorkspaceIndex();
  await index.load(ws);
  const file = resolve(io.cwd, opts.file);
  const uri = uriOf(file);
  if (!index.docs.get(uri)) index.set(uri, await readFile(file, "utf8"), 0);
  const plan = monitorPlanIec(index, uri, opts.instance);
  const reader = await liveReader(uri, io, ws, opts.file);
  try {
    return await watchValues(reader.read, plan, io, opts);
  } finally {
    await reader.close();
  }
}

export interface LiveReader {
  capture?(block: string, instance: string, scope: LiveScope): Promise<OnlineNativeCapture>;
  alarms?(lcid: number): Promise<OnlineAlarmResult>;
  subscribeAlarms?(lcid: number, callback: (frame: OnlineAlarmResult) => void): Promise<{ close(): Promise<void> }>;
  prepare?(action: MutationAction): Promise<OnlinePreparedWrite>;
  commit?(operationId: string, preview: string, confirmed: boolean): Promise<MutationEvidence>;
  cancel?(operationId: string): Promise<unknown>;
  read: Reader;
  readFrame?(names: string[]): Promise<OnlineReadResult>;
  subscribe?(labels: Record<string, string>, cycleMs: number, onFrame: (frame: LiveFrame) => void): Promise<{ close(): Promise<void> }>;
  state?(): Promise<OnlineStateResult>;
  close(): Promise<void>;
}

export async function liveReader(uri: string, io: Io, dir?: string, fileLabel = fileURLToPath(uri)): Promise<LiveReader> {
  const file = fileURLToPath(uri);
  const ws = dir ?? await findWorkspace(dirname(file));
  const config = await loadConfig(ws);
  if (config.project.tiaVersion !== "CODESYS") {
    return brokerReader(ws, io.env, { file: relative(ws, file).split(sep).join("/") });
  }
  const hit = pathToAddress(relative(ws, file).split(sep).join("/"));
  if (!hit) throw new WorkspaceError("BAD_ARGUMENT", fileLabel + " is not a mirrored object of this workspace");
  const device = hit.address.device;
  const owner = await OwnerClient.connect(ws);
  if (owner) return { read: (names) => owner.request("read", { device, expressions: names }), close: async () => owner.close() };
  const bridge = await bridgeFor(config, io);
  try {
    await bridge.online(device, "online", config.plc[device]);
    return { read: (names) => bridge.read(device, names), close: () => bridge.close() };
  } catch (error) {
    await bridge.close();
    throw error;
  }
}

export async function readMonitorValues(read: Reader, plan: Pick<MonitorPlan, "vars">): Promise<MonitorValues> {
  const labels = Object.keys(plan.vars);
  const rows = await read(labels.map((label) => plan.vars[label]!));
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const display: Record<string, string> = {};
  rows.forEach((row, i) => (row.error ? (errors[labels[i]!] = row.error) : (values[labels[i]!] = row.value)));
  rows.forEach((row, i) => { if (row.display !== undefined) display[labels[i]!] = row.display; });
  return { values, errors, ...(Object.keys(display).length ? { display } : {}) };
}

async function watchValues(read: Reader, plan: MonitorPlan, io: Io, opts: LiveOptions, reader?: LiveReader): Promise<number> {
  const labels = plan.table?.rows.map(row => row.key) ?? [...new Set([...Object.keys(plan.vars), ...Object.keys(plan.errors ?? {})])];
  const labelText = (key: string) => { const row = plan.table?.rows.find(r => r.key === key); return row ? `${key} ${row.name || row.address || "(empty)"}` : key; };
  if (opts.json) io.stdout(JSON.stringify({ plan }) + "\n");
  else io.stdout(`rung live watch: ${plan.block}${plan.instance ? ` through ${plan.instance}` : ""}, ${labels.length} values (Ctrl+C to stop)\n`);
  if (!Object.keys(plan.vars).length) {
    if (!opts.json) for (const label of labels) io.stdout(`  ${labelText(label)}  ERROR ${plan.errors?.[label]}\n`);
    return 0;
  }
  let stopped = false;
  // Ctrl+C in a terminal; an editor ends it by killing the process
  const stop = io.stopSignal ?? new Promise<void>((r) => process.once("SIGINT", () => r()));
  void stop.then(() => (stopped = true));
  const interval = Math.max(100, opts.intervalMs ?? 500);
  const programStatus = (state?: LiveFrame["state"]) => plan.kind === "FB" ? {
    kind: "unavailable", exact: false, coherence: "subscription-sample",
    reason: state && state !== "live" ? `PLC ${state}; cycle reconstruction is unavailable`
      : "Subscription observations lack complete pre-cycle state; use program-status with a cycle capture",
  } : undefined;
  if (reader?.subscribe) {
    let latest: LiveFrame | undefined, generation = 0, ready = false, capturing = false, attemptedAt = 0;
    let sourceWatcher: ReturnType<typeof watch> | undefined, sourceChanged = false;
    let nativeStatus: ReturnType<typeof reconstructNativeSample> | ReturnType<typeof programStatus>;
    let context: Promise<{ index: WorkspaceIndex; root: string; uri: string; revision: string }> | undefined;
    const publish = (frame: LiveFrame) => {
      if (stopped) return;
      frame = { ...frame, errors: { ...plan.errors, ...frame.errors } };
      if (opts.json) io.stdout(JSON.stringify({ ...frame, programStatus: frame.state === "live" ? nativeStatus ?? programStatus(frame.state) : programStatus(frame.state) }) + "\n");
      else io.stdout(labels.map((l) => `  ${labelText(l).padEnd(32)} ${l in frame.errors ? "ERROR " + frame.errors[l] : frame.display?.[l] ?? JSON.stringify(frame.values[l])}`).join("\n") + "\n\n");
    };
    const invalidateSource = () => {
      if (stopped || sourceChanged) return;
      sourceChanged = true; generation++;
      nativeStatus = { ...programStatus()!, reason: "Workspace source changed; restart monitoring" };
      if (latest) publish(latest);
    };
    const capture = async () => {
      if (!ready || stopped || sourceChanged || capturing || latest?.state !== "live" || !reader.capture || plan.kind !== "FB" || !plan.instance || !opts.file || Date.now() - attemptedAt < 5000) return;
      capturing = true; attemptedAt = Date.now();
      const owner = generation, expected = latest.scope;
      try {
        context ??= (async () => {
          const root = await findWorkspace(io.cwd), uri = uriOf(resolve(io.cwd, opts.file!)), index = new WorkspaceIndex();
          await index.load(root);
          if (!stopped) {
            sourceWatcher = watch(root, { recursive: true }, (_event, name) => {
              const file = name?.toString().replace(/\\/g, "/");
              if (!file) { invalidateSource(); return; }
              if (/^(?:\.rung|\.git|node_modules)\//i.test(file)) return;
              const device = /^plc\/([^/]+)\//i.exec(file)?.[1];
              if (device && device !== expected.device) return;
              if (file === "rung.toml" || /\.(?:scl|db|udt|awl|st|s7dcl|xml|yaml)$/i.test(file)) invalidateSource();
            });
            sourceWatcher.on("error", invalidateSource);
          }
          return { index, root, uri, revision: plan.sourceRevision ?? reconstructionRevision(index, uri) };
        })();
        const source = await context;
        if (stopped || owner !== generation) return;
        if (reconstructionRevision(source.index, source.uri) !== source.revision) throw new Error("Workspace source changed; restart monitoring");
        const instance = plan.instance.replace(/^"|"$/g, "");
        const record = await reader.capture(plan.block, instance, expected);
        const current = new WorkspaceIndex(); await current.load(source.root);
        if (stopped || owner !== generation) return;
        if (reconstructionRevision(current, source.uri) !== source.revision) throw new Error("Workspace source changed; restart monitoring");
        nativeStatus = reconstructNativeSample(current, source.uri, record, expected, instance);
      } catch (error) {
        if (stopped || owner !== generation) return;
        nativeStatus = { ...programStatus()!, reason: liveError(error) };
      } finally { capturing = false; }
      if (!stopped && owner === generation && latest) publish(latest);
    };
    const lease = await reader.subscribe(plan.vars, interval, (frame) => {
      if (stopped) return;
      if (latest && (frame.state !== latest.state || frame.scope.device !== latest.scope.device || frame.scope.address !== latest.scope.address
        || frame.scope.transport !== latest.scope.transport || frame.scope.epoch !== latest.scope.epoch)) { generation++; nativeStatus = undefined; }
      latest = frame; publish(frame); void capture();
    });
    ready = true; void capture();
    try { await stop; } finally { generation++; sourceWatcher?.close(); await lease.close(); }
    return 0;
  }
  while (!stopped) {
    // a read that fails (PLC off, network gone) is told for every value, and the loop goes on: it comes back
    let values: Record<string, unknown> = {};
    let errors: Record<string, string> = {};
    try {
      ({ values, errors } = await readMonitorValues(read, plan));
    } catch (e) {
      errors = Object.fromEntries(labels.map((l) => [l, liveError(e)]));
    }
    errors = { ...plan.errors, ...errors };
    if (opts.json) io.stdout(JSON.stringify({ at: Date.now(), values, ...(Object.keys(errors).length ? { errors } : {}), programStatus: programStatus() }) + "\n");
    else io.stdout(labels.map((l) => `  ${labelText(l).padEnd(32)} ${l in errors ? `ERROR ${errors[l]}` : JSON.stringify(values[l])}`).join("\n") + "\n\n");
    await Promise.race([stop, new Promise((r) => setTimeout(r, interval))]);
  }
  return 0;
}

async function liveRun(client: WebApiClient, sub: string, args: string[], io: Io, json = false): Promise<number> {
  {
    if (sub === "read") {
      if (!args.length) {
        io.stderr("rung: name at least one variable, e.g. rung live read '\"Fx_Global\".Counter'\n");
        return 1;
      }
      const rows = await client.read(args);
      if (json) io.stdout(JSON.stringify(rows) + "\n");
      else for (const r of rows) io.stdout(r.error ? `${r.name}  ERROR ${r.error}\n` : `${r.name}  ${JSON.stringify(r.value)}\n`);
      return rows.some((r) => r.error) ? 2 : 0;
    }
    io.stdout(JSON.stringify({ provenance: "Web API diagnostic buffer", entries: await client.diagnosticBuffer() }, null, 2) + "\n");
    return 0;
  }
}

export function liveError(error: unknown): string {
  const err = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
  const code = err.cause?.code ?? err.code;
  const why =
    code === "ENOTFOUND" ? "the PLC address does not resolve" :
    code === "ECONNREFUSED" ? "the PLC refused the connection (web server off?)" :
    code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || err.name === "TimeoutError" || err.name === "AbortError" ? "the PLC did not answer in time" :
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ? "the PLC certificate is not trusted (set insecure = true under [live.webapi] for a self-signed certificate)" :
    err.message;
  return why + (code && !why.includes(String(code)) && !(error instanceof WorkspaceError) ? " (" + code + ")" : "");
}
