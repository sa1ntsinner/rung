// SPDX-License-Identifier: BUSL-1.1
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { bridgeExecutable } from "./paths.js";
import { codesysBridgeCommand } from "./codesys.js";
import { CONFIG_FILE, StateStore, WorkspaceError, type RungConfig } from "@rung/core";
import { BridgeClient, type BridgeEvent } from "@rung/bridge-client";

export interface Io {
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  /** Asks the user a question (tests inject answers; the CLI reads the terminal). */
  prompt?: (question: string) => Promise<string>;
  /** Resolves when the user asks to stop (Ctrl+C); used by long-running commands. */
  stopSignal?: Promise<void>;
}

export const HINTS: Record<string, string> = {
  ACCESS_DENIED:
    'Your Windows user must be in the local group "Siemens TIA Openness" (run as admin: net localgroup "Siemens TIA Openness" %USERNAME% /add, then sign out and in) and you must accept the Openness access dialog in TIA Portal.',
  TIA_NOT_RUNNING: "Start TIA Portal and open the project first.",
  TIMEOUT:
    "TIA Portal did not answer. It may be waiting for an \"Openness access\" confirmation (look at the TIA Portal window; a TIA Portal without window cannot show it). Register the bridge once with: rung setup openness",
  NO_PROJECT: "Open the project in TIA Portal, or let rung open it in the background: [tia] start = \"headless\" in rung.toml (the default).",
  AMBIGUOUS_PORTAL: "Several TIA Portal instances match. Close the extra ones or pass --project.",
  NOT_A_WORKSPACE: "Run rung init in this folder first.",
  STATE_LOCKED: "Another rung process is using this workspace (is rung watch running?).",
  READ_ONLY: "Two-way sync needs sync.import = \"auto\" in rung.toml; protected, failsafe, system and GRAPH objects and library type instances are never imported.",
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

export async function bridgeFor(config: RungConfig, io: Io, extra: string[] = []) {
  if (config.project.tiaVersion === "CODESYS" && !io.env.RUNG_BRIDGE && !config.bridge.command) {
    // CODESYS: rung itself relays to its bridge script inside CODESYS (codesys.ts); imports are always allowed
    // there, sync.import decides whether rung sends any
    const b = codesysBridgeCommand(config.project.path);
    // the script inside CODESYS downloads only for a bridge started for it (like --allow-download for TIA Portal)
    const env = { ...cleanEnv(io.env), ...(extra.includes("--allow-download") ? { RUNG_CODESYS_ALLOW_DOWNLOAD: "1" } : {}) };
    const client = await BridgeClient.spawn({ command: b.command, args: b.args, env, requestTimeoutMs: 300_000, closeTimeoutMs: 30_000 }); // the relay gives CODESYS 10 s to close its project
    client.onEvent((e) => showBridgeEvent(io, e));
    return client;
  }
  const tiaArgs = ["--project", config.project.path, ...(config.tia.start === "headless" ? ["--open-headless"] : []), ...extra];
  if (config.bridge.host) {
    const client = await remoteBridge(config.bridge.host, config.bridge.command, [...config.bridge.args, ...tiaArgs], config.project.tiaVersion === "V21" ? "V21" : "V20", io);
    client.onEvent((e) => showBridgeEvent(io, e));
    return client;
  }
  // Environment override wins so tests and dev setups can swap the bridge without editing rung.toml.
  const env = defaultBridge(io.env);
  const command = io.env.RUNG_BRIDGE ? env.command : config.bridge.command || bridgeExecutable(io.env, config.project.tiaVersion === "V21" ? "V21" : "V20");
  const args = [...(io.env.RUNG_BRIDGE ? env.args : config.bridge.args), "--project", config.project.path, ...(config.tia.start === "headless" ? ["--open-headless"] : []), ...extra];
  const client = await BridgeClient.spawn({ command, args, env: cleanEnv(io.env) });
  client.onEvent((e) => showBridgeEvent(io, e));
  return client;
}

/**
 * The bridge's arguments as one word that no shell on the way changes: Windows' OpenSSH server hands the command line
 * to cmd.exe (or PowerShell), which would split, expand (%NAME%) or run (&, |) parts of a quoted project path.
 * base64url of a JSON list has none of those characters; `rung bridge --args <word>` on the other PC decodes it.
 */
export function encodeArgs(args: readonly string[]): string {
  return Buffer.from(JSON.stringify(args), "utf8").toString("base64url");
}

export function decodeArgs(word: string): string[] {
  let list: unknown;
  try {
    if (!/^[A-Za-z0-9_-]*$/.test(word)) throw new Error("not base64url");
    list = JSON.parse(Buffer.from(word, "base64url").toString("utf8"));
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list) || !list.every((a) => typeof a === "string")) throw new WorkspaceError("BAD_ARGUMENT", "rung bridge --args: not an argument list from rung");
  return list as string[];
}

