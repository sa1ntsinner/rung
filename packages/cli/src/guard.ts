// SPDX-License-Identifier: BUSL-1.1
import { WorkspaceError } from "@rung/core";
import type { Io } from "./common.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentAction } from "@rung/core";

export interface AgentScope { env: Io["env"]; root: string; plc?: string; action: AgentAction; command?: string; audit?: { delegated: boolean } }
export const agentPermission = new AsyncLocalStorage<AgentScope>();

export const AGENT_REFUSAL = "PLC changes and enabling writes belong to the person. Ask the person to run the command themselves in their own terminal, or confirm in VS Code started from their terminal. Use rung_download_request to prepare a download handover.";

export function agentRefusal(action?: AgentAction): string {
  const names: Record<AgentAction, string> = { download: "download", write: "live write", force: "live force/unforce", "run-stop": "run/stop", "alarm-ack": "alarm acknowledgement", "writes-on": "writes on", "openness-setup": "Openness whitelist registration", bridge: "bridge" };
  if (!action) return AGENT_REFUSAL;
  const text = AGENT_REFUSAL.replace("PLC changes and enabling writes belong", `${names[action]} belongs`);
  // the handover is for a download only
  return action === "download" ? text : text.replace(/ Use rung_download_request.*$/, "");
}

/** Environment only: workspace files cannot switch this protection off. */
export function agentMarker(env: Io["env"]): string | undefined {
  return Object.keys(env).find(key => {
    const value = env[key];
    if (!value) return false;
    if (key === "RUNG_AGENT") return value === "1";
    return /^(CLAUDECODE|CLAUDE_CODE(?:_.*)?|CODEX_.*|CURSOR_.*|GEMINI_CLI(?:_.*)?|OPENCODE(?:_.*)?|COPILOT(?:_.*)?|GITHUB_COPILOT(?:_.*)?|AI_AGENT|CLINE_ACTIVE(?:_.*)?|ROO_CODE(?:_.*)?|AIDER(?:_.*)?|WINDSURF_.*|ZED_AGENT(?:_.*)?)$/i.test(key);
  });
}

export function assertHuman(env: Io["env"], action?: AgentAction): void {
  const marker = agentMarker(env);
  if (marker && agentPermission.getStore()?.env !== env) throw new WorkspaceError("AGENT_REFUSED", `${agentRefusal(action)} (agent environment: ${marker})`);
}

/** Shared by the shell hooks and CLI: keep PLC-changing command recognition here. */
export function commandAction(positionals: string[], tokens: string[]): AgentAction | undefined {
  const [cmd, sub] = positionals;
  if (cmd === "download") return "download";
  if (cmd === "bridge") return "bridge";
  if (cmd === "live") {
    if (["modify", "write"].includes(sub ?? "")) return "write";
    if (["force", "unforce"].includes(sub ?? "")) return "force";
    if (["run", "stop"].includes(sub ?? "")) return "run-stop";
    if (["ack", "acknowledge", "reset"].includes(sub ?? "")) return "alarm-ack";
  }
  if (cmd === "writes" && sub === "on" || cmd === "init" && tokens.some(token => /^--writes(?:=|$)/.test(token))) return "writes-on";
  if (cmd === "setup" && sub === "openness") return "openness-setup";
  return undefined;
}

export function commandTokens(tokens: string[]): string[] {
  const valueOptions = new Set(["dir", "device", "plc", "transport", "project", "tia", "host", "address", "file", "use", "mode", "number", "target", "timeout", "expect-sha256", "instance", "allow", "interval", "out", "filter", "case", "coverage", "against", "scope", "agents", "skills", "editors", "platforms", "actions", "for", "args"]);
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("-")) { if (!token.includes("=") && valueOptions.has(token.replace(/^--?/, ""))) i++; }
    else positionals.push(token);
  }
  return positionals;
}

