// SPDX-License-Identifier: BUSL-1.1
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { AGENT_ACTIONS, AGENT_MODES, activeAgentEntry, agentModesPath, assertPlcWritable, formatAgentModes, loadConfig, readAgentModes, workspaceAgentModes, workspaceModeKey, WorkspaceError, writeFileAtomic,
  type AgentAction, type AgentMode, type AgentModeEntry, type RungConfig } from "@rung/core";
import { findWorkspace, type Io } from "./common.js";
import { AGENT_REFUSAL, agentRefusal, agentMarker, agentPermission, commandAction, commandTokens, type AgentScope } from "./guard.js";

interface DialogRequest { plc: string; action: AgentAction; agent: string; command: string; timeoutMs: number }
export type DialogRunner = (request: DialogRequest) => Promise<{ answer?: string; reason?: string }>;

function dialogProcess(command: string, args: string[], timeoutMs: number): ReturnType<DialogRunner> {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); resolve({ reason: "Native dialog expired after 120 seconds" }); }, timeoutMs);
    child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 16384) child.kill(); });
    child.once("error", () => { clearTimeout(timer); resolve({ reason: `Native approval dialog is unavailable (${command}); refused` }); });
    child.once("close", code => { clearTimeout(timer); resolve(code === 0 && output.length <= 16384 ? { answer: output.replace(/\r?\n$/, "") } : { reason: "Native approval cancelled or unavailable; refused" }); });
  });
}

