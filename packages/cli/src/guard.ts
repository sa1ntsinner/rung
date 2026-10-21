// SPDX-License-Identifier: BUSL-1.1
import { WorkspaceError } from "@rung/core";
import type { Io } from "./common.js";

export const AGENT_REFUSAL = "PLC changes and enabling writes belong to the person. Ask the person to run the command themselves in their own terminal, or confirm in VS Code started from their terminal. Use rung_download_request to prepare a download handover.";

/** Environment only: workspace files cannot switch this protection off. */
export function agentMarker(env: Io["env"]): string | undefined {
  return Object.keys(env).find(key => {
    const value = env[key];
    if (!value) return false;
    if (key === "RUNG_AGENT") return value === "1";
    return /^(CLAUDECODE|CLAUDE_CODE(?:_.*)?|CODEX_.*|CURSOR_.*|GEMINI_CLI(?:_.*)?|OPENCODE(?:_.*)?|COPILOT(?:_.*)?|GITHUB_COPILOT(?:_.*)?|AI_AGENT|CLINE_ACTIVE(?:_.*)?|ROO_CODE(?:_.*)?|AIDER(?:_.*)?|WINDSURF_.*|ZED_AGENT(?:_.*)?)$/i.test(key);
  });
}

export function assertHuman(env: Io["env"]): void {
  const marker = agentMarker(env);
  if (marker) throw new WorkspaceError("AGENT_REFUSED", `${AGENT_REFUSAL} (agent environment: ${marker})`);
}

/** Match within compound commands too; hooks are defence in depth, not a shell sandbox. */
export function guardCommand(command: string): { allowed: boolean; reason?: string } {
  const text = command.replace(/\\/g, "/");
  const rung = /(?:^|[\s/;&|()'"])(?:rung(?:\.exe|\.cmd|\.cjs|\.js)?|packages\/cli\/(?:src|dist)\/(?:bin|index)\.(?:js|ts))["']?\s+([^;&|\n]*)/gi;
  const valueOptions = new Set(["dir", "device", "plc", "transport", "project", "tia", "host", "address", "file", "use", "mode", "number", "target", "timeout", "expect-sha256", "instance", "allow", "interval", "out", "filter", "case", "coverage", "against", "scope", "agents", "skills", "editors", "platforms"]);
  let match: RegExpExecArray | null;
  while ((match = rung.exec(text))) {
    const tokens = (match[1]!.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(token => token.replace(/^["']|["']$/g, ""));
    if (tokens.some(token => token === "--help" || token === "-h")) continue;
    const positionals: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.startsWith("-")) {
        if (!token.includes("=") && valueOptions.has(token.replace(/^--?/, ""))) i++;
      } else positionals.push(token);
    }
    const [cmd, sub] = positionals;
    if (cmd === "download" || cmd === "bridge"
      || cmd === "live" && ["modify", "write", "run", "stop", "force", "unforce", "ack", "acknowledge", "reset"].includes(sub ?? "")
      || cmd === "writes" && sub === "on"
      || cmd === "init" && tokens.some(token => /^--writes(?:=|$)/.test(token))
      || cmd === "setup" && sub === "openness"
      || tokens.some(token => /^--confirm-stdin(?:=|$)/.test(token))) return { allowed: false, reason: AGENT_REFUSAL };
  }
  if (/rung\.toml/i.test(text) && /(?:allow_writes|download|read_only|\benabled\b|\b(?:Set-Content|Add-Content|Out-File|tee|sed|perl|python|node|cp|mv|copy|move)\b|[>])/i.test(text)) return { allowed: false, reason: AGENT_REFUSAL };
  return { allowed: true };
}

export function guardHook(event: Record<string, unknown>, protocol: "claude" | "cursor" | "copilot") {
  const raw = event.tool_input ?? event.toolArgs ?? {};
  const input = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  const file = String(input.file_path ?? input.filePath ?? input.path ?? "");
  const editing = /write|edit|replace|patch|create|delete|move|remove/i.test(String(event.tool_name ?? event.toolName ?? ""));
  const protectedEdit = editing && /(?:^|[\\/])rung\.toml$/i.test(file);
  const result = protectedEdit ? { allowed: false, reason: AGENT_REFUSAL } : guardCommand(String(input.command ?? event.command ?? ""));
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
      io.stdout(JSON.stringify(guardHook(JSON.parse(text) as Record<string, unknown>, protocol)) + "\n");
    }
    catch { io.stderr("rung guard: invalid hook input\n"); return 2; }
    return 0;
  }
  const result = guardCommand(args.join(" "));
  io.stdout(JSON.stringify(result) + "\n");
  return result.allowed ? 0 : 1;
}
