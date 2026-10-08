// SPDX-License-Identifier: BUSL-1.1
// rung live: read-only values of a running PLC: an S7-1500 through its Web API, CODESYS through rung's CODESYS bridge.
import { WorkspaceError, loadConfig, pathToAddress } from "@rung/core";
import { WebApiClient, plainHttpRefusal } from "@rung/live";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import { WorkspaceIndex, uriOf, type MonitorValues } from "@rung/lsp";
import { bridgeFor, findWorkspace, type Io } from "./common.js";
import { OwnerClient } from "@rung/sync";
import { monitorPlan, monitorPlanIec, type MonitorPlan } from "./monitor.js";

export async function webApiFor(dir: string, env: Io["env"]): Promise<WebApiClient> {
  const ws = await findWorkspace(dir);
  const config = await loadConfig(ws);
  const w = config.live?.webapi;
  if (!w) throw new WorkspaceError("CONFIG_INVALID", 'no [live.webapi] in rung.toml (url = "https://<plc-ip>", user = "<web server user>")');
  const password = env.RUNG_WEBAPI_PASSWORD;
  if (!password) throw new WorkspaceError("CONFIG_INVALID", "set RUNG_WEBAPI_PASSWORD for the PLC web server user (it is never stored in rung.toml)");
  const refused = plainHttpRefusal(w.url, env);
  if (refused) throw new WorkspaceError("CONFIG_INVALID", refused);
  return new WebApiClient({ url: w.url, user: w.user, password, ...(w.insecure ? { insecure: true } : {}) });
}

export interface LiveOptions {
  file?: string;
  instance?: string;
  json?: boolean;
  intervalMs?: number;
  /** --interval as typed, for the message when it is no number. */
  intervalText?: string;
}

export async function cmdLive(dir: string, sub: string | undefined, args: string[], io: Io, opts: LiveOptions = {}): Promise<number> {
  if (sub !== "read" && sub !== "diag" && sub !== "watch") {
    io.stderr('rung: usage: rung live read "<DB>".<member> ... | rung live watch --file <block> [--instance <DB>] | rung live diag\n');
    return 1;
  }
  // not a number would read the PLC without any pause between reads
  if (opts.intervalMs !== undefined && !Number.isFinite(opts.intervalMs))
    throw new WorkspaceError("BAD_ARGUMENT", `--interval is a number of milliseconds (--interval 500); got ${opts.intervalText ?? opts.intervalMs}`);
  if (sub === "watch") {
    const ws = await findWorkspace(dir);
    if ((await loadConfig(ws)).project.tiaVersion === "CODESYS") return await watchCodesys(ws, io, opts);
  }
  // the plan comes first: a block that cannot be monitored needs no PLC connection to say so
  const plan = sub === "watch" ? await watchPlan(dir, io, opts) : undefined;
  const client = await webApiFor(dir, io.env);
  try {
    if (plan) return await watchValues((names) => client.read(names), plan, io, opts);
    return await liveRun(client, sub, args, io);
  } catch (e) {
    // network and PLC errors are expected here (wrong address, PLC off, wrong password): one clear line, no stack
    io.stderr(`rung live: ${liveError(e)}\n`);
    return 1;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function watchPlan(dir: string, io: Io, opts: LiveOptions): Promise<MonitorPlan> {
  if (!opts.file) throw new WorkspaceError("BAD_ARGUMENT", "rung live watch needs --file <block file>");
  const ws = await findWorkspace(dir);
  const index = new WorkspaceIndex();
  await index.load(ws);
  const file = resolve(io.cwd, opts.file);
  const uri = uriOf(file);
  if (!index.docs.get(uri)) index.set(uri, await readFile(file, "utf8"), 0);
  return monitorPlan(index, uri, opts.instance);
}

/** Reads the plan's variables every interval until stopped. */
export type Reader = (names: string[]) => Promise<{ name: string; value?: unknown; error?: string }[]>;

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
  read: Reader;
  close(): Promise<void>;
}

export async function liveReader(uri: string, io: Io, dir?: string, fileLabel = fileURLToPath(uri)): Promise<LiveReader> {
  const file = fileURLToPath(uri);
  const ws = dir ?? await findWorkspace(dirname(file));
  const config = await loadConfig(ws);
  if (config.project.tiaVersion !== "CODESYS") {
    const client = await webApiFor(ws, io.env);
    return { read: (names) => client.read(names), close: () => client.logout().catch(() => undefined) };
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
  rows.forEach((row, i) => (row.error ? (errors[labels[i]!] = row.error) : (values[labels[i]!] = row.value)));
  return { values, errors };
}

async function watchValues(read: Reader, plan: MonitorPlan, io: Io, opts: LiveOptions): Promise<number> {
  const labels = Object.keys(plan.vars);
  if (opts.json) io.stdout(JSON.stringify({ plan }) + "\n");
  else io.stdout(`rung live watch: ${plan.block}${plan.instance ? ` through ${plan.instance}` : ""}, ${labels.length} values (Ctrl+C to stop)\n`);
  if (!labels.length) return 0;
  let stopped = false;
  // Ctrl+C in a terminal; an editor ends it by killing the process
  const stop = io.stopSignal ?? new Promise<void>((r) => process.once("SIGINT", () => r()));
  void stop.then(() => (stopped = true));
  const interval = Math.max(100, opts.intervalMs ?? 500);
  while (!stopped) {
    const { values, errors } = await readMonitorValues(read, plan);
    if (opts.json) io.stdout(JSON.stringify({ at: Date.now(), values, ...(Object.keys(errors).length ? { errors } : {}) }) + "\n");
    else io.stdout(labels.map((l) => `  ${l.padEnd(32)} ${l in errors ? `ERROR ${errors[l]}` : JSON.stringify(values[l])}`).join("\n") + "\n\n");
    await Promise.race([stop, new Promise((r) => setTimeout(r, interval))]);
  }
  return 0;
}

async function liveRun(client: WebApiClient, sub: string, args: string[], io: Io): Promise<number> {
  {
    if (sub === "read") {
      if (!args.length) {
        io.stderr("rung: name at least one variable, e.g. rung live read '\"Fx_Global\".Counter'\n");
        return 1;
      }
      const rows = await client.read(args);
      for (const r of rows) io.stdout(r.error ? `${r.name}  ERROR ${r.error}\n` : `${r.name}  ${JSON.stringify(r.value)}\n`);
      return rows.some((r) => r.error) ? 2 : 0;
    }
    io.stdout(JSON.stringify(await client.diagnosticBuffer(), null, 2) + "\n");
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
