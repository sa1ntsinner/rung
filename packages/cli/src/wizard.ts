// SPDX-License-Identifier: BUSL-1.1
// rung setup: an interactive setup in the style of `graft init` / `npx skills add`: it checks the PC, asks which
// PLC platforms, AI agents, skills and editors to use, shows every file it would touch, and writes only after
// you confirm. --dry-run shows the plan, -y takes the defaults, --agents/--skills/--editors/--scope skip questions.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { LINKS, WorkspaceError, realProbes, runChecks, writeFileAtomic, type CheckItem } from "@rung/core";
import { bridgeExecutable, devPath, installRoot } from "./paths.js";
import { whitelistStatus } from "./setup.js";
import type { Io } from "./common.js";

const run = promisify(execFile);

export type AgentId = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "copilot" | "zed";
export type EditorId = "vscode" | "zed" | "neovim";
export type Platform = "tia" | "twincat" | "codesys";
export type Scope = "project" | "global";

export const AGENTS: Record<AgentId, { name: string; check: string }> = {
  claude: { name: "Claude Code", check: "claude" },
  codex: { name: "Codex CLI", check: "codex" },
  cursor: { name: "Cursor", check: "cursor" },
  gemini: { name: "Gemini CLI", check: "gemini" },
  opencode: { name: "OpenCode", check: "opencode" },
  copilot: { name: "GitHub Copilot (VS Code)", check: "vscode" },
  zed: { name: "Zed agent", check: "zed" },
};

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  platforms: Platform[] | "all";
}

/** Skills that ship with rung (agents/claude-plugin/skills), with the platforms they are for. */
export function bundledSkills(env: Record<string, string | undefined>): SkillInfo[] {
  const root = [installRoot(env) && join(installRoot(env)!, "agents", "claude-plugin", "skills"), devPath("../../../agents/claude-plugin/skills")].find((d): d is string => !!d && existsSync(d));
  if (!root) return [];
  const siemens = new Set(["scl-craft", "lad-in-text", "rung-workflow", "rung-review", "plc-data-design", "plc-commissioning"]);
  return readdirSync(root)
    .filter((n) => existsSync(join(root, n, "SKILL.md")))
    .map((n) => {
      const text = readFileSync(join(root, n, "SKILL.md"), "utf8");
      const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
      return { name: n, description, dir: join(root, n), platforms: n === "iec-st-portable" ? (["twincat", "codesys"] as Platform[]) : siemens.has(n) ? (["tia"] as Platform[]) : "all" };
    });
}

/** How agents start rung's MCP server: absolute paths, because a .cmd shim is not an executable for them. */
export function rungCommand(): { command: string; args: string[] } {
  const exe = process.execPath;
  if (/rung(\.exe)?$/i.test(exe)) return { command: exe, args: [] }; // the single-executable release
  // the VS Code extension's rung runs in VS Code's executable: agents start it through its `rung` command
  if (process.versions.electron && process.env.RUNG_HOME) {
    const shim = join(dirname(resolve(process.env.RUNG_HOME)), process.platform === "win32" ? "rung.cmd" : "rung");
    if (existsSync(shim)) return { command: shim, args: [] };
  }
  return { command: exe, args: [resolve(process.argv[1] ?? "")] };
}

export interface Choices {
  root: string;
  scope: Scope;
  platforms: Platform[];
  agents: AgentId[];
  skills: string[];
  editors: EditorId[];
}

export type Action =
  | { kind: "copy-skill"; skill: string; from: string; to: string }
  | { kind: "json"; file: string; path: string[]; value: unknown; why: string }
  | { kind: "toml-table"; file: string; table: string; body: string; why: string }
  | { kind: "run"; command: string; args: string[]; why: string }
  | { kind: "note"; text: string };

