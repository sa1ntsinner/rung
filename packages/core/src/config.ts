// SPDX-License-Identifier: BUSL-1.1
import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { writeFileAtomic } from "./atomic.js";
import { WorkspaceError } from "./errors.js";
import { readWrites, writesGranted } from "./writes.js";

export interface RungConfig {
  format: 1;
  /** tiaVersion "CODESYS": a CODESYS project (.project) through rung's CODESYS bridge */
  project: { path: string; tiaVersion: EngineeringVersion };
  /** command "" = the bridge that comes with rung, found at run time (an absolute path would pin one install) */
  /**
   * host: the Windows PC that runs TIA Portal, as ssh reaches it ("elmir@tia-pc"); rung then starts the bridge there
   * (command, default `rung bridge`) and files cross the connection. For Linux and macOS.
   */
  bridge: { command: string; args: string[]; host?: string };
  /** PLC aliases (TIA device names) mirrored into plc/<alias>/. Empty = all PLCs of the project. */
  devices: string[];
  sync: {
    pollMs: number;
    detect: "fingerprint" | "vci";
    compile: "affected" | "none" | "all";
    delete: "confirm" | "never";
    import: "auto" | "manual";
    /** Save the TIA project after each import (default), so a TIA crash cannot undo rung's writes. */
    save: "after-import" | "never";
    /** Weak revisions (dates) are re-verified by export + hash after this many ms. */
    weakVerifyMs: number;
    /**
     * "daily": before the first write of each day, TIA Portal archives the project (.zap, Project → Retrieve opens it);
     * if it cannot, nothing is written. "off": no archive.
     */
    backup: "daily" | "off";
    /** Where the archives go, on the PC that runs TIA Portal (default %LOCALAPPDATA%\rung\backups\<project>). */
    backupDir?: string;
  };
  readOnly: { failsafe: true; knowHow: true; system: true; graph: true };
  /** How rung reaches TIA Portal: start = "headless" opens the project in a TIA Portal without window when none has it open. */
  tia: { start: "headless" | "never" };
  /** Connection per PLC for online and download ([plc.<device>] in rung.toml; see rung interfaces). */
  plc: Record<string, PlcConnection>;
  /** How downloads behave (docs/downloads.md). A person always starts a download. */
  download: DownloadSettings;
  /** Optional live-data sources (read-only). Passwords never live in rung.toml: RUNG_WEBAPI_PASSWORD. */
  live?: { webapi?: LiveWebApiConfig; plc?: Record<string, LivePlcConfig> };
  /**
   * Not in rung.toml: set by loadConfig when sync.import is "auto" but this copy of the workspace was not given the
   * right to write into its project (`rung writes on`, kept in .rung/writes.json); sync.import then reads "manual".
   */
  writesOff?: true;
}

export interface LiveWebApiConfig { url: string; user: string; insecure?: boolean }
export interface LivePlcConfig {
  transport: "s7commplus" | "webapi";
  address: string;
  allowWrites: boolean;
  certificateSha256?: string;
  user?: string;
  webapi?: LiveWebApiConfig;
}

export interface PlcConnection {
  address?: string;
  mode: string;
  pcInterface: string;
  pcInterfaceNumber: number;
  targetInterface?: string;
}

export interface DownloadSettings {
  /** false turns rung download off for this workspace */
  enabled: boolean;
  /** TIA questions answered with "yes" without --allow, e.g. ["stop-cpu"]. Empty by default. */
  allow: string[];
  /** Start the CPU again after a download that stopped it. */
  startAfter: boolean;
  /** Download changed software only (true) or all software. */
  onlyChanges: boolean;
  /** Include the hardware configuration by default. */
  hardware: boolean;
  /** How rung download asks: type the PLC name, or answer y. --yes skips it. */
  confirm: "type-name" | "yes-no";
  /** Compile before downloading and stop on errors. */
  compileFirst: boolean;
}

export const CONFIG_FILE = "rung.toml";

export type EngineeringVersion = "V19" | "V20" | "V21" | "CODESYS";
export const ENGINEERING_VERSIONS: readonly EngineeringVersion[] = ["V19", "V20", "V21", "CODESYS"];

