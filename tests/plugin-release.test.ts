// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { installRoot, rungCommand } from "../packages/cli/src/paths.js";

const plugin = resolve("agents/claude-plugin");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const temporary: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "rung plugin ")); temporary.push(dir); return dir; };
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Claude plugin", () => {
  it("uses the same plugin-local launcher for MCP, SCL diagnostics and the shell guard", () => {
    const mcp = json(join(plugin, ".mcp.json")).mcpServers.rung;
    const lsp = json(join(plugin, ".lsp.json")).rung;
    expect(mcp).toMatchObject({ command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/rung.cjs", "mcp"] });
    expect(lsp).toMatchObject({ command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/rung.cjs", "lsp", "--stdio"] });
    expect(Object.keys(lsp.extensionToLanguage).sort()).toEqual([".awl", ".db", ".s7dcl", ".scl", ".st", ".udt"]);
    const hook = json(join(plugin, "hooks/hooks.json")).hooks.PreToolUse[0];
    expect(hook.matcher).toBe("Bash|PowerShell|Write|Edit");
    expect(hook.hooks[0]).toMatchObject({ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/rung.cjs" guard --claude-hook' });
  });

  it("allows only named read tools in both subagents", () => {
    const safe = new Set(["Read", "Grep", "Glob", "LSP", ...[
      "review", "status", "diagnostics", "diff", "impact", "graph", "find_usages", "explain",
      "live_state", "live_alarms", "live_diag", "live_read", "compare", "why",
    ].map((tool) => `mcp__plugin_rung_rung__rung_${tool}`)]);
    for (const agent of ["plc-reviewer", "plc-diagnostician"]) {
      const source = readFileSync(join(plugin, "agents", `${agent}.md`), "utf8");
      const tools = /^tools: (.+)$/m.exec(source)![1].split(", ");
      expect(tools.length).toBeGreaterThan(3);
      expect(tools.every((tool) => safe.has(tool))).toBe(true);
      expect(source).toMatch(/disallowedTools: Bash, PowerShell, Write, Edit, NotebookEdit, Agent/);
      expect(source).toMatch(/read.only/i);
    }
  });

  it("launches a packaged CLI from a copied plugin in a path with spaces, forwarding arguments and exit status", () => {
    const root = temp();
    const cached = join(root, "cached plugin");
    cpSync(plugin, cached, { recursive: true });
    mkdirSync(join(cached, "bin", "runtime"), { recursive: true });
    writeFileSync(join(cached, "bin", "runtime", "rung.cjs"), 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;');
    const result = spawnSync(process.execPath, [join(cached, "bin", "rung.cjs"), "mcp", "MixingStation with spaces"], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual(["mcp", "MixingStation with spaces"]);
  });

  it("keeps companion paths and broker launches beside the selected runtime after caching", () => {
    const root = temp();
    const cached = join(root, "cached plugin");
    cpSync(plugin, cached, { recursive: true });
    const runtime = join(cached, "bin", "runtime");
    mkdirSync(join(runtime, "bridge"), { recursive: true });
    writeFileSync(join(runtime, "bridge", "host.fixture"), "offline companion");
    writeFileSync(join(runtime, "rung.cjs"), 'const fs = require("node:fs"); const path = require("node:path"); console.log(JSON.stringify({ home: process.env.RUNG_HOME, companion: fs.readFileSync(path.join(process.env.RUNG_HOME, "bridge", "host.fixture"), "utf8") }));');
    const result = spawnSync(process.execPath, [join(cached, "bin", "rung.cjs"), "mcp"], { encoding: "utf8", windowsHide: true, env: { ...process.env, RUNG_HOME: "unrelated installation" } });
    expect(result.status, result.stderr).toBe(0);
    const details = JSON.parse(result.stdout);
    expect(details).toEqual({ home: runtime, companion: "offline companion" });
    expect(installRoot({ RUNG_HOME: details.home })).toBe(runtime);
    expect(rungCommand(["live-server"], { RUNG_HOME: details.home }).args).toEqual([join(runtime, "rung.cjs"), "live-server"]);
  });

  it("prefers the release CLI beside its companions over a cached runtime", () => {
    const root = temp();
    const installed = join(root, "agents", "claude-plugin");
    cpSync(plugin, installed, { recursive: true });
    mkdirSync(join(installed, "bin", "runtime"), { recursive: true });
    writeFileSync(join(installed, "bin", "runtime", "rung.cjs"), 'throw new Error("should use release CLI");');
    writeFileSync(join(root, "rung.cjs"), 'console.log(process.env.RUNG_HOME);');
    const result = spawnSync(process.execPath, [join(installed, "bin", "rung.cjs"), "mcp"], { encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(root);
  });

  it("reports a missing bundled CLI clearly without searching the shell PATH", () => {
    const root = temp();
    cpSync(join(plugin, "bin"), join(root, "bin"), { recursive: true });
    const result = spawnSync(process.execPath, [join(root, "bin", "rung.cjs"), "mcp"], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/CLI.*missing|missing.*CLI/i);
    const hook = spawnSync(process.execPath, [join(root, "bin", "rung.cjs"), "guard", "--claude-hook"], { encoding: "utf8", windowsHide: true });
    expect(hook.status).toBe(2);
  });

  it("stages a self-contained plugin with the release version even when the source manifest is stale", async () => {
    const root = temp();
    const staged = join(root, "release");
    mkdirSync(join(root, "agents", "claude-plugin", ".claude-plugin"), { recursive: true });
    mkdirSync(join(root, "agents", ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, "agents", "claude-plugin", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "rung", version: "0.0.1" }));
    writeFileSync(join(root, "agents", ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "rung", source: "./claude-plugin" }] }));
    mkdirSync(staged);
    writeFileSync(join(staged, "rung.cjs"), "fixture runtime");
    for (const dir of ["bridge", "source", "LICENSES", "tools"]) {
      mkdirSync(join(staged, dir));
      writeFileSync(join(staged, dir, "fixture.txt"), dir);
    }
    for (const file of ["LICENSE.txt", "THIRD_PARTY_NOTICES.txt", "AGENTS.template.md"]) writeFileSync(join(staged, file), file);
    const { stagePlugin } = await import("../tools/release/plugin.mjs");
    stagePlugin(root, staged, "9.8.7");
    expect(json(join(staged, "agents", "claude-plugin", ".claude-plugin", "plugin.json")).version).toBe("9.8.7");
    const runtime = join(staged, "agents", "claude-plugin", "bin", "runtime");
    expect(readFileSync(join(runtime, "rung.cjs"), "utf8")).toBe("fixture runtime");
    for (const dir of ["bridge", "source", "LICENSES", "tools"]) expect(readFileSync(join(runtime, dir, "fixture.txt"), "utf8")).toBe(dir);
    for (const file of ["LICENSE.txt", "THIRD_PARTY_NOTICES.txt", "AGENTS.template.md"]) expect(readFileSync(join(runtime, file), "utf8")).toBe(file);
    expect(existsSync(join(staged, "agents", ".claude-plugin", "marketplace.json"))).toBe(true);
    expect(json(join(root, "agents", "claude-plugin", ".claude-plugin", "plugin.json")).version).toBe("0.0.1");
  });

  it("keeps package, extension and plugin versions together", () => {
    const version = json("packages/cli/package.json").version;
    expect(version).toBe("0.3.2");
    for (const name of ["bridge-client", "core", "graph", "live", "lsp", "mcp", "sim", "sync"]) {
      expect(json(`packages/${name}/package.json`).version).toBe(version);
    }
    expect(json("editors/vscode/package.json").version).toBe(version);
    expect(json("editors/vscode/package-lock.json").version).toBe(version);
    expect(json(join(plugin, ".claude-plugin/plugin.json")).version).toBe(version);
    expect(readFileSync("editors/zed/extension.toml", "utf8")).toContain(`version = "${version}"`);
    expect(readFileSync("editors/zed/Cargo.toml", "utf8")).toContain(`version = "${version}"`);
    expect(readFileSync("editors/zed/Cargo.lock", "utf8")).toContain(`name = "rung-zed"\nversion = "${version}"`);
    for (const adapter of ["V19", "V20", "V21"]) {
      expect(readFileSync(`bridge/src/Rung.Bridge.${adapter}/Rung.Bridge.${adapter}.csproj`, "utf8")).toContain(`<Version>${version}</Version>`);
    }
  });
});
