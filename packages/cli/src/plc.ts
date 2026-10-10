// SPDX-License-Identifier: BUSL-1.1
// rung compile / online / interfaces / download / open (docs/downloads.md).
import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { createInterface } from "node:readline/promises";
import { join, relative, resolve, sep } from "node:path";
import { addressChange, candidates, describe, notFoundMessage, reachable, saveTarget, targetOf, withNetworkAddress, type Candidate } from "./connect.js";
import { WorkspaceError, loadConfig, parseAddress, writeFileAtomic, type RungConfig } from "@rung/core";
import type { BridgeClient, CompareOutcome, CompileMessage, ConnectionOptions, ConnectionTarget, DownloadOutcome, OnlineCredentials, OnlineStatus, ProjectInfo, UploadOutcome, UploadRequest } from "@rung/bridge-client";
import { OwnerClient, placeCompileMessages, recordCompile } from "@rung/sync";
import { bridgeFor, findWorkspace, importFlags, type Io } from "./common.js";

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

/**
 * How one command talks to TIA Portal: through the running rung watch when there is one (it owns the bridge),
 * else through a single bridge started on first use and kept for the whole command, so a download that scans,
 * compiles and downloads starts TIA Portal once.
 */
class PlcLink {
  static readonly open = new Set<PlcLink>();
  private owner: OwnerClient | null | undefined;
  private bridge: Promise<BridgeClient> | undefined;

  constructor(
    private readonly ws: string,
    private readonly config: RungConfig,
    private readonly io: Io,
    /** Only rung download's own bridge may download (the bridge refuses plc.download without --allow-download). */
    private readonly download = false,
    /** Whether its own bridge may open the project in a TIA Portal without window ([tia] start). */
    private readonly headless = true,
    /** Its own bridge opens the project in a TIA Portal with window when none has it (rung open). */
    private readonly window = false,
  ) {
    PlcLink.open.add(this);
  }

  async call<T>(method: string, params: Record<string, unknown>, direct: (b: BridgeClient) => Promise<T>): Promise<T> {
    if (this.owner === undefined) this.owner = await OwnerClient.connect(this.ws);
    if (this.owner) return this.owner.request<T>(method, params);
    // a compile in a TIA Portal rung opened without a window is kept only if the project is saved when it closes;
    // that is a write into the project, so only where this workspace may write
    const save = this.config.sync.import === "auto" && !this.config.writesOff && this.config.sync.save !== "never";
    const config = this.headless ? this.config : { ...this.config, tia: { ...this.config.tia, start: "never" as const } };
    this.bridge ??= bridgeFor(config, this.io, [...(this.download && this.config.download.enabled ? ["--allow-download"] : []), ...(save ? ["--save-after-import"] : []), ...(this.window ? ["--open-window"] : [])]);
    return direct(await this.bridge);
  }

  async close(): Promise<void> {
    PlcLink.open.delete(this);
    this.owner?.close();
    const b = this.bridge;
    this.bridge = undefined;
    if (b) await (await b.catch(() => undefined))?.close();
  }
}

/** The PLC's password and user come from the environment; certificate consent belongs to this run only. */
function plcCredentials(io: Io, trustCertificate: boolean): OnlineCredentials | undefined {
  const password = io.env.RUNG_PLC_PASSWORD;
  return password || trustCertificate ? {
    ...(password ? { password, ...(io.env.RUNG_PLC_USER ? { user: io.env.RUNG_PLC_USER } : {}) } : {}),
    ...(trustCertificate ? { trustCertificate: true } : {}),
  } : undefined;
}

/** Ends the TIA connections the PLC commands opened; main calls it after every command. */
export async function closePlcLinks(): Promise<void> {
  await Promise.all([...PlcLink.open].map((l) => l.close()));
}