/** Everything setup would do, without doing it. */
export function planSetup(c: Choices, env: Record<string, string | undefined>, home = homedir()): Action[] {
  const actions: Action[] = [];
  const mcp = rungCommand();
  const mcpArgs = [...mcp.args, "mcp", ...(c.scope === "project" ? [c.root] : [])];
  const skills = bundledSkills(env).filter((s) => c.skills.includes(s.name));
  const skillDirs = new Set<string>();
  const at = (proj: string, glob: string) => (c.scope === "project" ? join(c.root, proj) : join(home, glob));
  for (const a of c.agents) {
    switch (a) {
      case "claude":
        skillDirs.add(at(".claude/skills", ".claude/skills"));
        if (c.scope === "project") actions.push({ kind: "json", file: join(c.root, ".mcp.json"), path: ["mcpServers", "rung"], value: { command: mcp.command, args: mcpArgs }, why: "Claude Code: rung MCP server for this project" });
        else actions.push({ kind: "run", command: "claude", args: ["mcp", "add", "--scope", "user", "rung", "--", mcp.command, ...mcpArgs], why: "Claude Code: rung MCP server for all projects" });
        break;
      case "codex":
        skillDirs.add(at(".agents/skills", ".codex/skills"));
        // Codex reads one config for every project: the server finds the workspace it is started in, never a fixed one
        actions.push({ kind: "toml-table", file: join(home, ".codex", "config.toml"), table: "mcp_servers.rung", body: `command = ${JSON.stringify(mcp.command)}\nargs = ${JSON.stringify([...mcp.args, "mcp"])}`, why: "Codex: rung MCP server (all projects)" });
        break;
      case "cursor":
        skillDirs.add(at(".agents/skills", ".cursor/skills"));
        actions.push({ kind: "json", file: at(".cursor/mcp.json", ".cursor/mcp.json"), path: ["mcpServers", "rung"], value: { command: mcp.command, args: mcpArgs }, why: "Cursor: rung MCP server" });
        break;
      case "gemini":
        skillDirs.add(at(".agents/skills", ".gemini/skills"));
        actions.push({ kind: "json", file: at(".gemini/settings.json", ".gemini/settings.json"), path: ["mcpServers", "rung"], value: { command: mcp.command, args: mcpArgs }, why: "Gemini CLI: rung MCP server" });
        break;
      case "opencode":
        skillDirs.add(at(".agents/skills", ".config/opencode/skills"));
        actions.push({ kind: "json", file: at("opencode.json", ".config/opencode/opencode.json"), path: ["mcp", "rung"], value: { type: "local", command: [mcp.command, ...mcpArgs] }, why: "OpenCode: rung MCP server" });
        break;
      case "copilot":
        skillDirs.add(at(".agents/skills", ".copilot/skills"));
        if (c.scope === "project") actions.push({ kind: "json", file: join(c.root, ".vscode", "mcp.json"), path: ["servers", "rung"], value: { type: "stdio", command: mcp.command, args: mcpArgs }, why: "GitHub Copilot in VS Code: rung MCP server" });
        else actions.push({ kind: "note", text: "GitHub Copilot: add the rung MCP server per project (rung setup in the project), VS Code has no user-wide MCP file." });
        break;
      case "zed":
        skillDirs.add(at(".agents/skills", ".agents/skills"));
        // Zed reads context servers from its settings; a project's own .zed/settings.json is plain JSON
        if (c.scope === "project") actions.push({ kind: "json", file: join(c.root, ".zed", "settings.json"), path: ["context_servers", "rung"], value: { command: mcp.command, args: mcpArgs, env: {} }, why: "Zed agent: rung MCP server for this project" });
        else actions.push({ kind: "note", text: `Zed agent: add to Zed's settings (zed: open settings): "context_servers": { "rung": { "command": ${JSON.stringify(mcp.command)}, "args": ${JSON.stringify(mcpArgs)} } }` });
        break;
    }
  }
  for (const d of [...skillDirs].sort()) for (const s of skills) actions.push({ kind: "copy-skill", skill: s.name, from: s.dir, to: join(d, s.name) });

  for (const e of c.editors) {
    if (e === "vscode") {
      const vsix = [installRoot(env) && join(installRoot(env)!, "editors", "rung-scl.vsix"), devPath("../../../editors/vscode/rung-scl.vsix")].find((f): f is string => !!f && existsSync(f));
      actions.push(vsix ? { kind: "run", command: "code", args: ["--install-extension", vsix, "--force"], why: "VS Code: install the rung extension" } : { kind: "note", text: "VS Code: rung-scl.vsix not found in this installation; see the editors guide." });
    }
    if (e === "zed") actions.push({ kind: "note", text: "Zed: Extensions → install Siemens SCL (until it is listed: Install Dev Extension → the rung editors/zed folder, needs Rust via rustup). Guide: " + LINKS.rungEditors });
    if (e === "neovim") actions.push({ kind: "note", text: "Neovim: copy the lspconfig snippet from the editors guide: " + LINKS.rungEditors });
  }
  return actions;
}

