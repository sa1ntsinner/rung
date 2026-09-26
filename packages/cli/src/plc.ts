// SPDX-License-Identifier: BUSL-1.1
// rung compile / online / interfaces / download / open (docs/decisions/0002-plc-actions.md).
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join, relative, resolve, sep } from "node:path";
import { candidates, describe, notFoundMessage, reachable, saveTarget, targetOf, type Candidate } from "./connect.js";
import { WorkspaceError, loadConfig, type RungConfig } from "@rung/core";
import type { BridgeClient, CompileMessage, ConnectionOptions, ConnectionTarget, DownloadOutcome, OnlineStatus } from "@rung/bridge-client";
import { OwnerClient, placeCompileMessages } from "@rung/sync";
import { bridgeFor, findWorkspace, type Io } from "./common.js";

/**
 * Read-only view of .rung/state.json. These commands only look up paths and addresses, so they must not take
 * the state lock: rung watch holds it while it runs.
 */
async function snapshot(ws: string): Promise<{ address: string; path: string }[]> {
  try {
    const doc = JSON.parse(await readFile(join(ws, ".rung", "state.json"), "utf8")) as { objects?: Record<string, { address: string; path: string }> };
    return Object.values(doc.objects ?? {});
  } catch {
    return [];
  }
}

/** Calls the running rung watch when there is one (it owns the bridge), else starts a bridge for this call. */
async function viaOwnerOrBridge<T>(dir: string, config: RungConfig, io: Io, method: string, params: Record<string, unknown>, direct: (b: BridgeClient) => Promise<T>): Promise<T> {
  const owner = await OwnerClient.connect(dir);
  if (owner) {
    try {
      return await owner.request<T>(method, params);
    } finally {
      owner.close();
    }
  }
  const b = await bridgeFor(config, io);
  try {
    return await direct(b);
  } finally {
    await b.close();
  }
}

async function deviceOf(config: RungConfig, v: Record<string, unknown>): Promise<string> {
  const plc = v.plc as string | undefined;
  if (plc) return plc;
  if (config.devices.length === 1) return config.devices[0]!;
  if (Object.keys(config.plc).length === 1) return Object.keys(config.plc)[0]!;
  if (config.devices.length === 0) return "PLC_1";
  throw new WorkspaceError("CONFIG_INVALID", `this workspace mirrors several PLCs (${config.devices.join(", ")}); choose one with --plc`);
}

const canPrompt = (io: Io) => !!io.prompt || !!process.stdin.isTTY;

/**
 * The connection to use: the one in rung.toml, else (for going online) the one TIA Portal remembers, else the
 * PLC found on the network by its project address, which is then saved to rung.toml. Returns undefined when
 * TIA Portal's own remembered connection applies.
 */
async function ensureTarget(ws: string, config: RungConfig, io: Io, device: string, purpose: "online" | "download", force = false): Promise<ConnectionTarget | undefined> {
  const saved = targetOf(config, device);
  if (saved && !force) return saved;
  if (purpose === "online" && !force) {
    const quick = await viaOwnerOrBridge<ConnectionOptions>(ws, config, io, "connections", { device, scan: false }, (b) => b.connections(device, false));
    if (quick.configured) return undefined;
  }
  io.stderr(`rung: looking for ${device} on the network (up to half a minute)…\n`);
  const options = await viaOwnerOrBridge<ConnectionOptions>(ws, config, io, "connections", { device, scan: true }, (b) => b.connections(device, true));
  const all = candidates(options);
  const matches = all.filter((c) => c.reason === "address-match");
  const sims = all.filter((c) => c.reason === "simulation");
  let pick: Candidate | undefined = !force && matches.length === 1 ? matches[0] : !force && matches.length === 0 && sims.length === 1 ? sims[0] : undefined;
  if (!pick) {
    const choices = [...matches, ...sims, ...(matches.length ? [] : reachable(options))];
    if (!choices.length) throw new WorkspaceError("NO_TARGET", notFoundMessage(device, options));
    if (!canPrompt(io)) throw new WorkspaceError("NO_TARGET", `${choices.length} ways to reach ${device}: ${choices.map(describe).join("; ")}. Choose one with rung connect --pick (or rung connect --json for editors).`);
    io.stdout(`Where is ${device}?\n`);
    choices.forEach((c, i) => io.stdout(`  ${i + 1}) ${describe(c)}\n`));
    const answer = Number((await ask(io, `Number (1-${choices.length}): `)).trim());
    pick = choices[answer - 1];
    if (!pick) throw new WorkspaceError("NO_TARGET", "no connection chosen");
  }
  await saveTarget(ws, device, pick.target);
  io.stdout(`${device}: ${describe(pick)}; saved as [plc.${device}] in rung.toml\n`);
  return pick.target;
}