async function deviceOf(config: RungConfig, v: Record<string, unknown>, ws: string, link: PlcLink): Promise<string> {
  const plc = v.plc as string | undefined;
  if (plc) return plc;
  if (config.devices.length === 1) return config.devices[0]!;
  if (Object.keys(config.plc).length === 1) return Object.keys(config.plc)[0]!;
  // devices = [] mirrors every PLC of the project: the ones the workspace has objects of, else the project's own
  let mirrored = config.devices.length ? config.devices : [...new Set((await snapshot(ws)).map((o) => parseAddress(o.address).device))].sort();
  if (!mirrored.length) mirrored = (await link.call<ProjectInfo>("projectInfo", {}, (b) => b.projectInfo())).devices;
  if (mirrored.length === 1) return mirrored[0]!;
  if (!mirrored.length) throw new WorkspaceError("BAD_ARGUMENT", "the project has no PLC");
  throw new WorkspaceError("BAD_ARGUMENT", `this workspace mirrors several PLCs (${mirrored.join(", ")}); choose one with --plc`);
}

const canPrompt = (io: Io) => !!io.prompt || !!process.stdin.isTTY;

/**
 * The connection to use: the one in rung.toml, else (for going online) the one TIA Portal remembers, else the
 * PLC found on the network by its project address, which is then saved to rung.toml. Returns undefined when
 * TIA Portal's own remembered connection applies.
 */
async function ensureTarget(link: PlcLink, ws: string, config: RungConfig, io: Io, device: string, purpose: "online" | "connect" | "download", force = false, json = false): Promise<ConnectionTarget | undefined> {
  // a command's --json output is JSON only: what finding the PLC has to say goes to stderr
  const say = json ? io.stderr : io.stdout;
  const saved = targetOf(config, device);
  if (saved && !force) return saved;
  if (purpose === "online" && !force) {
    const quick = await link.call<ConnectionOptions>("connections", { device, scan: false }, (b) => b.connections(device, false));
    if (quick.configured) return undefined;
  }
  // Factory addresses repeat on every network (192.168.0.1, 192.168.1.1): another machine can answer at the
  // project's address. Going online only reads, but a download target is always chosen by a person.
  const auto = purpose !== "download";
  io.stderr(`rung: looking for ${device} on the network (up to half a minute)…\n`);
  const options = await link.call<ConnectionOptions>("connections", { device, scan: true }, (b) => b.connections(device, true));
  const all = candidates(options);
  const matches = all.filter((c) => c.reason === "address-match");
  const sims = all.filter((c) => c.reason === "simulation");
  let pick: Candidate | undefined = !auto || force ? undefined : matches.length === 1 ? matches[0] : matches.length === 0 && sims.length === 1 ? sims[0] : undefined;
  if (!pick) {
    const choices = [...matches, ...sims, ...(matches.length ? [] : reachable(options))];
    if (!choices.length) throw new WorkspaceError("NO_TARGET", notFoundMessage(device, options));
    if (!canPrompt(io))
      throw new WorkspaceError(
        "NO_TARGET",
        auto
          ? `${choices.length} ways to reach ${device}: ${choices.map(describe).join("; ")}. Choose one with rung connect --pick (or rung connect --json for editors).`
          : `rung never picks a PLC to download to by itself, and ${device} has no saved connection. Found: ${choices.map(describe).join("; ")}. Choose it with rung connect --pick (it is saved in rung.toml), then download.`,
      );
    say(auto ? `Where is ${device}?\n` : `Which PLC should ${device} be downloaded to? Check name and address; rung never picks one by itself.\n`);
    choices.forEach((c, i) => say(`  ${i + 1}) ${describe(c)}\n`));
    const answer = Number((await ask(io, `Number (1-${choices.length}): `)).trim());
    pick = choices[answer - 1];
    if (!pick) throw new WorkspaceError("NO_TARGET", "no connection chosen");
  }
  await saveTarget(ws, device, pick.target);
  say(`${device}: ${describe(pick)}; saved as [plc.${device}] in rung.toml\n`);
  const change = pick.found ? addressChange(options, pick.found.address) : undefined;
  if (change) {
    if (config.project.tiaVersion === "V21") {
      say(`V21 can go online at ${change.to}; the project stays unchanged.\n`);
      if (canPrompt(io) && /^y/i.test((await ask(io, `Go online at ${change.to} (save address in rung.toml)? [y/N] `)).trim())) {
        pick.target.address = change.to;
        await saveTarget(ws, device, pick.target);
      } else say(`To use it: rung connect --address ${change.to}\n`);
      return pick.target;
    }
    say(`The project gives ${device} ${change.from} (${change.interface}), and it answered at ${change.to}: TIA Portal goes online only at the project's address.\n`);
    if (canPrompt(io) && /^y/i.test((await ask(io, `Put ${change.to} into the project's network settings (plc/${device}/hardware/network.yaml)? [y/N] `)).trim())) await setAddress(ws, device, change, say);
    else say(`To use it: rung connect --address ${change.to}\n`);
  }
  return pick.target;
}

