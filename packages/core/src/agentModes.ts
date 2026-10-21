// SPDX-License-Identifier: BUSL-1.1
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "smol-toml";
import type { RungConfig } from "./config.js";
import { WorkspaceError } from "./errors.js";

export const AGENT_MODES = ["manual", "ask", "auto", "bypass"] as const;
export type AgentMode = typeof AGENT_MODES[number];
export const AGENT_ACTIONS = ["download", "write", "force", "run-stop", "alarm-ack", "writes-on", "openness-setup", "bridge"] as const;
export type AgentAction = typeof AGENT_ACTIONS[number];
export const DEFAULT_AGENT_ACTIONS: AgentAction[] = ["download", "write", "run-stop"];
export interface AgentModeEntry { mode: AgentMode; actions?: AgentAction[]; expires?: string; previous?: AgentModeEntry }
export interface AgentModeStore { workspaces?: Record<string, { default?: AgentModeEntry; plcs?: Record<string, AgentModeEntry> }> }
export interface EffectiveAgentMode { plc: string; mode: AgentMode; source: "plc" | "workspace" | "simulator" | "default"; actions: AgentAction[]; expires?: string }

export const formatAgentModes = (store: AgentModeStore): string => stringify(store);

export function workspaceModeKey(root: string): string {
  const path = resolve(root);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function agentModesPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = process.platform === "win32" ? env.APPDATA ?? join(homedir(), "AppData", "Roaming") : env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config");
  return join(base, "rung", "agent-modes.toml");
}

function validEntry(value: unknown, depth = 0): value is AgentModeEntry {
  if (!value || typeof value !== "object" || depth > 64) return false;
  const e = value as AgentModeEntry;
  return AGENT_MODES.includes(e.mode) && (e.actions === undefined || Array.isArray(e.actions) && e.actions.every(a => AGENT_ACTIONS.includes(a)))
    && (e.expires === undefined || typeof e.expires === "string" && /^\d{4}-\d\d-\d\dT/.test(e.expires) && Number.isFinite(Date.parse(e.expires)))
    && (e.previous === undefined || validEntry(e.previous, depth + 1));
}

export async function readAgentModes(env: NodeJS.ProcessEnv = process.env): Promise<AgentModeStore> {
  let text: string;
  try { text = await readFile(agentModesPath(env), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  try {
    const store = parse(text) as AgentModeStore;
    if (store.workspaces !== undefined) {
      if (!store.workspaces || typeof store.workspaces !== "object" || Array.isArray(store.workspaces)) throw new Error("invalid workspaces");
      for (const workspace of Object.values(store.workspaces)) {
        if (!workspace || typeof workspace !== "object" || workspace.default !== undefined && !validEntry(workspace.default)) throw new Error("invalid workspace mode");
        if (workspace.plcs !== undefined && (!workspace.plcs || typeof workspace.plcs !== "object" || Array.isArray(workspace.plcs) || !Object.values(workspace.plcs).every(e => validEntry(e)))) throw new Error("invalid PLC mode");
      }
    }
    return store;
  } catch (error) { throw new WorkspaceError("CONFIG_INVALID", `Cannot read agent modes: ${(error as Error).message}`); }
}

export function activeAgentEntry(entry?: AgentModeEntry, now = Date.now()): AgentModeEntry | undefined {
  while (entry?.expires && Date.parse(entry.expires) <= now) entry = entry.previous;
  return entry;
}

export function effectiveAgentMode(store: AgentModeStore, root: string, plc: string, config: RungConfig, options: { now?: number; simulator?: boolean } = {}): EffectiveAgentMode {
  const workspace = Object.entries(store.workspaces ?? {}).find(([key]) => workspaceModeKey(key) === workspaceModeKey(root))?.[1];
  const local = activeAgentEntry(workspace?.plcs?.[plc], options.now);
  const entry = local ?? activeAgentEntry(workspace?.default, options.now);
  // An address, even loopback, is not evidence that a PLC is a simulator.
  const connection = config.plc[plc];
  const simulator = options.simulator && !connection || !!connection && /\bPLCSIM\b/i.test(connection.pcInterface);
  return { plc, mode: entry?.mode ?? (simulator ? "auto" : "manual"), source: local ? "plc" : entry ? "workspace" : simulator ? "simulator" : "default",
    actions: entry?.actions ?? [...DEFAULT_AGENT_ACTIONS], ...(entry?.expires ? { expires: entry.expires } : {}) };
}

/** Offline target inspection only; never probes an address to guess whether it is simulated. */
export async function workspaceAgentModes(root: string, config: RungConfig, env: NodeJS.ProcessEnv = process.env): Promise<EffectiveAgentMode[]> {
  const path = relative(resolve(root), resolve(agentModesPath(env)));
  if (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path)) throw new WorkspaceError("CONFIG_INVALID", "Agent mode storage must be outside the workspace");
  const store = await readAgentModes(env);
  const mirrored = await readdir(join(root, "plc"), { withFileTypes: true }).catch(() => []);
  const names = [...new Set([...config.devices, ...Object.keys(config.plc), ...Object.keys(config.live?.plc ?? {}), ...mirrored.filter(e => e.isDirectory()).map(e => e.name)])];
  let simulator = false;
  if (!Object.keys(config.live?.plc ?? {}).length) {
    try {
      const marker = JSON.parse(await readFile(join(root, ".rung", "simulate.json"), "utf8")) as { pid?: unknown; url?: unknown };
      if (typeof marker.pid === "number" && typeof marker.url === "string" && (!config.live?.webapi || config.live.webapi.url === marker.url)) {
        process.kill(marker.pid, 0);
        simulator = true;
      }
    } catch { /* A stale or malformed simulator marker never grants permissions. */ }
  }
  return (names.length ? names : [""]).map(plc => effectiveAgentMode(store, root, plc, config, { simulator }));
}