// ------------------------------------------------------------------ applying

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${file} is not valid JSON; fix or remove it first`);
  }
}

async function copyDir(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) await copyDir(join(from, e.name), join(to, e.name));
    else await writeFileAtomic(join(to, e.name), await readFile(join(from, e.name)));
  }
}

export async function applyAction(a: Action): Promise<string> {
  switch (a.kind) {
    case "copy-skill":
      await copyDir(a.from, a.to);
      return `skill ${a.skill} → ${a.to}`;
    case "json": {
      const doc = await readJson(a.file);
      let node: Record<string, unknown> = doc;
      for (const k of a.path.slice(0, -1)) node = (node[k] ??= {}) as Record<string, unknown>;
      node[a.path[a.path.length - 1]!] = a.value;
      await mkdir(dirname(a.file), { recursive: true });
      await writeFileAtomic(a.file, JSON.stringify(doc, null, 2) + "\n");
      return `${a.why} (${a.file})`;
    }
    case "toml-table": {
      const text = existsSync(a.file) ? await readFile(a.file, "utf8") : "";
      const header = `[${a.table}]`;
      const lines = text.split(/\r?\n/);
      const start = lines.findIndex((l) => l.trim().replace(/\s+/g, "") === header);
      let next: string;
      if (start < 0) next = (text ? text.replace(/\s*$/, "\n\n") : "") + `${header}\n${a.body}\n`;
      else {
        let end = start + 1;
        while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
        next = [...lines.slice(0, start), header, ...a.body.split("\n"), "", ...lines.slice(end)].join("\n");
      }
      await mkdir(dirname(a.file), { recursive: true });
      await writeFileAtomic(a.file, next);
      return `${a.why} (${a.file})`;
    }
    case "run": {
      const win = process.platform === "win32";
      await run(win ? "cmd.exe" : a.command, win ? ["/d", "/c", a.command, ...a.args] : a.args, { windowsHide: true, timeout: 120_000 });
      return a.why;
    }
    case "note":
      return a.text;
  }
}

export function describeAction(a: Action): string {
  switch (a.kind) {
    case "copy-skill":
      return `copy skill ${a.skill} to ${a.to}`;
    case "json":
      return `set ${a.path.join(".")} in ${a.file}`;
    case "toml-table":
      return `set [${a.table}] in ${a.file}`;
    case "run":
      return `run ${a.command} ${a.args.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ")}`;
    case "note":
      return a.text;
  }
}

// ------------------------------------------------------------------ the interactive part

const list = (v: unknown) => (typeof v === "string" ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined);