/** Writes the address into network.yaml; sync takes it to TIA Portal like any edit (writes on). */
async function setAddress(ws: string, device: string, change: { interface: string; from: string; to: string }, say: (s: string) => void): Promise<void> {
  const file = join(ws, "plc", device, "hardware", "network.yaml");
  const text = await readFile(file, "utf8").catch(() => {
    throw new WorkspaceError("NOT_MIRRORED", `plc/${device}/hardware/network.yaml is not mirrored yet: rung pull first`);
  });
  await writeFileAtomic(file, withNetworkAddress(text, device, change.interface, change.to));
  say(`plc/${device}/hardware/network.yaml: ${change.interface} ${change.from} → ${change.to}. rung sync takes it to TIA Portal (with writes on); then go online.\n`);
}

/** rung connect: find the PLC (or pick among what answers) and remember it; --json lists the choices for editors. */
/** --number: which of several PG/PC interfaces of one name. Not a number would be written into rung.toml as NaN, which no TOML reader takes. */
function interfaceNumber(v: Record<string, unknown>): number {
  const n = Number(v.number ?? 1);
  if (!Number.isInteger(n) || n < 1) throw new WorkspaceError("BAD_ARGUMENT", `--number is the number of the PG/PC interface (1 or more; rung interfaces lists them), not ${String(v.number)}`);
  return n;
}

/** A connection typed on the command line, as TIA Portal spells it; one TIA Portal does not offer is refused with what it does offer. */
function offeredTarget(t: ConnectionTarget, c: ConnectionOptions): ConnectionTarget {
  const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
  const refuse = (what: string, has: string[]) =>
    new WorkspaceError("BAD_ARGUMENT", `TIA Portal has no ${what} for ${c.device}; it has ${[...new Set(has)].join(", ") || "none"} (rung interfaces lists them; rung connect --pick chooses)`);
  const mode = c.modes.find((m) => same(m.name, t.mode));
  if (!mode) throw refuse(`mode "${t.mode}"`, c.modes.map((m) => `"${m.name}"`));
  const pc = mode.pcInterfaces.find((p) => same(p.name, t.pcInterface) && p.number === (t.pcInterfaceNumber ?? 1));
  if (!pc) throw refuse(`PG/PC interface "${t.pcInterface}" (${t.pcInterfaceNumber ?? 1}) in mode "${mode.name}"`, mode.pcInterfaces.map((p) => `"${p.name}" (${p.number})`));
  const target = t.targetInterface === undefined ? undefined : pc.targetInterfaces.find((x) => same(x, t.targetInterface!));
  if (t.targetInterface !== undefined && !target) throw refuse(`target interface "${t.targetInterface}" through "${pc.name}"`, pc.targetInterfaces.map((x) => `"${x}"`));
  return { ...t, mode: mode.name, pcInterface: pc.name, ...(target ? { targetInterface: target } : {}) };
}