/** An ssh destination (user@host, host, ssh://user@host:port); never something ssh would read as an option. */
const SSH_HOST = /^[^\s"'`\u0000-\u001f-][^\s"'`\u0000-\u001f]*$/;

/**
 * The bridge on the Windows PC that runs TIA Portal, over ssh (Linux, macOS): `rung bridge` there (rung installed on
 * that PC) or the given command. Key-based login only: BatchMode never waits for a password. Files cross the
 * connection (BridgeClient remote).
 */
export async function remoteBridge(host: string, command: string, args: string[], tia: "V20" | "V21", io: Io): Promise<BridgeClient> {
  if (!SSH_HOST.test(host)) throw new WorkspaceError("BAD_ARGUMENT", `${JSON.stringify(host)} is not an ssh destination such as user@tia-pc`);
  // RUNG_SSH (+ RUNG_SSH_ARGS, a JSON list put first): another ssh, or a stand-in in tests
  const ssh = io.env.RUNG_SSH ?? "ssh";
  const prefix = io.env.RUNG_SSH_ARGS ? (JSON.parse(io.env.RUNG_SSH_ARGS) as string[]) : [];
  const line = `${command || "rung bridge"} --args ${encodeArgs([...(tia === "V21" ? ["--tia", "V21"] : []), ...args])}`;
  try {
    return await BridgeClient.spawn({ command: ssh, args: [...prefix, "-T", "-o", "BatchMode=yes", "--", host, line], env: cleanEnv(io.env), remote: true, requestTimeoutMs: 300_000 });
  } catch (e) {
    throw new WorkspaceError(
      "BRIDGE_UNREACHABLE",
      `no bridge answered on ${host} (${(e as Error).message}). Check that \`ssh ${host}\` logs in without a password and that rung is installed there (\`rung bridge\` on that PC).`,
    );
  }
}

/** TIA Portal's own questions and notifications explain many online and download failures; RUNG_DEBUG=1 shows every bridge event. */
export function showBridgeEvent(io: Io, e: BridgeEvent): void {
  if (io.env.RUNG_DEBUG) {
    io.stderr(`rung-bridge: ${e.event} ${typeof e.params === "string" ? e.params.trimEnd() : JSON.stringify(e.params)}\n`);
    return;
  }
  if (e.event !== "tia-confirmation" && e.event !== "tia-notification") return;
  const p = (e.params ?? {}) as { caption?: string; text?: string; detail?: string; result?: string | null };
  const text = [p.caption, p.text, p.detail].filter((s) => s && s.trim()).join(": ").replace(/\s+/g, " ").trim();
  if (text) io.stderr(`TIA Portal: ${text}${p.result ? ` (rung answered ${p.result})` : ""}\n`);
}

/** Bridge launch flags for two-way work: imports are only enabled when the workspace asks for them. */
export const importFlags = (config: RungConfig) =>
  config.sync.import === "auto" ? ["--allow-import", ...(config.sync.save === "never" ? [] : ["--save-after-import"])] : [];

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

/** Warnings that describe how an object is mirrored, not a problem: they are printed but do not make the exit code 2. */
const NOTICES = new Set(["UNSUPPORTED_UNIT", "SD_FALLBACK", "TAGS_XML_FALLBACK", "INCONSISTENT"]);
export const isNotice = (code: string) => NOTICES.has(code);

export function printWarnings(io: Io, warnings: readonly { address: string; code: string; message?: string }[]) {
  for (const w of warnings) io.stdout(`  ${w.code.padEnd(20)} ${w.address}${w.message ? ` — ${w.message}` : ""}\n`);
}