/** Match within compound commands too; hooks are defence in depth, not a shell sandbox. */
export function guardCommand(command: string, permits?: (action: AgentAction, tokens: string[]) => boolean): { allowed: boolean; reason?: string } {
  const text = command.replace(/\\/g, "/");
  const rung = /(?:^|[\s/;&|()'"])(?:rung(?:\.exe|\.cmd|\.cjs|\.js)?|packages\/cli\/(?:src|dist)\/(?:bin|index)\.(?:js|ts))["']?\s+([^;&|\n]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = rung.exec(text))) {
    const tokens = (match[1]!.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(token => token.replace(/^["']|["']$/g, ""));
    if (tokens.some(token => token === "--help" || token === "-h")) continue;
    const positionals = commandTokens(tokens);
    const action = commandAction(positionals, tokens);
    if (positionals[0] === "agent-mode" && positionals.length > 1 || tokens.some(token => /^--confirm-stdin(?:=|$)/.test(token))
      || action && !permits?.(action, tokens)) return { allowed: false, reason: agentRefusal(action) };
  }
  if (/(?:^|[\s/"'])rung\/agent-modes\.toml\b/i.test(text) && !/^\s*(?:cat|type|Get-Content)\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|>]+)\s*$/i.test(text)) return { allowed: false, reason: AGENT_REFUSAL };
  if (/rung\.toml/i.test(text) && /(?:allow_writes|download|read_only|\benabled\b|\b(?:Set-Content|Add-Content|Out-File|tee|sed|perl|python|node|cp|mv|copy|move)\b|[>])/i.test(text)) return { allowed: false, reason: AGENT_REFUSAL };
  return { allowed: true };
}

export function guardHook(event: Record<string, unknown>, protocol: "claude" | "cursor" | "copilot", permits?: (action: AgentAction, tokens: string[]) => boolean) {
  const raw = event.tool_input ?? event.toolArgs ?? {};
  const input = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  const file = String(input.file_path ?? input.filePath ?? input.path ?? "");
  const editing = /write|edit|replace|patch|create|delete|move|remove/i.test(String(event.tool_name ?? event.toolName ?? ""));
  const protectedEdit = editing && (/(?:^|[\\/])(?:rung\.toml|rung[\\/]agent-modes\.toml)$/i.test(file)
    || /rung[\\/]+agent-modes\.toml/i.test(JSON.stringify(input)));
  const result = protectedEdit ? { allowed: false, reason: AGENT_REFUSAL } : guardCommand(String(input.command ?? event.command ?? ""), permits);
  if (protocol === "cursor") return { permission: result.allowed ? "allow" : "deny", ...(result.reason ? { user_message: result.reason, agent_message: result.reason } : {}) };
  if (result.allowed) return {};
  if (protocol === "copilot") return { permissionDecision: result.allowed ? "allow" : "deny", ...(result.reason ? { permissionDecisionReason: result.reason } : {}) };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: result.allowed ? "allow" : "deny", ...(result.reason ? { permissionDecisionReason: result.reason } : {}) } };
}

export async function cmdGuard(args: string[], io: Io): Promise<number> {
  const protocol = args.includes("--claude-hook") ? "claude" : args.includes("--cursor-hook") ? "cursor" : args.includes("--copilot-hook") ? "copilot" : undefined;
  if (protocol) {
    let text = "";
    // Invalid hook input fails closed rather than silently allowing an operation.
    try {
      for await (const chunk of process.stdin) {
        text += String(chunk);
        if (text.length > 1_048_576) throw new Error("Guard hook input is too large");
      }
      const { hookModePermits } = await import("./agentMode.js");
      io.stdout(JSON.stringify(guardHook(JSON.parse(text) as Record<string, unknown>, protocol, await hookModePermits(io))) + "\n");
    }
    catch { io.stderr("rung guard: invalid hook input\n"); return 2; }
    return 0;
  }
  const { hookModePermits } = await import("./agentMode.js");
  const result = guardCommand(args.join(" "), await hookModePermits(io));
  io.stdout(JSON.stringify(result) + "\n");
  return result.allowed ? 0 : 1;
}
