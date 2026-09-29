// SPDX-License-Identifier: BUSL-1.1
// rung live: read-only access to a running S7-1500 through its Web API.
import { WorkspaceError, loadConfig } from "@rung/core";
import { WebApiClient } from "@rung/live";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkspaceIndex, uriOf } from "@rung/lsp";
import { findWorkspace, type Io } from "./common.js";
import { monitorPlan, type MonitorPlan } from "./monitor.js";

export async function webApiFor(dir: string, env: Io["env"]): Promise<WebApiClient> {
  const ws = await findWorkspace(dir);
  const config = await loadConfig(ws);
  const w = config.live?.webapi;
  if (!w) throw new WorkspaceError("CONFIG_INVALID", 'no [live.webapi] in rung.toml (url = "https://<plc-ip>", user = "<web server user>")');
  const password = env.RUNG_WEBAPI_PASSWORD;
  if (!password) throw new WorkspaceError("CONFIG_INVALID", "set RUNG_WEBAPI_PASSWORD for the PLC web server user (it is never stored in rung.toml)");
  // the Web API login sends the password; over plain http anyone on the network can read it
  const loopback = /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(w.url); // rung simulate: nothing leaves the PC
  if (/^http:\/\//i.test(w.url) && !loopback && env.RUNG_WEBAPI_ALLOW_HTTP !== "1")
    throw new WorkspaceError("CONFIG_INVALID", `${w.url} is plain http: the password would travel unencrypted. Use https:// (set insecure = true for the PLC's self-signed certificate), or set RUNG_WEBAPI_ALLOW_HTTP=1 if you really mean it`);
  return new WebApiClient({ url: w.url, user: w.user, password, ...(w.insecure ? { insecure: true } : {}) });
}

export interface LiveOptions {
  file?: string;
  instance?: string;
  json?: boolean;
  intervalMs?: number;
}

export async function cmdLive(dir: string, sub: string | undefined, args: string[], io: Io, opts: LiveOptions = {}): Promise<number> {
  if (sub !== "read" && sub !== "diag" && sub !== "watch") {
    io.stderr('rung: usage: rung live read "<DB>".<member> ... | rung live watch --file <block> [--instance <DB>] | rung live diag\n');
    return 1;
  }
  // the plan comes first: a block that cannot be monitored needs no PLC connection to say so
  const plan = sub === "watch" ? await watchPlan(dir, io, opts) : undefined;
  const client = await webApiFor(dir, io.env);
  try {
    if (plan) return await watchValues(client, plan, io, opts);
    return await liveRun(client, sub, args, io);
  } catch (e) {
    // network and PLC errors are expected here (wrong address, PLC off, wrong password): one clear line, no stack
    const err = e as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
    const code = err.cause?.code ?? err.code;
    const why =
      code === "ENOTFOUND" ? "the PLC address does not resolve" :
      code === "ECONNREFUSED" ? "the PLC refused the connection (web server off?)" :
      code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || err.name === "TimeoutError" || err.name === "AbortError" ? "the PLC did not answer in time" :
      code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ? "the PLC certificate is not trusted (set insecure = true under [live.webapi] for a self-signed certificate)" :
      err.message;
    io.stderr(`rung live: ${why}${code && !why.includes(String(code)) ? ` (${code})` : ""}\n`);
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
async function watchValues(client: WebApiClient, plan: MonitorPlan, io: Io, opts: LiveOptions): Promise<number> {
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
    const rows = await client.read(labels.map((l) => plan.vars[l]!));
    const values: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    rows.forEach((r, i) => (r.error ? (errors[labels[i]!] = r.error) : (values[labels[i]!] = r.value)));
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
