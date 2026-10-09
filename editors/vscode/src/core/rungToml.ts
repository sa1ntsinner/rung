// SPDX-License-Identifier: MIT
// The parts of rung.toml the extension shows (packages/core/src/config.ts is the authority),
// and a text edit that adds or replaces one [plc.<device>] table. No vscode import.
import { parse } from "smol-toml";

export interface PlcConnection {
  address?: string;
  mode: string;
  pcInterface: string;
  pcInterfaceNumber: number;
  targetInterface?: string;
}

export interface DownloadDefaults {
  enabled: boolean;
  allow: string[];
  startAfter: boolean;
  onlyChanges: boolean;
  hardware: boolean;
  confirm: "type-name" | "yes-no";
  compileFirst: boolean;
}

export interface RungToml {
  projectPath?: string;
  tiaVersion?: string;
  devices: string[];
  plc: Record<string, PlcConnection>;
  download: DownloadDefaults;
  syncImport?: string;
  bridgeHost?: string;
  live?: { webapi?: LiveWebApi; plc: Record<string, LivePlc> };
}
export interface LiveWebApi { url: string; user: string; insecure?: boolean }
export interface LivePlc { transport: "s7commplus" | "webapi"; address: string; user?: string; certificateSha256?: string; webapi?: LiveWebApi }

export const DOWNLOAD_DEFAULTS: Readonly<DownloadDefaults> = {
  enabled: true,
  allow: [],
  startAfter: true,
  onlyChanges: true,
  hardware: false,
  confirm: "type-name",
  compileFirst: true,
};

type Table = Record<string, unknown>;
const table = (v: unknown): Table => (v && typeof v === "object" && !Array.isArray(v) ? (v as Table) : {});
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** Lenient read: wrong values fall back to rung's defaults (the CLI reports them properly). Throws on TOML syntax errors. */
export function parseRungToml(text: string): RungToml {
  const raw = parse(text) as Table;
  const project = table(raw.project);
  const dl = table(raw.download);
  const plc: Record<string, PlcConnection> = {};
  for (const [name, v] of Object.entries(table(raw.plc))) {
    const t = table(v);
    if (typeof t.mode !== "string" || typeof t.pc_interface !== "string") continue;
    const n = typeof t.pc_interface_number === "number" ? t.pc_interface_number : 1;
    plc[name] = { mode: t.mode, pcInterface: t.pc_interface, pcInterfaceNumber: n, ...(typeof t.target_interface === "string" ? { targetInterface: t.target_interface } : {}), ...(typeof t.address === "string" ? { address: t.address } : {}) };
  }
  const out: RungToml = {
    devices: Array.isArray(raw.devices) ? raw.devices.filter((d): d is string => typeof d === "string" && !!d) : [],
    plc,
    download: {
      enabled: bool(dl.enabled, DOWNLOAD_DEFAULTS.enabled),
      allow: Array.isArray(dl.allow) ? dl.allow.filter((a): a is string => typeof a === "string") : [],
      startAfter: bool(dl.start_after, DOWNLOAD_DEFAULTS.startAfter),
      onlyChanges: bool(dl.only_changes, DOWNLOAD_DEFAULTS.onlyChanges),
      hardware: bool(dl.hardware, DOWNLOAD_DEFAULTS.hardware),
      confirm: dl.confirm === "yes-no" ? "yes-no" : "type-name",
      compileFirst: bool(dl.compile_first, DOWNLOAD_DEFAULTS.compileFirst),
    },
  };
  if (typeof project.path === "string") out.projectPath = project.path;
  if (typeof project.tiaVersion === "string") out.tiaVersion = project.tiaVersion;
  const sync = table(raw.sync);
  if (typeof sync.import === "string") out.syncImport = sync.import;
  const bridge = table(raw.bridge);
  if (typeof bridge.host === "string") out.bridgeHost = bridge.host;
  if (raw.live !== undefined) {
    const live = table(raw.live);
    const web = (v: unknown): LiveWebApi | undefined => {
      const t = table(v);
      return typeof t.url === "string" && typeof t.user === "string" ? { url: t.url, user: t.user, ...(typeof t.insecure === "boolean" ? { insecure: t.insecure } : {}) } : undefined;
    };
    const plc: Record<string, LivePlc> = {};
    for (const [device, value] of Object.entries(table(live.plc))) {
      const t = table(value);
      if ((t.transport !== "s7commplus" && t.transport !== "webapi") || typeof t.address !== "string") continue;
      plc[device] = { transport: t.transport, address: t.address, ...(typeof t.user === "string" ? { user: t.user } : {}), ...(typeof t.certificate_sha256 === "string" ? { certificateSha256: t.certificate_sha256 } : {}), ...(web(t.webapi) ? { webapi: web(t.webapi) } : {}) };
    }
    out.live = { plc, ...(web(live.webapi) ? { webapi: web(live.webapi) } : {}) };
  }
  return out;
}

