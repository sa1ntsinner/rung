// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { agentModesPath, defaultConfig, saveConfig, workspaceModeKey } from "@rung/core";
import { agentMarker, guardCommand, guardHook, assertHuman, cmdGuard } from "../src/guard.js";
import { main } from "../src/main.js";
import { onlineHost } from "../src/liveTrust.js";
import { cmdWrites } from "../src/twoway.js";
import { cmdDownload } from "../src/plc.js";
import { liveMutations } from "../src/liveMutation.js";
import { AGENT_ENV } from "../../../editors/vscode/src/core/agentEnv.js";

/** A workspace whose person chose agent mode manual. */
async function manualWorkspace() {
  const parent = await mkdtemp(join(tmpdir(), "rung-guard-"));
  const root = join(parent, "workspace");
  await mkdir(root);
  const env = { RUNG_AGENT: "1", APPDATA: join(parent, "settings"), XDG_CONFIG_HOME: join(parent, "settings") };
  await saveConfig(root, defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]));
  await mkdir(join(parent, "settings", "rung"), { recursive: true });
  await writeFile(agentModesPath(env), stringify({ workspaces: { [workspaceModeKey(root)]: { default: { mode: "manual" } } } }));
  return { root, env };
}

describe("agent shell guard", () => {
  it.each([
    [["download"], "download"], [["live", "write", "X", "true"], "live write"],
    [["live", "stop"], "run/stop"], [["writes", "on"], "writes on"],
    [["setup", "openness"], "Openness whitelist registration"], [["bridge"], "bridge"],
  ])("names the refused action for %s", async (args, action) => {
    expect(guardCommand("rung " + args.join(" ")).reason).toContain(`${action} stays with them`);
    const err: string[] = [];
    const { root, env } = await manualWorkspace();
    expect(await main(args, { cwd: root, env, stdout: () => {}, stderr: text => err.push(text) })).toBe(1);
    expect(err.join("")).toContain(`${action} stays with them`);
    expect(err.join("")).toContain("Ask the person to run the command in their own terminal");
    // the download handover is offered for a download only
    expect(err.join("").includes("rung_download_request")).toBe(action === "download");
  });
  it("blocks oversized or malformed hook input with exit code 2", async () => {
    for (const payload of ["{bad json", "x".repeat(1_048_577)]) {
      const input = vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield payload; });
      try {
        expect(await cmdGuard(["--claude-hook"], { cwd: ".", env: {}, stdout: () => {}, stderr: () => {} })).toBe(2);
      } finally { input.mockRestore(); }
    }
  });
  it.each(["CLAUDECODE", "CODEX_SANDBOX", "CODEX_THREAD_ID", "CODEX_NEW_MARKER", "CURSOR_AGENT", "CURSOR_TRACE_ID", "GEMINI_CLI", "OPENCODE", "COPILOT_AGENT", "GITHUB_COPILOT", "AI_AGENT", "CLINE_ACTIVE", "CLINE_ACTIVE_AGENT", "ROO_CODE", "RUNG_AGENT"])("detects %s without a workspace setting", key => {
    expect(agentMarker({ [key]: "1" })).toBe(key);
    expect(() => assertHuman({ [key]: "1" })).toThrow(/agent mode check/i);
  });
  it.each(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CURSOR_TRACE_ID", "GEMINI_CLI", "OPENCODE", "COPILOT_AGENT", "GITHUB_COPILOT", "AI_AGENT", "CLINE_ACTIVE", "ROO_CODE", "AIDER_MODEL", "WINDSURF_X", "ZED_AGENT", "RUNG_AGENT"])("the VS Code extension strips %s for a run the person confirmed", key => {
    // the extension removes exactly what the CLI refuses on, or the person's own click is refused
    expect(agentMarker({ [key]: "1" })).toBe(key);
    expect(AGENT_ENV.test(key)).toBe(true);
  });
  it("leaves a human terminal unaffected", () => {
    expect(agentMarker({ TERM_PROGRAM: "vscode", RUNG_AGENT: "0" })).toBeUndefined();
    expect(() => assertHuman({})).not.toThrow();
  });
  it.each([
    "rung download --yes", 'node "C:/tools/rung.cjs" download', "rung live modify X true --confirm-stdin --json",
    "rung live run", "rung live stop", "rung live force", "rung live acknowledge", "rung writes on", "rung init --writes", "rung setup openness",
    "rung --yes download", "rung --dir workspace download", "rung live --device PLC_1 stop", "rung --device PLC_1 live modify X true", "rung --writes init", "rung setup --grant openness", "node packages/cli/src/bin.js download", 'node "C:/tools/packages/cli/dist/bin.js" live --device PLC_1 stop',
    "echo yes | rung download", "rung live read X; rung live stop", 'rung.exe download',
    "sed -i 's/allow_writes = false/allow_writes = true/' rung.toml",
  ])("denies %s", command => expect(guardCommand(command).allowed).toBe(false));
  it.each(["rung status", "rung --dir download status", "rung live --device PLC_1 read X", "rung download --help", "rung live read X", "rung writes off", "rung init", "rung sync --preview", "rung test", "rung live read X --confirm-stdin", "sed -i 's/V19/V20/' rung.toml"])("permits %s", command => expect(guardCommand(command).allowed).toBe(true));
  it("preserves client approval policy for safe calls and permits reading configuration", () => {
    expect(guardHook({ tool_name: "Bash", tool_input: { command: "rung status" } }, "claude")).toEqual({});
    expect(guardHook({ toolName: "read", toolArgs: { path: "/work/rung.toml" } }, "copilot")).toEqual({});
    expect(guardHook({ toolName: "edit", toolArgs: JSON.stringify({ path: "/work/rung.toml", new_str: "[sync]" }) }, "copilot")).toEqual({});
    expect(guardHook({ toolName: "edit", toolArgs: JSON.stringify({ path: "/work/rung.toml", new_str: "read_only = false" }) }, "copilot")).toMatchObject({ permissionDecision: "deny" });
  });
  it("guards direct writer entrypoints before opening a workspace or native host", async () => {
    const io = { cwd: "/does-not-exist", env: { RUNG_AGENT: "1" }, stdout: () => {}, stderr: () => {} };
    const manual = await manualWorkspace();
    await expect(cmdWrites(manual.root, "on", { ...io, cwd: manual.root, env: manual.env })).rejects.toThrow(/ask the person/i);
    await expect(cmdDownload(manual.root, { yes: true }, { ...io, cwd: manual.root, env: manual.env })).rejects.toThrow(/ask the person/i);
    await expect(onlineHost(io.env, {} as never)).rejects.toThrow(/agent mode check/i);
  });
  it("uses each hook's refusal protocol and protects configuration edits", () => {
    expect(guardHook({ tool_name: "Bash", tool_input: { command: "rung download" } }, "claude")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(guardHook({ command: "rung live stop" }, "cursor")).toMatchObject({ permission: "deny" });
    expect(guardHook({ tool_name: "Edit", tool_input: { file_path: "/work/rung.toml", new_string: "allow_writes = true" } }, "claude")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
  it.each([["download", "--yes"], ["live", "modify", "X", "true", "--confirm-stdin"], ["live", "run"], ["live", "force"], ["writes", "on"], ["init", "--writes"], ["--writes", "init"], ["--yes", "download"], ["setup", "openness"]])("refuses before workspace or backend access: %s", async (...args) => {
    const err: string[] = [];
    const { root, env } = await manualWorkspace();
    expect(await main(args, { cwd: root, env, stdout: () => {}, stderr: text => err.push(text) })).toBe(1);
    expect(err.join("")).toMatch(/ask the person/i);
  });
  it("refuses direct broker mutation before loading config or selecting a backend", async () => {
    const { root, env } = await manualWorkspace();
    const mutations = liveMutations(root, env, async () => { throw new Error("backend accessed"); });
    await expect(mutations.prepare("agent", {}, { action: "run" } as never, {})).rejects.toThrow(/ask the person/i);
    await expect(mutations.commit("agent", "x", "x", true)).rejects.toThrow(/agent mode check/i);
    await mutations.close();
  });
});