export async function cmdConnect(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  if (v["project-address"] && !v.address) throw new WorkspaceError("BAD_ARGUMENT", "--project-address requires --address");
  const { ws, config, link } = await workspace(dir, io);
  const device = await deviceOf(config, v, ws, link);
  if (v.use) {
    const typed: ConnectionTarget = { mode: (v.mode as string | undefined) ?? "PN/IE", pcInterface: String(v.use), pcInterfaceNumber: interfaceNumber(v), ...(v.target ? { targetInterface: String(v.target) } : {}) };
    // checked against what TIA Portal offers now, not at the first online command; without TIA Portal, saved as typed
    // (CODESYS takes any gateway address: --use 192.168.1.10 --mode TCP)
    const offered =
      config.project.tiaVersion === "CODESYS"
        ? undefined
        : await link.call<ConnectionOptions>("connections", { device, scan: false }, (b) => b.connections(device, false)).catch((e: { code?: string }) => {
            if (["TIA_NOT_RUNNING", "NO_PROJECT"].includes(e.code ?? "")) return undefined;
            throw e;
          });
    const checked = offered !== undefined || config.project.tiaVersion === "CODESYS";
    const t = offered ? offeredTarget(typed, offered) : typed;
    await saveTarget(ws, device, t);
    io.stdout(`${device}: ${t.pcInterface}${t.targetInterface ? ` → ${t.targetInterface}` : ""}; saved as [plc.${device}] in rung.toml${checked ? "" : " (not checked: no TIA Portal has the project open)"}\n`);
    return 0;
  }
  if (v.address) {
    const ip = String(v.address);
    if (!isIPv4(ip)) throw new WorkspaceError("BAD_ARGUMENT", `${ip} is not an IP address such as 192.168.0.1`);
    if (config.project.tiaVersion === "V21" && !v["project-address"]) {
      const target = targetOf(config, device) ?? await ensureTarget(link, ws, config, io, device, "connect");
      if (!target) throw new WorkspaceError("NO_TARGET", "Choose a PG/PC interface with rung connect --pick first");
      await saveTarget(ws, device, { ...target, address: ip });
      io.stdout(`${device}: go online at ${ip}; saved in rung.toml, the project stays unchanged\n`);
      return 0;
    }
    const options = await link.call<ConnectionOptions>("connections", { device, scan: false }, (b) => b.connections(device, false));
    const change = addressChange(options, ip);
    if (!change) {
      io.stdout(`${device} already has ${ip} in the project\n`);
      return 0;
    }
    await setAddress(ws, device, change, io.stdout);
    return 0;
  }
  if (v.json) {
    const options = await link.call<ConnectionOptions>("connections", { device, scan: true }, (b) => b.connections(device, true));
    const all = candidates(options);
    const choice = (c: Candidate) => ({ ...c, label: describe(c), ...(c.found && addressChange(options, c.found.address) ? { addressChange: addressChange(options, c.found.address) } : {}) });
    io.stdout(JSON.stringify({ device, saved: targetOf(config, device) ?? null, configuredInTia: options.configured, plcAddresses: options.plcAddresses, candidates: all.map(choice), reachable: reachable(options).map(choice), notFound: all.length ? null : notFoundMessage(device, options) }, null, 2) + "\n");
    return 0;
  }
  await ensureTarget(link, ws, config, io, device, "connect", !!v.pick || !!targetOf(config, device));
  return 0;
}

async function workspace(dir: string, io: Io, download = false, headless = true, window = false) {
  const ws = await findWorkspace(dir);
  const config = await loadConfig(ws);
  return { ws, config, link: new PlcLink(ws, config, io, download, headless, window) };
}