/** The archive rung recorded in .rung/backups.json (text "" when there is none). */
export function lastBackupOf(text: string): { at: number; path: string } | undefined {
  try {
    const b = JSON.parse(text) as { at?: unknown; path?: unknown };
    return typeof b.at === "number" && typeof b.path === "string" ? { at: b.at, path: b.path } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether rung writes into the project from this copy of the workspace, as the CLI decides it: sync.import = "auto"
 * in rung.toml and `rung writes on` given for this project and host (.rung/writes.json, text "" when missing).
 */
export function writesState(toml: RungToml | undefined, grantText: string): "on" | "off" | "manual" {
  if (!toml || (toml.syncImport ?? "auto") !== "auto") return "manual";
  let grant: { project?: unknown; host?: unknown } = {};
  try {
    grant = JSON.parse(grantText) as typeof grant;
  } catch {
    return "off";
  }
  const path = toml.projectPath ?? "";
  const windows = /^([a-z]:|\\\\)/i.test(path);
  const same = typeof grant.project === "string" && (windows ? grant.project.toLowerCase() === path.toLowerCase() : grant.project === path);
  return same && (typeof grant.host === "string" ? grant.host : "") === (toml.bridgeHost ?? "") ? "on" : "off";
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function tomlKey(k: string): string {
  return BARE_KEY.test(k) ? k : tomlString(k);
}

export function formatPlcSection(device: string, c: PlcConnection): string {
  return [
    `[plc.${tomlKey(device)}]`,
    `mode = ${tomlString(c.mode)}`,
    `pc_interface = ${tomlString(c.pcInterface)}`,
    `pc_interface_number = ${c.pcInterfaceNumber}`,
    ...(c.targetInterface !== undefined ? [`target_interface = ${tomlString(c.targetInterface)}`] : []),
    ...(c.address !== undefined ? [`address = ${tomlString(c.address)}`] : []),
  ].join("\n");
}

function isPlcHeader(line: string, device: string): boolean {
  const m = /^\s*\[\s*plc\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(#.*)?$/.exec(line);
  if (!m) return false;
  const name = m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]);
  return name === device;
}

/**
 * Returns rung.toml text with [plc.<device>] set to `c`: replaces the existing table (up to the next
 * table header) or appends a new one. Comments and every other table stay as they were.
 */
export function upsertPlcSection(text: string, device: string, c: PlcConnection): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const section = formatPlcSection(device, c).split("\n").join(eol);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => isPlcHeader(l, device));
  if (start < 0) {
    const body = text.replace(/(\r?\n)*$/, "");
    return `${body}${body ? eol + eol : ""}${section}${eol}`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  // keep blank lines / comments that belong to the next table
  let keep = end;
  while (keep > start + 1 && /^\s*(#.*)?$/.test(lines[keep - 1]!)) keep--;
  return [...lines.slice(0, start), ...section.split(eol), ...lines.slice(keep)].join(eol);
}