/** A value setup does not know would leave its part out of the plan without a word: refuse it and list what fits. */
function checkChoices(v: Record<string, unknown>, env: Record<string, string | undefined>) {
  const known = (option: string, values: readonly string[], allowed: string) => {
    const bad = list(v[option])?.find((x) => !values.includes(x));
    if (bad) throw new WorkspaceError("BAD_ARGUMENT", `--${option} takes ${allowed}; not ${bad}`);
  };
  known("agents", Object.keys(AGENTS), Object.keys(AGENTS).join(", "));
  known("editors", ["vscode", "zed", "neovim"], "vscode, zed, neovim");
  known("platforms", ["tia", "twincat", "codesys"], "tia, twincat, codesys");
  const skills = bundledSkills(env).map((s) => s.name);
  if (v.skills !== "all") known("skills", skills, `all or skill names (${skills.join(", ")})`);
  if (v.scope !== undefined && !["project", "global"].includes(String(v.scope).toLowerCase())) throw new WorkspaceError("BAD_ARGUMENT", `--scope is project or global; not ${String(v.scope)}`);
}

export async function cmdSetupWizard(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  checkChoices(v, io.env);
  const interactive = !v.yes && !!process.stdin.isTTY && !io.prompt;
  const env = io.env;
  const cancelled = (x: unknown): x is symbol => p.isCancel(x);
  if (interactive) p.intro("rung setup");
  const spin = interactive ? p.spinner() : null;
  spin?.start("Checking this PC");
  const checks: CheckItem[] = await runChecks(realProbes(env, () => whitelistStatus(bridgeExecutable(env))));
  spin?.stop("Checked this PC");
  const has = (id: string) => checks.find((c) => c.id === id)?.status === "ok";

  // platforms
  const platformDefault: Platform[] = (["tia", "twincat", "codesys"] as Platform[]).filter((x) => has(x));
  let platforms = (list(v.platforms) as Platform[] | undefined) ?? platformDefault;
  if (interactive && !v.platforms) {
    const r = await p.multiselect({
      message: "Which PLC platforms do you work with?",
      options: [
        { value: "tia", label: "Siemens TIA Portal", hint: has("tia") ? "installed" : "not installed" },
        { value: "twincat", label: "Beckhoff TwinCAT 3", hint: has("twincat") ? "installed" : "not installed" },
        { value: "codesys", label: "CODESYS", hint: has("codesys") ? "installed" : "not installed" },
      ],
      initialValues: platformDefault.length ? platformDefault : ["tia"],
      required: false,
    });
    if (cancelled(r)) return p.cancel("Nothing was changed."), 1;
    platforms = r as Platform[];
  }
  // what these platforms still need
  const needs = checks.filter((c) => c.status !== "ok" && c.fix && ((platforms.includes("tia") && ["tia", "openness", "openness-group", "whitelist", "plcsim"].includes(c.id)) || (platforms.includes("twincat") && c.id === "twincat") || (platforms.includes("codesys") && c.id === "codesys")));
  if (needs.length) {
    const text = needs.map((c) => `${c.name}: ${c.fix}${c.link ? `\n  ${c.link}` : ""}`).join("\n");
    if (interactive) p.note(text, "Still to install or set up");
    else io.stdout(`Still to install or set up:\n${text}\n\n`);
  }

  // agents
  const agentDefault = (Object.keys(AGENTS) as AgentId[]).filter((a) => has(AGENTS[a].check));
  let agents = (list(v.agents) as AgentId[] | undefined) ?? agentDefault;
  if (interactive && !v.agents) {
    const r = await p.multiselect({
      message: "Wire rung into which AI agents?",
      options: (Object.keys(AGENTS) as AgentId[]).map((a) => ({ value: a, label: AGENTS[a].name, hint: has(AGENTS[a].check) ? "found" : "not found" })),
      initialValues: agentDefault,
      required: false,
    });
    if (cancelled(r)) return p.cancel("Nothing was changed."), 1;
    agents = r as AgentId[];
  }

  // scope
  const asked = typeof v.scope === "string" ? v.scope.toLowerCase() : undefined;
  let scope: Scope = asked === "global" ? "global" : asked === "project" ? "project" : existsSync(join(dir, "rung.toml")) ? "project" : "global";
  if (interactive && !v.scope && agents.length) {
    const r = await p.select({
      message: "Where should agents get rung?",
      options: [
        { value: "project", label: `This workspace`, hint: dir },
        { value: "global", label: "All my projects", hint: "user-level agent config" },
      ],
      initialValue: scope,
    });
    if (cancelled(r)) return p.cancel("Nothing was changed."), 1;
    scope = r as Scope;
  }

  // skills
  const all = bundledSkills(env);
  const fits = (s: SkillInfo) => s.platforms === "all" || s.platforms.some((x) => platforms.includes(x));
  let skills = v.skills === "all" ? all.map((s) => s.name) : (list(v.skills) ?? all.filter(fits).map((s) => s.name));
  if (interactive && !v.skills && agents.length) {
    const r = await p.multiselect({
      message: "Which skills should the agents get?",
      options: all.map((s) => ({ value: s.name, label: s.name, hint: s.description.replace(/^Use (when|for|before) /i, "").slice(0, 70) })),
      initialValues: all.filter(fits).map((s) => s.name),
      required: false,
    });
    if (cancelled(r)) return p.cancel("Nothing was changed."), 1;
    skills = r as string[];
  }

  // editors
  const editorDefault = (["vscode", "zed"] as EditorId[]).filter((e) => checks.find((c) => c.id === e)?.status === "warn");
  let editors = (list(v.editors) as EditorId[] | undefined) ?? editorDefault;
  if (interactive && !v.editors) {
    const r = await p.multiselect({
      message: "Set up rung in which editors?",
      options: [
        { value: "vscode", label: "VS Code", hint: checks.find((c) => c.id === "vscode")?.detail ?? "not installed" },
        { value: "zed", label: "Zed", hint: checks.find((c) => c.id === "zed")?.detail ?? "not installed" },
        { value: "neovim", label: "Neovim", hint: has("neovim") ? "found" : "not installed" },
      ],
      initialValues: editorDefault,
      required: false,
    });
    if (cancelled(r)) return p.cancel("Nothing was changed."), 1;
    editors = r as EditorId[];
  }

  const actions = planSetup({ root: resolve(dir), scope, platforms, agents, skills, editors }, env);
  const plan = summarizePlan(actions).map((l) => `• ${l}`).join("\n") || "nothing to do";
  if (v["dry-run"]) {
    io.stdout(`rung setup would:\n${plan}\n`);
    return 0;
  }
  if (interactive) {
    p.note(plan, "rung setup will");
    const ok = await p.confirm({ message: "Go ahead?" });
    if (cancelled(ok) || !ok) return p.cancel("Nothing was changed."), 1;
  }
  let failed = 0;
  for (const a of actions) {
    try {
      const done = await applyAction(a);
      if (interactive) p.log.success(done);
      else io.stdout(`✓ ${done}\n`);
    } catch (e) {
      failed++;
      const msg = `${describeAction(a)}: ${(e as Error).message.split("\n")[0]}`;
      if (interactive) p.log.error(msg);
      else io.stderr(`✗ ${msg}\n`);
    }
  }
  if (interactive) p.outro(failed ? `Done with ${failed} problem(s).` : "Done. rung check shows the state any time.");
  return failed ? 2 : 0;
}

/** The plan as a person reads it: skill copies grouped per folder. */
export function summarizePlan(actions: Action[]): string[] {
  const out: string[] = [];
  const skillsByDir = new Map<string, string[]>();
  for (const a of actions) if (a.kind === "copy-skill") skillsByDir.set(dirname(a.to), [...(skillsByDir.get(dirname(a.to)) ?? []), a.skill]);
  for (const a of actions) if (a.kind !== "copy-skill") out.push(describeAction(a));
  for (const [d, names] of skillsByDir) out.push(`copy ${names.length} skill${names.length === 1 ? "" : "s"} to ${d} (${names.join(", ")})`);
  return out;
}
