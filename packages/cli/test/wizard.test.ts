// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAction, bundledSkills, planSetup, summarizePlan } from "../src/wizard.js";
import { main } from "../src/main.js";

const tmp = () => mkdtempSync(join(tmpdir(), "rung-wizard-"));

describe("rung setup", () => {
  it("stops at a value it does not know instead of planning nothing, before it looks at the PC", async () => {
    const dir = tmp();
    const err: string[] = [];
    const run = (...args: string[]) => main(["setup", "--dry-run", ...args], { cwd: dir, stdout: () => {}, stderr: (s) => err.push(s), env: {}, prompt: async () => "" });
    expect(await run("--agents", "Claude,copilot-cli")).toBe(1);
    expect(await run("--editors", "code")).toBe(1);
    expect(await run("--platforms", "s7")).toBe(1);
    expect(await run("--skills", "nope")).toBe(1);
    expect(await run("--scope", "workspace")).toBe(1);
    expect(err.join("")).toBe(
      [
        "rung: BAD_ARGUMENT: --agents takes claude, codex, cursor, gemini, opencode, copilot, zed; not copilot-cli",
        "rung: BAD_ARGUMENT: --editors takes vscode, zed, neovim; not code",
        "rung: BAD_ARGUMENT: --platforms takes tia, twincat, codesys; not s7",
        `rung: BAD_ARGUMENT: --skills takes all or skill names (${bundledSkills({}).map((s) => s.name).join(", ")}); not nope`,
        "rung: BAD_ARGUMENT: --scope is project or global; not workspace",
        "",
      ].join("\n"),
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("ships the PLC skills and tags them by platform", () => {
    const s = bundledSkills({});
    const names = s.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["plc-engineer", "scl-craft", "rung-safety", "iec-st-portable"]));
    expect(s.find((x) => x.name === "iec-st-portable")!.platforms).toEqual(["twincat", "codesys"]);
    expect(s.find((x) => x.name === "rung-safety")!.platforms).toBe("all");
    expect(s.every((x) => x.description.length > 20)).toBe(true);
  });

  it("plans project-level MCP configs and skill copies per agent, and writes nothing while planning", () => {
    const root = tmp();
    const home = tmp();
    const plan = planSetup({ root, scope: "project", platforms: ["tia"], agents: ["claude", "cursor", "codex"], skills: ["plc-engineer", "rung-safety"], editors: [] }, {}, home);
    const text = summarizePlan(plan).join("\n");
    expect(text).toContain(`set mcpServers.rung in ${join(root, ".mcp.json")}`);
    expect(text).toContain(`set mcpServers.rung in ${join(root, ".cursor", "mcp.json")}`);
    expect(text).toContain(`set [mcp_servers.rung] in ${join(home, ".codex", "config.toml")}`);
    expect(text).toContain(`copy 2 skills to ${join(root, ".claude", "skills")}`);
    expect(text).toContain(`copy 2 skills to ${join(root, ".agents", "skills")}`); // Cursor and Codex share .agents/skills
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });

  it("global scope goes to the user's agent folders and uses claude mcp add", () => {
    const home = tmp();
    const plan = planSetup({ root: tmp(), scope: "global", platforms: [], agents: ["claude", "gemini"], skills: ["plc-engineer"], editors: [] }, {}, home);
    expect(plan).toContainEqual(expect.objectContaining({ kind: "run", command: "claude", args: expect.arrayContaining(["mcp", "add", "--scope", "user", "rung"]) }));
    expect(plan).toContainEqual(expect.objectContaining({ kind: "json", file: join(home, ".gemini", "settings.json") }));
    expect(plan).toContainEqual(expect.objectContaining({ kind: "copy-skill", to: join(home, ".claude", "skills", "plc-engineer") }));
  });

  it("merges into existing configs instead of replacing them", async () => {
    const root = tmp();
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "config.toml"), 'model = "o4"\n\n[mcp_servers.rung]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "y"\n');
    for (const a of planSetup({ root, scope: "project", platforms: [], agents: ["claude", "codex"], skills: [], editors: [] }, {}, root)) await applyAction(a);
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["other", "rung"]);
    const toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('model = "o4"');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml.match(/\[mcp_servers\.rung\]/g)).toHaveLength(1);
    expect(toml).not.toContain('command = "old"');
  });

  it("refuses to touch a config it cannot parse", async () => {
    const root = tmp();
    writeFileSync(join(root, ".mcp.json"), "{ not json");
    const [a] = planSetup({ root, scope: "project", platforms: [], agents: ["claude"], skills: [], editors: [] }, {}, root);
    await expect(applyAction(a!)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe("{ not json");
  });
});
