// SPDX-License-Identifier: BUSL-1.1
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { writeFileAtomic } from "./atomic.js";
import { WorkspaceError } from "./errors.js";

export interface RungConfig {
  format: 1;
  project: { path: string; tiaVersion: "V20" | "V21" };
  bridge: { command: string; args: string[] };
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
  };
  readOnly: { failsafe: true; knowHow: true; system: true; graph: true };
  /** How rung reaches TIA Portal: start = "headless" opens the project in a TIA Portal without window when none has it open. */
  tia: { start: "headless" | "never" };
  /** Connection per PLC for online and download ([plc.<device>] in rung.toml; see rung interfaces). */
  plc: Record<string, PlcConnection>;
  /** How downloads behave (docs/decisions/0002-plc-actions.md). A person always starts a download. */
  download: DownloadSettings;
  /** Optional live-data sources (read-only). Passwords never live in rung.toml: RUNG_WEBAPI_PASSWORD. */
  live?: { webapi?: { url: string; user: string; insecure?: boolean } };
}

export interface PlcConnection {
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

export function defaultConfig(projectPath: string, tiaVersion: "V20" | "V21", bridgeCommand: string, devices: string[] = []): RungConfig {
  return {
    format: 1,
    project: { path: projectPath, tiaVersion },
    bridge: { command: bridgeCommand, args: [] },
    devices,
    sync: { pollMs: 2000, detect: "fingerprint", compile: "affected", delete: "confirm", import: "auto", save: "after-import", weakVerifyMs: 3_600_000 },
    readOnly: { failsafe: true, knowHow: true, system: true, graph: true },
    tia: { start: "headless" },
    plc: {},
    download: { enabled: true, allow: [], startAfter: true, onlyChanges: true, hardware: false, confirm: "type-name", compileFirst: true },
  };
}

function fail(msg: string): never {
  throw new WorkspaceError("CONFIG_INVALID", `rung.toml: ${msg}`);
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
  if (project.tiaVersion !== "V20" && project.tiaVersion !== "V21") fail("project.tiaVersion must be V20 or V21");
  const bridge = (raw.bridge ?? {}) as Record<string, unknown>;
  if (typeof bridge.command !== "string" || !bridge.command) fail("bridge.command is required");
  const base = defaultConfig(project.path, project.tiaVersion, bridge.command);
  const sync = { ...base.sync, ...((raw.sync as object) ?? {}) } as RungConfig["sync"];
  if (!(sync.pollMs >= 250)) fail("sync.pollMs must be >= 250");
  if (!["fingerprint", "vci"].includes(sync.detect)) fail("sync.detect must be fingerprint or vci");
  if (!["affected", "none", "all"].includes(sync.compile)) fail("sync.compile must be affected, none or all");
  if (!["confirm", "never"].includes(sync.delete)) fail("sync.delete must be confirm or never");
  if (!["auto", "manual"].includes(sync.import)) fail("sync.import must be auto or manual");
  if (!["after-import", "never"].includes(sync.save)) fail("sync.save must be after-import or never");
  const plc: Record<string, PlcConnection> = {};
  for (const [name, v] of Object.entries((raw.plc ?? {}) as Record<string, Record<string, unknown>>)) {
    if (typeof v !== "object" || v === null) fail(`plc.${name} must be a table`);
    if (typeof v.mode !== "string" || typeof v.pc_interface !== "string") fail(`plc.${name} needs mode and pc_interface (run rung interfaces)`);
    const n = v.pc_interface_number ?? 1;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) fail(`plc.${name}.pc_interface_number must be a positive integer`);
    if (v.target_interface !== undefined && typeof v.target_interface !== "string") fail(`plc.${name}.target_interface must be a string`);
    plc[name] = { mode: v.mode, pcInterface: v.pc_interface, pcInterfaceNumber: n, ...(typeof v.target_interface === "string" ? { targetInterface: v.target_interface } : {}) };
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
  const live = raw.live as { webapi?: { url?: unknown; user?: unknown; insecure?: unknown; password?: unknown } } | undefined;
  if (live?.webapi) {
    if ("password" in live.webapi) fail("live.webapi.password must not be stored in rung.toml; use the RUNG_WEBAPI_PASSWORD environment variable");
    if (typeof live.webapi.url !== "string" || !/^https?:\/\//.test(live.webapi.url)) fail("live.webapi.url must be an http(s) URL");
    if (typeof live.webapi.user !== "string" || !live.webapi.user) fail("live.webapi.user is required");
  }
  return {
    ...base,
    bridge: { command: bridge.command, args: Array.isArray(bridge.args) ? bridge.args.map(String) : [] },
    devices: devices as string[],
    sync,
    tia,
    plc,
    download,
    ...(live?.webapi ? { live: { webapi: { url: live.webapi.url as string, user: live.webapi.user as string, ...(live.webapi.insecure === true ? { insecure: true } : {}) } } } : {}),
  };
}

export function formatConfig(c: RungConfig): string {
  return (
    "# rung workspace — https://github.com/sa1ntsinner/rung\n" +
    stringify({
      format: c.format,
      devices: c.devices,
      project: c.project,
      bridge: c.bridge,
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
              Object.entries(c.plc).map(([k, v]) => [k, { mode: v.mode, pc_interface: v.pcInterface, pc_interface_number: v.pcInterfaceNumber, ...(v.targetInterface ? { target_interface: v.targetInterface } : {}) }]),
            ),
          }
        : {}),
      ...(c.live ? { live: c.live } : {}),
    }) +
    "\n"
  );
}

export async function loadConfig(root: string): Promise<RungConfig> {
  let text: string;
  try {
    text = await readFile(join(root, CONFIG_FILE), "utf8");
  } catch {
    throw new WorkspaceError("NOT_A_WORKSPACE", `${root} has no ${CONFIG_FILE}; run rung init`);
  }
  return parseConfig(text);
}

export async function saveConfig(root: string, c: RungConfig): Promise<void> {
  await writeFileAtomic(join(root, CONFIG_FILE), formatConfig(c));
}