/** rung connect: find the PLC (or pick among what answers) and remember it; --json lists the choices for editors. */
export async function cmdConnect(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const { ws, config } = await workspace(dir);
  const device = await deviceOf(config, v);
  if (v.use) {
    const t: ConnectionTarget = { mode: (v.mode as string | undefined) ?? "PN/IE", pcInterface: String(v.use), pcInterfaceNumber: Number(v.number ?? 1), ...(v.target ? { targetInterface: String(v.target) } : {}) };
    await saveTarget(ws, device, t);
    io.stdout(`${device}: ${t.pcInterface}${t.targetInterface ? ` → ${t.targetInterface}` : ""}; saved as [plc.${device}] in rung.toml\n`);
    return 0;
  }
  if (v.json) {
    const options = await viaOwnerOrBridge<ConnectionOptions>(ws, config, io, "connections", { device, scan: true }, (b) => b.connections(device, true));
    const all = candidates(options);
    io.stdout(JSON.stringify({ device, saved: targetOf(config, device) ?? null, configuredInTia: options.configured, plcAddresses: options.plcAddresses, candidates: all.map((c) => ({ ...c, label: describe(c) })), reachable: reachable(options).map((c) => ({ ...c, label: describe(c) })), notFound: all.length ? null : notFoundMessage(device, options) }, null, 2) + "\n");
    return 0;
  }
  await ensureTarget(ws, config, io, device, "download", !!v.pick || !!targetOf(config, device));
  return 0;
}

async function workspace(dir: string) {
  const ws = await findWorkspace(dir);
  return { ws, config: await loadConfig(ws) };
}

async function printCompile(ws: string, _config: RungConfig, io: Io, raw: CompileMessage[]): Promise<number> {
  const objects = await snapshot(ws);
  const msgs: (CompileMessage & { file?: string })[] = await placeCompileMessages(ws, (a) => objects.find((o) => o.address === a)?.path, raw, (f) => readFile(f, "utf8"));
  let errors = 0;
  for (const m of msgs) {
    if (m.severity === "error" && !/^Compiling finished/.test(m.description)) errors++;
    const where = m.file ? `${m.file}${m.line ? `:${m.line}` : ""}` : m.address ?? "";
    io.stdout(`  ${m.severity.padEnd(8)} ${where}${where ? " — " : ""}${m.description.replace(/\s*\n\s*/g, " ")}\n`);
  }
  io.stdout(errors ? `compile: ${errors} error(s)\n` : "compile: ok\n");
  return errors ? 2 : 0;
}

export async function cmdCompile(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const { ws, config } = await workspace(dir);
  const device = await deviceOf(config, v);
  if (v.hw) {
    const msgs = await viaOwnerOrBridge<CompileMessage[]>(ws, config, io, "compileHardware", { device }, (b) => b.compileHardware(device));
    return printCompile(ws, config, io, msgs);
  }
  const files = ((v.file as string[] | undefined) ?? []).map((f) => relative(ws, resolve(io.cwd, f)).split(sep).join("/"));
  let addresses: string[] = [];
  if (files.length) {
    const objects = await snapshot(ws);
    addresses = files.map((f) => {
      const s = objects.find((x) => x.path === f);
      if (!s) throw new WorkspaceError("NOT_MIRRORED", `${f} is not a mirrored object (run rung sync first)`);
      return s.address;
    });
  }
  const msgs = await viaOwnerOrBridge<CompileMessage[]>(ws, config, io, "compile", { device, addresses }, (b) => b.compile(device, addresses));
  return printCompile(ws, config, io, msgs);
}

export async function cmdOnline(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const { ws, config } = await workspace(dir);
  const device = await deviceOf(config, v);
  const action = v.off ? "offline" : v.state ? "state" : "online";
  const target = action === "online" ? await ensureTarget(ws, config, io, device, "online") : targetOf(config, device);
  const s = await viaOwnerOrBridge<OnlineStatus>(ws, config, io, "online", { device, action, ...(target ? { target } : {}) }, (b) => b.online(device, action, target));
  io.stdout(`${s.device}: ${s.state}\n`);
  return action === "online" && s.state !== "Online" ? 2 : 0;
}

