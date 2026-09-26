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
    /** Weak revisions (dates) are re-verified by export + hash after this many ms. */
    weakVerifyMs: number;
  };
  readOnly: { failsafe: true; knowHow: true; system: true; graph: true };
  /** Optional live-data sources (read-only). Passwords never live in rung.toml: RUNG_WEBAPI_PASSWORD. */
  live?: { webapi?: { url: string; user: string; insecure?: boolean } };
}

export const CONFIG_FILE = "rung.toml";

export function defaultConfig(projectPath: string, tiaVersion: "V20" | "V21", bridgeCommand: string, devices: string[] = []): RungConfig {
  return {
    format: 1,
    project: { path: projectPath, tiaVersion },
    bridge: { command: bridgeCommand, args: [] },
    devices,
    sync: { pollMs: 2000, detect: "fingerprint", compile: "affected", delete: "confirm", import: "auto", weakVerifyMs: 3_600_000 },
    readOnly: { failsafe: true, knowHow: true, system: true, graph: true },
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
    ...(live?.webapi ? { live: { webapi: { url: live.webapi.url as string, user: live.webapi.user as string, ...(live.webapi.insecure === true ? { insecure: true } : {}) } } } : {}),
  };
}

export function formatConfig(c: RungConfig): string {
  return (
    "# rung workspace — https://github.com/sa1ntsinner/rung\n" +
    stringify({ format: c.format, devices: c.devices, project: c.project, bridge: c.bridge, sync: c.sync, readOnly: c.readOnly, ...(c.live ? { live: c.live } : {}) }) +
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