export function defaultConfig(projectPath: string, tiaVersion: EngineeringVersion, bridgeCommand = "", devices: string[] = []): RungConfig {
  return {
    format: 1,
    project: { path: projectPath, tiaVersion },
    bridge: { command: bridgeCommand, args: [] },
    devices,
    sync: { pollMs: 2000, detect: "fingerprint", compile: "affected", delete: "confirm", import: "auto", save: "after-import", weakVerifyMs: 3_600_000, backup: "daily" },
    readOnly: { failsafe: true, knowHow: true, system: true, graph: true },
    tia: { start: "headless" },
    plc: {},
    download: { enabled: true, allow: [], startAfter: true, onlyChanges: true, hardware: false, confirm: "type-name", compileFirst: true },
  };
}

function fail(msg: string): never {
  throw new WorkspaceError("CONFIG_INVALID", `rung.toml: ${msg}`);
}

function table(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be a table`);
  return value as Record<string, unknown>;
}

function parseWebApi(value: unknown, path: string): LiveWebApiConfig {
  const v = table(value, path);
  if ("password" in v) fail(`${path}.password must not be stored in rung.toml; use RUNG_WEBAPI_PASSWORD`);
  let url: URL;
  try { url = new URL(String(v.url)); } catch { fail(`${path}.url must be an http(s) URL`); }
  if (typeof v.url !== "string" || !["http:", "https:"].includes(url.protocol) || url.username || url.password) fail(`${path}.url must be an http(s) URL without credentials`);
  if (typeof v.user !== "string" || !v.user) fail(`${path}.user is required`);
  if (v.insecure !== undefined && typeof v.insecure !== "boolean") fail(`${path}.insecure must be true or false`);
  return { url: v.url, user: v.user, ...(v.insecure !== undefined ? { insecure: v.insecure as boolean } : {}) };
}

export function parseConfig(text: string): RungConfig {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (e) {
    fail(String(e));
  }
  if (raw.format !== 1) fail(`unsupported format ${String(raw.format)}`);
  const project = raw.project as Record<string, unknown> | undefined;
  if (!project || typeof project.path !== "string" || !project.path) fail("project.path is required");
  if (!ENGINEERING_VERSIONS.includes(project.tiaVersion as EngineeringVersion)) fail("project.tiaVersion must be V19, V20, V21 or CODESYS");
  const bridge = (raw.bridge ?? {}) as Record<string, unknown>;
  if (bridge.command !== undefined && typeof bridge.command !== "string") fail("bridge.command must be a path");
  if (bridge.host !== undefined && (typeof bridge.host !== "string" || !/^[^\s"']+$/.test(bridge.host))) fail("bridge.host must be an ssh destination such as elmir@tia-pc");
  const base = defaultConfig(project.path, project.tiaVersion as EngineeringVersion, (bridge.command as string | undefined) ?? "");
  const sync = { ...base.sync, ...((raw.sync as object) ?? {}) } as RungConfig["sync"];
  if (!(sync.pollMs >= 250)) fail("sync.pollMs must be >= 250");
  if (!["fingerprint", "vci"].includes(sync.detect)) fail("sync.detect must be fingerprint or vci");
  if (!["affected", "none", "all"].includes(sync.compile)) fail("sync.compile must be affected, none or all");
  if (!["confirm", "never"].includes(sync.delete)) fail("sync.delete must be confirm or never");
  if (!["auto", "manual"].includes(sync.import)) fail("sync.import must be auto or manual");
  if (!["after-import", "never"].includes(sync.save)) fail("sync.save must be after-import or never");
  if (!["daily", "off"].includes(sync.backup)) fail("sync.backup must be daily or off");
  if (sync.backupDir !== undefined && typeof sync.backupDir !== "string") fail("sync.backupDir must be a folder path");
  const plc: Record<string, PlcConnection> = {};
  for (const [name, v] of Object.entries((raw.plc ?? {}) as Record<string, Record<string, unknown>>)) {
    if (typeof v !== "object" || v === null) fail(`plc.${name} must be a table`);
    if (typeof v.mode !== "string" || typeof v.pc_interface !== "string") fail(`plc.${name} needs mode and pc_interface (run rung interfaces)`);
    const n = v.pc_interface_number ?? 1;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) fail(`plc.${name}.pc_interface_number must be a positive integer`);
    if (v.target_interface !== undefined && typeof v.target_interface !== "string") fail(`plc.${name}.target_interface must be a string`);
    if (v.address !== undefined && (typeof v.address !== "string" || !isIPv4(v.address))) fail(`plc.${name}.address must be an IPv4 address`);
    plc[name] = { mode: v.mode, pcInterface: v.pc_interface, pcInterfaceNumber: n, ...(typeof v.target_interface === "string" ? { targetInterface: v.target_interface } : {}), ...(typeof v.address === "string" ? { address: v.address } : {}) };
  }
  const rawDl = (raw.download ?? {}) as Record<string, unknown>;
  const download: DownloadSettings = {
    enabled: rawDl.enabled ?? base.download.enabled,
    allow: rawDl.allow ?? base.download.allow,
    startAfter: rawDl.start_after ?? base.download.startAfter,
    onlyChanges: rawDl.only_changes ?? base.download.onlyChanges,
    hardware: rawDl.hardware ?? base.download.hardware,
    confirm: rawDl.confirm ?? base.download.confirm,
    compileFirst: rawDl.compile_first ?? base.download.compileFirst,
  } as DownloadSettings;
  for (const k of ["enabled", "startAfter", "onlyChanges", "hardware", "compileFirst"] as const) if (typeof download[k] !== "boolean") fail(`download.${k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())} must be true or false`);
  if (!Array.isArray(download.allow) || !download.allow.every((a) => typeof a === "string")) fail("download.allow must be a list of names such as \"stop-cpu\"");
  if (!["type-name", "yes-no"].includes(download.confirm)) fail("download.confirm must be type-name or yes-no");
  const rawTia = (raw.tia ?? {}) as Record<string, unknown>;
  const tia = { start: (rawTia.start ?? base.tia.start) as RungConfig["tia"]["start"] };
  if (!["headless", "never"].includes(tia.start)) fail('tia.start must be "headless" or "never"');
  const devices = raw.devices ?? [];
  if (!Array.isArray(devices) || !devices.every((d) => typeof d === "string" && d)) fail("devices must be a list of names");
  const ro = (raw.readOnly ?? {}) as Record<string, unknown>;
  for (const k of ["failsafe", "knowHow", "system", "graph"]) if (ro[k] === false) fail(`readOnly.${k} cannot be disabled in this version`);
  let live: RungConfig["live"];
  if (raw.live !== undefined) {
    const v = table(raw.live, "live");
    if ("password" in v) fail("live.password must not be stored in rung.toml");
    const targets: Record<string, LivePlcConfig> = {};
    if (v.plc !== undefined) for (const [name, entry] of Object.entries(table(v.plc, "live.plc"))) {
      const p = table(entry, `live.plc.${name}`);
      if ("password" in p) fail(`live.plc.${name}.password must not be stored in rung.toml; use RUNG_PLC_PASSWORD`);
      if (p.transport !== "s7commplus" && p.transport !== "webapi") fail(`live.plc.${name}.transport must be s7commplus or webapi`);
      if (typeof p.address !== "string" || !isIPv4(p.address)) fail(`live.plc.${name}.address must be a canonical IPv4 literal`);
      if (p.allow_writes !== undefined && typeof p.allow_writes !== "boolean") fail(`live.plc.${name}.allow_writes must be true or false`);
      if (p.certificate_sha256 !== undefined && (typeof p.certificate_sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(p.certificate_sha256))) fail(`live.plc.${name}.certificate_sha256 must be a SHA-256 fingerprint`);
      if (p.user !== undefined && (typeof p.user !== "string" || !p.user)) fail(`live.plc.${name}.user must be a nonempty string`);
      const webapi = p.webapi === undefined ? undefined : parseWebApi(p.webapi, `live.plc.${name}.webapi`);
      if (webapi && new URL(webapi.url).hostname !== p.address) fail(`live.plc.${name}.webapi must bind to the same PLC address`);
      if (p.transport === "webapi" && !webapi) fail(`live.plc.${name}.webapi is required`);
      targets[name] = { transport: p.transport, address: p.address, allowWrites: p.allow_writes === true,
        ...(p.certificate_sha256 ? { certificateSha256: (p.certificate_sha256 as string).toUpperCase() } : {}),
        ...(p.user ? { user: p.user as string } : {}), ...(webapi ? { webapi } : {}) };
    }
    const webapi = v.webapi === undefined ? undefined : parseWebApi(v.webapi, "live.webapi");
    const boundDevices = new Set([...devices as string[], ...Object.keys(plc), ...Object.keys(targets)]);
    if (webapi && boundDevices.size > 1) fail("live.webapi must be bound per PLC in a multi-PLC workspace (live.plc.<device>.webapi)");
    live = { ...(webapi ? { webapi } : {}), ...(v.plc !== undefined ? { plc: targets } : {}) };
  }
  return {
    ...base,
    bridge: { command: (bridge.command as string | undefined) ?? "", args: Array.isArray(bridge.args) ? bridge.args.map(String) : [], ...(bridge.host ? { host: bridge.host as string } : {}) },
    devices: devices as string[],
    sync,
    tia,
    plc,
    download,
    ...(live ? { live } : {}),
  };
}

export function formatConfig(c: RungConfig): string {
  return (
    "# rung workspace — https://github.com/sa1ntsinner/rung\n" +
    stringify({
      format: c.format,
      devices: c.devices,
      project: c.project,
      ...(c.bridge.command || c.bridge.args.length || c.bridge.host ? { bridge: c.bridge } : {}),
      sync: c.sync,
      readOnly: c.readOnly,
      tia: c.tia,
      download: {
        enabled: c.download.enabled,
        allow: c.download.allow,
        start_after: c.download.startAfter,
        only_changes: c.download.onlyChanges,
        hardware: c.download.hardware,
        confirm: c.download.confirm,
        compile_first: c.download.compileFirst,
      },
      ...(Object.keys(c.plc).length
        ? {
            plc: Object.fromEntries(
              Object.entries(c.plc).map(([k, v]) => [k, { mode: v.mode, pc_interface: v.pcInterface, pc_interface_number: v.pcInterfaceNumber, ...(v.targetInterface ? { target_interface: v.targetInterface } : {}), ...(v.address ? { address: v.address } : {}) }]),
            ),
          }
        : {}),
      ...(c.live ? { live: {
        ...(c.live.webapi ? { webapi: c.live.webapi } : {}),
        ...(c.live.plc ? { plc: Object.fromEntries(Object.entries(c.live.plc).map(([name, p]) => [name, {
          transport: p.transport, address: p.address, allow_writes: p.allowWrites,
          ...(p.certificateSha256 ? { certificate_sha256: p.certificateSha256 } : {}),
          ...(p.user ? { user: p.user } : {}), ...(p.webapi ? { webapi: p.webapi } : {}),
        }])) } : {}),
      } } : {}),
    }) +
    "\n"
  );
}

/**
 * rung.toml as rung works with it: writes into TIA Portal (sync.import = "auto") only once this copy of the workspace
 * was given the right for its project (writes.ts). `raw` reads the file as it is, for writing it back.
 */
export async function loadConfig(root: string, opts: { raw?: boolean } = {}): Promise<RungConfig> {
  let text: string;
  try {
    text = await readFile(join(root, CONFIG_FILE), "utf8");
  } catch {
    throw new WorkspaceError("NOT_A_WORKSPACE", `${root} has no ${CONFIG_FILE}; run rung init`);
  }
  const config = parseConfig(text);
  if (opts.raw || config.sync.import !== "auto" || writesGranted(await readWrites(root), config)) return config;
  return { ...config, sync: { ...config.sync, import: "manual" }, writesOff: true };
}

export async function saveConfig(root: string, c: RungConfig): Promise<void> {
  await writeFileAtomic(join(root, CONFIG_FILE), formatConfig(c));
}