async function printCompile(ws: string, _config: RungConfig, io: Io, raw: CompileMessage[], device: string, scope: string[] | "all" = "all"): Promise<number> {
  const objects = await snapshot(ws);
  const msgs: (CompileMessage & { file?: string })[] = await placeCompileMessages(ws, (a) => objects.find((o) => o.address === a)?.path, raw, (f) => readFile(f, "utf8"));
  // rung status, the editors and the next sync see what TIA Portal said (a forced delete's broken users too)
  const of = (a: string) => objects.find((o) => o.address === a) as { tiaFingerprint?: string; fileHash?: string } | undefined;
  await recordCompile(ws, device, scope, msgs, (a) => of(a)?.tiaFingerprint, (a) => of(a)?.fileHash).catch(() => undefined);
  let errors = 0;
  let warnings = 0;
  for (const m of msgs) {
    if (m.severity === "info" && /^No block was compiled/i.test(m.description)) continue;
    if (m.severity === "error") errors++;
    if (m.severity === "warning") warnings++;
    const where = m.file ? `${m.file}${m.line ? `:${m.line}` : ""}` : m.address ?? `PLC ${device}`;
    io.stdout(`  ${m.severity.padEnd(8)} ${where}${where ? " — " : ""}${m.description.replace(/\s*\n\s*/g, " ")}\n`);
  }
  io.stdout(errors ? `compile: ${errors} error(s)${warnings ? `, ${warnings} warning(s)` : ""}\n` : `compile: ok${warnings ? ` (${warnings} warning(s))` : ""}\n`);
  return errors ? 2 : 0;
}