export async function cmdInterfaces(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const { ws, config } = await workspace(dir);
  const device = await deviceOf(config, v);
  const scan = !!v.scan;
  const c = await viaOwnerOrBridge<ConnectionOptions>(ws, config, io, "connections", { device, scan }, (b) => b.connections(device, scan));
  io.stdout(`${c.device}: ${c.configured ? "a connection is configured in TIA Portal" : "no connection configured in TIA Portal yet"}\n`);
  for (const m of c.modes) {
    io.stdout(`\nmode "${m.name}"\n`);
    for (const p of m.pcInterfaces) {
      io.stdout(`  pc_interface "${p.name}" (number ${p.number})${p.targetInterfaces.length ? `  targets: ${p.targetInterfaces.map((t) => `"${t}"`).join(", ")}` : ""}\n`);
      for (const d of p.accessible ?? []) io.stdout(`      reachable: ${d.name} ${d.address} ${d.deviceSeries}\n`);
    }
  }
  const first = c.modes.flatMap((m) => m.pcInterfaces.map((p) => ({ m, p }))).find(({ p }) => p.targetInterfaces.length);
  if (first) {
    io.stdout(`\nPut the one you use into rung.toml, for example:\n\n[plc.${device}]\nmode = "${first.m.name}"\npc_interface = "${first.p.name}"\npc_interface_number = ${first.p.number}\ntarget_interface = "${first.p.targetInterfaces[0]}"\n`);
  }
  return 0;
}

async function ask(io: Io, question: string): Promise<string> {
  if (io.prompt) return io.prompt(question);
  if (!process.stdin.isTTY) throw new WorkspaceError("CONFIG_INVALID", "rung download needs a terminal to confirm; pass --yes to confirm on the command line");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function cmdDownload(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const { ws, config } = await workspace(dir);
  if (!config.download.enabled) throw new WorkspaceError("CONFIG_INVALID", "downloads are turned off for this workspace (download.enabled = false in rung.toml)");
  const device = await deviceOf(config, v);
  const target = await ensureTarget(ws, config, io, device, "download");
  if (!target) throw new WorkspaceError("NO_TARGET", `no connection for ${device}: run rung connect`);
  const hardware = v.hw ? true : v["no-hw"] ? false : config.download.hardware;
  const software = !v["no-sw"];
  const onlyChanges = v["all-blocks"] ? false : config.download.onlyChanges;
  const allow = [...config.download.allow, ...((v.allow as string[] | undefined) ?? []).flatMap((a) => a.split(","))].map((a) => a.trim()).filter(Boolean);
  const startAfter = v["no-start"] ? false : config.download.startAfter;

  if (config.download.compileFirst && software) {
    const msgs = await viaOwnerOrBridge<CompileMessage[]>(ws, config, io, "compile", { device, addresses: [] }, (b) => b.compile(device, []));
    if ((await printCompile(ws, config, io, msgs)) !== 0) {
      io.stderr("rung download: the program has compile errors; nothing was downloaded\n");
      return 2;
    }
  }

  const what = [hardware ? "hardware" : "", software ? (onlyChanges ? "software (changes)" : "software (all blocks)") : ""].filter(Boolean).join(" + ");
  io.stdout(`\nDownload ${what} to ${device} via ${target.pcInterface}${target.targetInterface ? ` / ${target.targetInterface}` : ""}.\n`);
  if (allow.length) io.stdout(`Allowed answers: ${allow.join(", ")}\n`);
  if (!v.yes) {
    const answer = (await ask(io, config.download.confirm === "yes-no" ? "Continue? [y/N] " : `Type the PLC name (${device}) to download: `)).trim();
    const ok = config.download.confirm === "yes-no" ? /^y(es)?$/i.test(answer) : answer === device;
    if (!ok) {
      io.stdout("Nothing was downloaded.\n");
      return 1;
    }
  }

  const request = { device, hardware, software, onlyChanges, allow, startAfter, target };
  const r = await viaOwnerOrBridge<DownloadOutcome>(ws, config, io, "download", { request }, (b) => b.download(request));
  for (const d of r.decisions) {
    const mark = d.blocks ? "✗" : "✓";
    io.stdout(`  ${mark} ${d.phase.padEnd(4)} ${d.name.padEnd(26)} ${d.choice}${d.message ? `  (${d.message.replace(/\s*\n\s*/g, " ")})` : ""}\n`);
  }
  for (const m of r.messages) io.stdout(`  ${m.replace(/\s*\n\s*/g, " ")}\n`);
  if (r.state === "Cancelled") {
    io.stdout(`\nTIA Portal cancelled the download: it asked questions rung may not answer on its own.\nIf that is what you want, run again with --allow ${r.needsAllow.join(",")}\n`);
    return 3;
  }
  io.stdout(`\ndownload: ${r.state} (errors ${r.errors}, warnings ${r.warnings})\n`);
  return r.state === "Error" ? 2 : 0;
}

export async function cmdOpen(dir: string, file: string, io: Io): Promise<number> {
  const { ws, config } = await workspace(dir);
  const rel = relative(ws, resolve(io.cwd, file)).split(sep).join("/");
  const s = (await snapshot(ws)).find((x) => x.path === rel);
  if (!s) throw new WorkspaceError("NOT_MIRRORED", `${rel} is not a mirrored object`);
  await viaOwnerOrBridge(ws, config, io, "show", { address: s.address }, (b) => b.show(s.address));
  io.stdout(`opened ${s.address} in TIA Portal\n`);
  return 0;
}
