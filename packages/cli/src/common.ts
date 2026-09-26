// SPDX-License-Identifier: BUSL-1.1
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { bridgeExecutable } from "./paths.js";
import { CONFIG_FILE, StateStore, WorkspaceError, type RungConfig } from "@rung/core";
import { BridgeClient } from "@rung/bridge-client";

export interface Io {
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  /** Resolves when the user asks to stop (Ctrl+C); used by long-running commands. */
  stopSignal?: Promise<void>;
}

export const HINTS: Record<string, string> = {
  ACCESS_DENIED:
    'Your Windows user must be in the local group "Siemens TIA Openness" (run as admin: net localgroup "Siemens TIA Openness" %USERNAME% /add, then sign out and in) and you must accept the Openness access dialog in TIA Portal.',
  TIA_NOT_RUNNING: "Start TIA Portal and open the project first.",
  NO_PROJECT: "Open the bound project in TIA Portal (rung never opens or modifies projects on its own).",
  AMBIGUOUS_PORTAL: "Several TIA Portal instances match. Close the extra ones or pass --project.",
  NOT_A_WORKSPACE: "Run rung init in this folder first.",
  BINDING_MISMATCH: "This folder mirrors a different project. Use another folder or rung init --rebind.",
  STATE_LOCKED: "Another rung process is using this workspace (is rung watch running?).",
  READ_ONLY: "Two-way sync needs sync.import = \"auto\" in rung.toml; protected, failsafe, system and GRAPH objects are never imported.",
};

export function defaultBridge(env: Io["env"]): { command: string; args: string[] } {
  const args = env.RUNG_BRIDGE_ARGS ? (JSON.parse(env.RUNG_BRIDGE_ARGS) as string[]) : [];
  if (env.RUNG_BRIDGE) return { command: env.RUNG_BRIDGE, args };
  return { command: bridgeExecutable(env), args };
}

export async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function cleanEnv(env: Io["env"]): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

export function bridgeFor(config: RungConfig, io: Io, extra: string[] = []) {
  // Environment override wins so tests and dev setups can swap the bridge without editing rung.toml.
  const env = defaultBridge(io.env);
  const command = io.env.RUNG_BRIDGE ? env.command : config.bridge.command;
  const args = [...(io.env.RUNG_BRIDGE ? env.args : config.bridge.args), "--project", config.project.path, ...extra];
  return BridgeClient.spawn({ command, args, env: cleanEnv(io.env) });
}

/** Bridge launch flags for two-way work: imports are only enabled when the workspace asks for them. */
export const importFlags = (config: RungConfig) => (config.sync.import === "auto" ? ["--allow-import"] : []);

export async function openState(dir: string, config: RungConfig) {
  return StateStore.open(dir, { projectPath: config.project.path, tiaVersion: config.project.tiaVersion, devices: config.devices });
}

/** Nearest folder at or above `start` that contains rung.toml. */
export async function findWorkspace(start: string): Promise<string> {
  let d = resolve(start);
  for (;;) {
    if (await exists(join(d, CONFIG_FILE))) return d;
    const up = dirname(d);
    if (up === d) throw new WorkspaceError("NOT_A_WORKSPACE", `no ${CONFIG_FILE} at or above ${start}`);
    d = up;
  }
}

export function printWarnings(io: Io, warnings: readonly { address: string; code: string; message?: string }[]) {
  for (const w of warnings) io.stdout(`  ${w.code.padEnd(20)} ${w.address}${w.message ? ` — ${w.message}` : ""}\n`);
}