/** No terminal input, shell evaluation, or environment-provided answer is accepted. */
export const nativeAgentDialog: DialogRunner = async request => {
  const text = `Allow ${request.action} on ${request.plc}?\nAgent: ${request.agent}\nCommand: ${request.command}\nType ${request.plc} to allow this action once (120 seconds).`;
  if (process.platform === "win32") {
    const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $answer = [Microsoft.VisualBasic.Interaction]::InputBox(${quote(text)}, 'rung: Agent permission', ''); [Console]::Write($answer)`;
    // Fail closed on nonstandard Windows installations; an agent-controlled SystemRoot must not select the dialog executable.
    return dialogProcess("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], request.timeoutMs);
  }
  if (process.platform === "darwin") {
    const literal = (s: string) => JSON.stringify(s).replace(/\\n/g, '" & return & "');
    return dialogProcess("/usr/bin/osascript", ["-e", `text returned of (display dialog ${literal(text)} default answer "" with title "rung: Agent permission" giving up after 120)`], request.timeoutMs);
  }
  for (const name of ["zenity", "kdialog"]) {
    const executable = "/usr/bin/" + name;
    try { await readFile(executable); } catch { continue; }
    return dialogProcess(executable, name === "zenity" ? ["--entry", "--title=rung: Agent permission", "--text=" + text, "--timeout=120"] : ["--title", "rung: Agent permission", "--inputbox", text], request.timeoutMs);
  }
  return { reason: "Native approval requires zenity or kdialog on Linux; neither is installed, so the action is refused" };
};

export interface AgentApproval { scope: AgentScope; finish: (outcome: number) => Promise<void> }

async function assertAgentWritable(config: RungConfig | undefined, dir: string, action: AgentAction, plc: string | undefined, io: Io, command?: string): Promise<void> {
  try { assertPlcWritable(config, plc, io.env); }
  catch (error) {
    try {
      const root = await findWorkspace(dir);
      const modes = (await workspaceAgentModes(root, config ?? await loadConfig(root, { raw: true }), io.env)).filter(p => !plc || p.plc === plc);
      if (modes.length) {
        await mkdir(join(root, ".rung"), { recursive: true });
        await appendFile(join(root, ".rung", "agent-actions.jsonl"), modes.map(p => JSON.stringify({ time: new Date().toISOString(), agent: agentMarker(io.env), plc: p.plc,
          action, mode: p.mode, allowedBy: p.mode === "manual" ? "refused" : p.mode === "ask" || p.mode === "auto" && !p.actions.includes(action) ? "dialog" : "mode", outcome: 2, refused: "read-only", command }) + "\n").join(""));
      }
    } catch { /* The existing read-only refusal takes precedence even when the audit store is unavailable. */ }
    throw error;
  }
}

export async function approveAgentAction(dir: string, action: AgentAction, plc: string | undefined, io: Io, dialog: DialogRunner = nativeAgentDialog, command = `rung ${action}`): Promise<AgentApproval | undefined> {
  const marker = agentMarker(io.env);
  if (!marker) return undefined;
  const scope = agentPermission.getStore();
  await assertAgentWritable(undefined, dir, action, plc, io, command);
  const root = await findWorkspace(dir).catch(error => {
    if (error instanceof WorkspaceError && error.code === "NOT_A_WORKSPACE") throw new WorkspaceError("AGENT_REFUSED", agentRefusal(action));
    throw error;
  });
  const config = await loadConfig(root, { raw: true });
  await assertAgentWritable(config, root, action, plc, io, command);
  if (scope?.env === io.env && scope.action === action && workspaceModeKey(scope.root) === workspaceModeKey(root) && (!plc || scope.plc === plc)) return undefined;
  const policies = await workspaceAgentModes(root, config, io.env);
  const targets = plc ? policies.filter(p => p.plc === plc) : policies;
  // Unknown devices cannot inherit another PLC's override.
  if (!targets.length) {
    const { effectiveAgentMode } = await import("@rung/core");
    targets.push(effectiveAgentMode(await readAgentModes(io.env), root, plc ?? "", config));
  }
  if (action === "download" && targets.some(p => p.source === "simulator" && !config.plc[p.plc])) throw new WorkspaceError("NO_TARGET", "rung simulate does not support TIA downloads; configure an explicit PLC connection first");
  const records = targets.map(policy => ({ time: new Date().toISOString(), agent: marker, plc: policy.plc, action, mode: policy.mode,
    allowedBy: policy.mode === "manual" ? "refused" : policy.mode === "bypass" || policy.mode === "auto" && policy.actions.includes(action) ? "mode" : "dialog", command }));
  const audit = async (outcome: number) => {
    await mkdir(join(root, ".rung"), { recursive: true });
    await appendFile(join(root, ".rung", "agent-actions.jsonl"), records.map(record => JSON.stringify({ ...record, outcome }) + "\n").join(""));
  };
  try {
    if (targets.some(p => p.mode === "manual")) throw new WorkspaceError("AGENT_REFUSED", agentRefusal(action));
    for (const record of records) if (record.allowedBy === "dialog") {
      if (!record.plc) throw new WorkspaceError("AGENT_REFUSED", "Native approval needs an explicit PLC name; choose --plc or --device");
      const result = await dialog({ plc: record.plc, action, agent: marker, command, timeoutMs: 120000 });
      if (result.answer !== record.plc) throw new WorkspaceError("AGENT_REFUSED", result.reason ?? "Native approval refused or cancelled: PLC name did not match");
    }
    return { scope: { env: io.env, root, plc: plc ?? (targets.length === 1 ? targets[0]!.plc : undefined), action, command }, finish: audit };
  } catch (error) { await audit(1); throw error; }
}

export async function withAgentPermission<T>(dir: string, action: AgentAction, plc: string | undefined, io: Io, run: () => Promise<T>, dialog: DialogRunner = nativeAgentDialog, command = `rung ${action}`): Promise<T> {
  const approval = await approveAgentAction(dir, action, plc, io, dialog, command);
  let outcome = 1;
  try {
    const result = await (approval ? agentPermission.run(approval.scope, run) : run());
    outcome = typeof result === "number" ? result : 0;
    return result;
  } catch (error) {
    if ((error as { code?: string }).code === "PLC_READ_ONLY") outcome = 2;
    throw error;
  } finally { await approval?.finish(outcome); }
}

/** A broker may prepare a read-only preview; native consent is obtained at its commit boundary. */
export async function withAgentPreparation<T>(dir: string, action: AgentAction, plc: string | undefined, io: Io, run: () => Promise<T>, command?: string, audit?: { delegated: boolean }): Promise<T> {
  if (!agentMarker(io.env)) return run();
  await assertAgentWritable(undefined, dir, action, plc, io, command);
  const root = await findWorkspace(dir).catch(() => { throw new WorkspaceError("AGENT_REFUSED", agentRefusal(action)); });
  const config = await loadConfig(root, { raw: true });
  await assertAgentWritable(config, root, action, plc, io, command);
  const modes = (await workspaceAgentModes(root, config, io.env)).filter(p => !plc || p.plc === plc);
  if (!modes.length || modes.some(p => p.mode === "manual")) throw new WorkspaceError("AGENT_REFUSED", agentRefusal(action));
  const parent = agentPermission.getStore();
  return agentPermission.run({ env: io.env, root, plc: plc ?? (modes.length === 1 ? modes[0]!.plc : undefined), action, command: command ?? parent?.command, audit: audit ?? parent?.audit }, run);
}

function option(tokens: string[], name: string): string | undefined {
  const at = tokens.indexOf("--" + name);
  return at >= 0 ? tokens[at + 1] : tokens.find(t => t.startsWith("--" + name + "="))?.slice(name.length + 3);
}

export async function runAgentCommand(argv: string[], io: Io, run: () => Promise<number>): Promise<number> {
  if (!agentMarker(io.env) || argv[0] === "guard" || argv.includes("--help") || argv.includes("-h")) return run();
  const positionals = commandTokens(argv);
  const [cmd, sub] = positionals;
  if (cmd === "agent-mode" && sub || argv.some(t => /^--confirm-stdin(?:=|$)/.test(t))) {
    io.stderr(`rung: AGENT_REFUSED: ${agentRefusal(commandAction(positionals, argv))}\n`); return 1;
  }
  const action = commandAction(positionals, argv);
  const dir = resolve(io.cwd, option(argv, "dir") ?? (["live", "writes", "setup", "bridge", "agent-mode"].includes(cmd ?? "") ? "." : sub ?? "."));
  const plc = action === "bridge" ? undefined : option(argv, "plc") ?? option(argv, "device");
  try {
    if (action && cmd !== "live") return await withAgentPermission(dir, action, plc, io, run, undefined, "rung " + argv.map(t => JSON.stringify(t)).join(" "));
    const audit = { delegated: false };
    const execute = () => action ? withAgentPreparation(dir, action, plc, io, run, "rung " + argv.map(t => JSON.stringify(t)).join(" "), audit) : run();
    // A broker records prepared mutations; the CLI also records commands that fail before preparation.
    const root = await findWorkspace(dir).catch(() => undefined);
    if (!root || ["agent-mode", "mcp", "lsp", "debug", "live-server"].includes(cmd ?? "")) return await execute();
    const policies = await workspaceAgentModes(root, await loadConfig(root), io.env);
    const records = policies.filter(p => !plc || p.plc === plc);
    let outcome = 1;
    try { outcome = await execute(); return outcome; }
    catch (error) { if ((error as { code?: string }).code === "PLC_READ_ONLY") outcome = 2; throw error; }
    finally {
      if (action && records.length && !audit.delegated) {
        await mkdir(join(root, ".rung"), { recursive: true });
        await appendFile(join(root, ".rung", "agent-actions.jsonl"), records.map(p => JSON.stringify({ time: new Date().toISOString(), agent: agentMarker(io.env), plc: p.plc, action, mode: p.mode,
          allowedBy: p.mode === "manual" ? "refused" : (p.mode === "ask" || p.mode === "auto" && !p.actions.includes(action)) ? "dialog" : "mode", outcome, command: "rung " + argv.join(" ") }) + "\n").join(""));
      }
    }
  } catch (error) { io.stderr(`rung: ${(error as { code?: string }).code ?? "ERROR"}: ${(error as Error).message}\n`); return (error as { code?: string }).code === "PLC_READ_ONLY" ? 2 : 1; }
}

export async function cmdAgentMode(dir: string, mode: string | undefined, options: { plc?: string; actions?: string; for?: string; json?: boolean }, io: Io): Promise<number> {
  if (mode && agentMarker(io.env)) throw new WorkspaceError("AGENT_REFUSED", AGENT_REFUSAL);
  const root = await findWorkspace(dir);
  const config = await loadConfig(root, { raw: true });
  if (!mode) {
    const plcs = await workspaceAgentModes(root, config, io.env);
    io.stdout(options.json ? JSON.stringify({ workspace: root, plcs }) + "\n" : plcs.map(p => `${p.plc || basename(root)}: ${p.mode} (${p.source}${p.expires ? `; expires ${p.expires}` : ""})${p.mode === "auto" ? `; actions: ${p.actions.join(", ")}` : ""}\n`).join(""));
    return 0;
  }
  if (mode !== "reset" && !AGENT_MODES.includes(mode as AgentMode)) throw new WorkspaceError("BAD_ARGUMENT", "agent-mode expects manual, ask, auto, bypass or reset");
  if (mode === "reset" && (options.actions !== undefined || options.for !== undefined)) throw new WorkspaceError("BAD_ARGUMENT", "reset does not accept --actions or --for");
  if (options.actions !== undefined && mode !== "auto") throw new WorkspaceError("BAD_ARGUMENT", "--actions requires auto mode");
  const actions = options.actions?.split(",").map(a => a.trim()).filter(Boolean) as AgentAction[] | undefined;
  if (actions?.some(a => !AGENT_ACTIONS.includes(a))) throw new WorkspaceError("BAD_ARGUMENT", `actions must be: ${AGENT_ACTIONS.join(", ")}`);
  let expires: string | undefined;
  if (options.for !== undefined) {
    const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(options.for);
    const duration = match ? Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]!] ?? 0) : 0;
    if (!(duration > 0) || !Number.isFinite(duration) || Date.now() + duration > 8.64e15) throw new WorkspaceError("BAD_ARGUMENT", "--for needs a positive duration such as 8h, 30m or 1d");
    expires = new Date(Date.now() + duration).toISOString();
  }
  const file = agentModesPath(io.env);
  const within = relative(root, resolve(file));
  if (within !== ".." && !within.startsWith(".." + sep) && !isAbsolute(within)) throw new WorkspaceError("BAD_ARGUMENT", "Agent mode storage must be outside the workspace; choose a user configuration directory");
  const name = options.plc ?? basename(root);
  if (!io.prompt && !process.stdin.isTTY) throw new WorkspaceError("BAD_ARGUMENT", "Changing agent mode requires a person in an interactive terminal");
  const rl = io.prompt ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try { answer = await (io.prompt ? io.prompt(`Type ${name} to set agent mode ${mode}: `) : rl!.question(`Type ${name} to set agent mode ${mode}: `)); }
  finally { rl?.close(); }
  if (answer !== name) { io.stderr("Agent mode change cancelled\n"); return 1; }
  // Read after confirmation so another workspace's changes during the prompt are preserved.
  const store = await readAgentModes(io.env);
  store.workspaces ??= {};
  const key = Object.keys(store.workspaces).find(key => workspaceModeKey(key) === workspaceModeKey(root)) ?? workspaceModeKey(root);
  const workspace = store.workspaces[key] ??= {};
  const previous = options.plc ? activeAgentEntry(workspace.plcs?.[options.plc]) ?? workspace.default : workspace.default;
  const entry: AgentModeEntry = { mode: mode as AgentMode, ...(actions ? { actions } : {}), ...(expires ? { expires, ...(activeAgentEntry(previous) ? { previous: activeAgentEntry(previous)! } : {}) } : {}) };
  if (options.plc) {
    workspace.plcs ??= {};
    if (mode === "reset") delete workspace.plcs[options.plc]; else workspace.plcs[options.plc] = entry;
  } else if (mode === "reset") delete workspace.default; else workspace.default = entry;
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, formatAgentModes(store));
  return cmdAgentMode(root, undefined, { json: options.json }, io);
}

/** Shell hooks let the CLI enforce native consent, but never grant a manual action. */
export async function hookModePermits(io: Io): Promise<(action: AgentAction, tokens: string[]) => boolean> {
  const root = await findWorkspace(io.cwd).catch(() => undefined);
  if (!root) return () => false;
  const config = await loadConfig(root, { raw: true });
  const modes = await workspaceAgentModes(root, config, io.env);
  return (_action, tokens) => {
    const plc = option(tokens, "plc") ?? option(tokens, "device");
    const selected = modes.filter(p => !plc || p.plc === plc);
    const dir = option(tokens, "dir");
    if (dir && workspaceModeKey(resolve(io.cwd, dir)) !== workspaceModeKey(root)) return false;
    try { assertPlcWritable(config, plc, io.env); } catch { return false; }
    return selected.length > 0 && selected.every(p => p.mode !== "manual");
  };
}