export async function cmdCompile(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const { ws, config, link } = await workspace(dir, io);
  const device = await deviceOf(config, v, ws, link);
  if (v.hw) {
    const msgs = await link.call<CompileMessage[]>("compileHardware", { device }, (b) => b.compileHardware(device));
    return printCompile(ws, config, io, msgs, device, []);
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
  const msgs = await link.call<CompileMessage[]>("compile", { device, addresses }, (b) => b.compile(device, addresses));
  return printCompile(ws, config, io, msgs, device, addresses.length ? addresses : "all");
}

export async function cmdOnline(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const { ws, config, link } = await workspace(dir, io);
  const device = await deviceOf(config, v, ws, link);
  const action = v.off ? "offline" : v.state ? "state" : "online";
  const target = action === "online" ? await ensureTarget(link, ws, config, io, device, "online") : targetOf(config, device);
  const credentials = plcCredentials(io, v["trust-certificate"] === true);
  const s = await link.call<OnlineStatus>("online", { device, action, ...(target ? { target } : {}), ...(credentials ? { credentials } : {}) }, (b) => b.online(device, action, target, credentials));
  io.stdout(`${s.device}: ${s.state}\n`);
  return action === "online" && s.state !== "Online" ? 2 : 0;
}

const COMPARE_LABEL: Record<string, string> = { Different: "differs", OnlyInProject: "only in project", OnlyOnPlc: "only on PLC" };

/** rung compare: the project against the PLC, read-only. Exit 0 when they match, 2 when they differ. */
export async function cmdCompare(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const { ws, config, link } = await workspace(dir, io);
  const device = await deviceOf(config, v, ws, link);
  const target = await ensureTarget(link, ws, config, io, device, "online", false, !!v.json);
  const credentials = plcCredentials(io, v["trust-certificate"] === true);
  const r = await link.call<CompareOutcome>("compare", { device, ...(target ? { target } : {}), ...(credentials ? { credentials } : {}) }, (b) => b.compare(device, target, credentials));
  const objects = await snapshot(ws);
  const items = r.items.map((i) => ({ ...i, file: i.address ? objects.find((o) => o.address === i.address)?.path : undefined }));
  if (v.json) {
    io.stdout(JSON.stringify({ ...r, items }, null, 2) + "\n");
    return items.length ? 2 : 0;
  }
  if (!items.length) {
    io.stdout(`${device}: the PLC runs what the project has (${r.identical} objects compared)\n`);
    return 0;
  }
  const count = (s: string) => items.filter((i) => i.state === s).length;
  io.stdout(`${device}: ${count("Different")} differ, ${count("OnlyInProject")} only in the project, ${count("OnlyOnPlc")} only on the PLC; ${r.identical} identical\n\n`);
  // TIA's generic "Objects are different." adds nothing to the label
  const detail = (d?: string | null) => (d && !/^Objects are (different|identical)\.?\s*$/i.test(d) ? ` — ${d.trim()}` : "");
  for (const i of items) io.stdout(`  ${(COMPARE_LABEL[i.state] ?? i.state).padEnd(16)} ${i.file ?? i.path}${detail(i.detail)}\n`);
  return 2;
}

export async function cmdInterfaces(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const { ws, config, link } = await workspace(dir, io);
  const device = await deviceOf(config, v, ws, link);
  const scan = !!v.scan;
  const c = await link.call<ConnectionOptions>("connections", { device, scan }, (b) => b.connections(device, scan));
  io.stdout(`${c.device}: ${c.configured ? "a connection is configured in TIA Portal" : "no connection configured in TIA Portal yet"}\n`);
  for (const m of c.modes) {
    io.stdout(`\nmode "${m.name}"\n`);
    for (const p of m.pcInterfaces) {
      io.stdout(`  pc_interface "${p.name}" (number ${p.number})${p.targetInterfaces.length ? `  targets: ${p.targetInterfaces.map((t) => `"${t}"`).join(", ")}` : ""}\n`);
      for (const d of p.accessible ?? []) io.stdout(`      reachable: ${d.name} ${d.address} ${d.deviceSeries}\n`);
    }
  }
  // suggest an interface that reaches a PLC, else Ethernet, else whatever there is
  const all = c.modes.flatMap((m) => m.pcInterfaces.map((p) => ({ m, p }))).filter(({ p }) => p.targetInterfaces.length);
  const first = all.find(({ p }) => p.accessible?.length) ?? all.find(({ m }) => m.name === "PN/IE") ?? all[0];
  if (first) {
    io.stdout(`\nPut the one you use into rung.toml, for example:\n\n[plc.${device}]\nmode = "${first.m.name}"\npc_interface = "${first.p.name}"\npc_interface_number = ${first.p.number}\ntarget_interface = "${first.p.targetInterfaces[0]}"\n`);
  }
  return 0;
}

async function ask(io: Io, question: string): Promise<string> {
  if (io.prompt) return io.prompt(question);
  if (!process.stdin.isTTY) throw new WorkspaceError("BAD_ARGUMENT", "rung download needs a terminal to confirm; pass --yes to confirm on the command line");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function cmdDownload(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const { ws, config, link } = await workspace(dir, io, true);
  if (!config.download.enabled) throw new WorkspaceError("CONFIG_INVALID", "downloads are turned off for this workspace (download.enabled = false in rung.toml)");
  const hardware = v.hw ? true : v["no-hw"] ? false : config.download.hardware;
  const software = !v["no-sw"];
  // before the PLC is looked for on the network
  if (!hardware && !software) throw new WorkspaceError("BAD_ARGUMENT", "--no-sw leaves nothing to download: add --hw to download the hardware configuration");
  const device = await deviceOf(config, v, ws, link);
  const target = await ensureTarget(link, ws, config, io, device, "download");
  if (!target) throw new WorkspaceError("NO_TARGET", `no connection for ${device}: run rung connect`);
  const onlyChanges = v["all-blocks"] ? false : config.download.onlyChanges;
  const allow = [...config.download.allow, ...((v.allow as string[] | undefined) ?? []).flatMap((a) => a.split(","))].map((a) => a.trim()).filter(Boolean);
  const startAfter = v["no-start"] ? false : config.download.startAfter;

  if (config.download.compileFirst && software) {
    const msgs = await link.call<CompileMessage[]>("compile", { device, addresses: [] }, (b) => b.compile(device, []));
    if ((await printCompile(ws, config, io, msgs, device)) !== 0) {
      io.stderr("rung download: the program has compile errors; nothing was downloaded\n");
      return 2;
    }
  }

  const what = [hardware ? "hardware" : "", software ? (onlyChanges ? "software (changes)" : "software (all blocks)") : ""].filter(Boolean).join(" + ");
  io.stdout(`\nDownload ${what} to ${device}${target.address ? ` at ${target.address}` : ""} via ${target.pcInterface}${target.targetInterface ? ` / ${target.targetInterface}` : ""}.\n`);
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
  // confirmed: the PLC the person typed (or passed --yes for); rung watch refuses a download without it
  let r: DownloadOutcome;
  try {
    r = await link.call<DownloadOutcome>("download", { request, confirmed: device }, (b) => b.download(request));
  } catch (e) {
    // lost while TIA Portal downloads (timeout, the bridge or TIA Portal gone): nobody knows how far it got
    io.stderr(`rung download: ${(e as { code?: string }).code ?? "ERROR"}: ${(e as Error).message}\nrung cannot tell how far the download to ${device} got. rung online --state and rung compare show what ${device} runs now.\n`);
    return 5;
  }
  for (const d of r.decisions) {
    const mark = d.blocks ? "✗" : "✓";
    io.stdout(`  ${mark} ${d.phase.padEnd(4)} ${d.name.padEnd(26)} ${d.choice}${d.message ? `  (${d.message.replace(/\s*\n\s*/g, " ")})` : ""}\n`);
  }
  // on a cancel TIA adds "Download configuration '…' was unhandled"; the decisions above already say what happened
  for (const m of r.messages) if (!(r.state === "Cancelled" && /was unhandled/.test(m))) io.stdout(`  ${m.replace(/\s*\n\s*/g, " ")}\n`);
  // TIA Portal asks before the transfer ("pre") and after it ("post", e.g. start the CPU): what rung says about the
  // PLC follows the phase, never just the state
  const afterTransfer = r.decisions.some((d) => d.phase === "post");
  if (r.state === "Cancelled") {
    const blockedAfter = r.decisions.some((d) => d.blocks && d.phase === "post");
    if (blockedAfter) {
      io.stdout(`\nThe download reached ${device}. Afterwards TIA Portal asked something rung may not answer on its own, so ${device} may be in STOP: check it in TIA Portal or with rung online --state.\nTo answer it next time: --allow ${r.needsAllow.join(",")}\n`);
      return 4;
    }
    io.stdout(`\nNothing was downloaded: before the transfer TIA Portal asked questions rung may not answer on its own.\nIf that is what you want, run again with --allow ${r.needsAllow.join(",")}\n`);
    return 3;
  }
  io.stdout(`\ndownload: ${r.state} (errors ${r.errors}, warnings ${r.warnings})\n`);
  if (r.state === "Error" && afterTransfer) io.stdout(`The transfer had started: ${device} may hold part of the download. rung compare shows what it runs now.\n`);
  return r.state === "Error" ? 2 : 0;
}

export async function cmdOpen(dir: string, file: string, io: Io, save = false): Promise<number> {
  // a TIA Portal without window has no editors: the bridge opens the project in one with window, or moves it there
  // from rung's keeper; with no TIA Portal at all it starts one with window
  const { ws, link } = await workspace(dir, io, false, false, true);
  const rel = relative(ws, resolve(io.cwd, file)).split(sep).join("/");
  const s = (await snapshot(ws)).find((x) => x.path === rel);
  if (!s) throw new WorkspaceError("NOT_MIRRORED", `${rel} is not a mirrored object`);
  try {
    await link.call("show", { address: s.address, save }, (b) => b.show(s.address, save));
  } catch (e) {
    if ((e as { code?: string }).code === "PROJECT_UNSAVED")
      throw new WorkspaceError("PROJECT_UNSAVED", `${(e as Error).message.replace(/\s*Save them to go on.*$/, "")} To save them and open it: rung open ${rel} --save`);
    throw e;
  }
  io.stdout(`opened ${s.address} in TIA Portal\n`);
  return 0;
}

/** Inspect or release an existing portal, through watch when it owns the workspace. */
export async function cmdSession(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  if (v.save && !v.release) throw new WorkspaceError("BAD_ARGUMENT", "--save requires --release");
  if (v.discard && !v.release) throw new WorkspaceError("BAD_ARGUMENT", "--discard requires --release");
  if (v.save && v.discard) throw new WorkspaceError("BAD_ARGUMENT", "--save and --discard cannot be used together");
  const { config, link } = await workspace(dir, io, false, false);
  if (v.release) {
    const r = await link.call(v.discard ? "sessionDiscard" : "sessionRelease", { save: !!v.save }, (b) => b.releaseSession(!!v.save, !!v.discard));
    io.stdout(v.json ? JSON.stringify(r) + "\n" : "released the project from rung's background TIA Portal\n");
  } else {
    const r = await link.call("sessionState", {}, (b) => b.sessionState()).catch((e: { code?: string }) => {
      if (["TIA_NOT_RUNNING", "NO_PROJECT"].includes(e.code ?? "")) return { projectPath: config.project.path, open: false as const };
      throw e;
    });
    const report = r.open === false ? { projectPath: r.projectPath, open: false, ...("keeperPid" in r && r.keeperPid ? { keeperPid: r.keeperPid } : {}) } : r;
    io.stdout(v.json ? JSON.stringify(report, null, 2) + "\n" : r.open === false
      ? `${r.projectPath}\nNo TIA Portal has the project open; ${"keeperPid" in r && r.keeperPid ? `keeper record exists (${r.keeperPid})` : "no keeper record"}.\n`
      : `${r.projectPath}\nTIA Portal ${r.tiaPid}: ${r.mode}, held by ${r.heldBy}${r.keeperPid ? ` (${r.keeperPid})` : ""}, ${r.attachedSessions} attached sessions\n`);
  }
  return 0;
}

/** --use/--mode/--number of rung connect name the PG/PC interface; without --use the bridge takes the only one. */
export function uploadRequest(address: string, v: Record<string, unknown>): UploadRequest {
  if (!isIPv4(address)) throw new WorkspaceError("BAD_ARGUMENT", `${address} is not an IP address such as 192.168.0.1`);
  return { address, ...(v.mode ? { mode: String(v.mode) } : {}), ...(v.use ? { pcInterface: String(v.use), pcInterfaceNumber: interfaceNumber(v) } : {}) };
}

/** Prints what an upload brought; exit 3 when no station came. */
export function reportUpload(io: Io, r: UploadOutcome, address: string): number {
  for (const m of r.messages) io.stdout(`  ${m}\n`);
  if (!r.station) {
    io.stderr(`rung: nothing was uploaded from ${address} (${r.state})\n`);
    return 3;
  }
  if (r.saveError) {
    io.stderr(
      r.stationRemoved
        ? `rung: the station "${r.station}" was read from ${address}, but the project could not be saved (${r.saveError}), so rung took the station out again: the project is as it was. Fix the cause (disk space, the folder's permissions) and upload again.\n`
        : `rung: the station "${r.station}" was read from ${address}, but the project could not be saved (${r.saveError}), and rung could not take the station out again. It is in the project unsaved: look at the project in TIA Portal before uploading again, which would add a second station.\n`,
    );
    return 3;
  }
  io.stdout(`uploaded the station "${r.station}" from ${address}${r.plcs.length ? `: ${r.plcs.join(", ")}` : ""} (${r.state})\n`);
  return 0;
}

/**
 * TIA Portal's "Upload device as new station": the PLC at --ip becomes a station of the bound project (hardware
 * and program), and the project is saved. The PLC is only read. Next, rung pull mirrors its program.
 */
export async function cmdUpload(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  if (!v.ip) throw new WorkspaceError("BAD_ARGUMENT", "rung upload needs --ip <address of the PLC>");
  const request = uploadRequest(String(v.ip), v);
  const ws = await findWorkspace(dir);
  const config = await loadConfig(ws);
  // the project gains a station: allowed where the workspace may write into it (sync.import = "auto", writes on)
  if (config.writesOff) throw new WorkspaceError("WRITES_OFF", "rung upload adds a station to the project, and writes to TIA Portal are off in this workspace: rung writes on first");
  const client = await bridgeFor(config, io, importFlags(config));
  try {
    io.stderr(`reading the station at ${request.address} into the project (the PLC is only read) …\n`);
    const code = reportUpload(io, await client.upload(request), request.address);
    if (code === 0) io.stdout("Next: rung pull\n");
    return code;
  } finally {
    await client.close();
  }
}
