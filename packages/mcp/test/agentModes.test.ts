// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AGENT_ACTIONS, agentModesPath, defaultConfig, saveConfig, workspaceModeKey } from "@rung/core";
import { createMcpServer } from "../src/server.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("agent modes in MCP status", () => {
  it.each(["manual", "ask", "auto", "bypass"] as const)("reports %s and the actions that can run unattended", async mode => {
    const folder = await mkdtemp(join(tmpdir(), "rung-mcp-modes-"));
    roots.push(folder);
    const root = join(folder, "workspace");
    await mkdir(root);
    const config = defaultConfig("fake.ap20", "V20", "", ["PLC_1", "Locked"]);
    config.plc.Locked = { readOnly: true, mode: "PN/IE", pcInterface: "fake", pcInterfaceNumber: 1 };
    await saveConfig(root, config);
    const env = { APPDATA: join(folder, "config"), XDG_CONFIG_HOME: join(folder, "config") };
    const file = agentModesPath(env);
    await mkdir(dirname(file), { recursive: true });
    const expires = "2099-01-01T00:00:00.000Z";
    await writeFile(file, stringify({ workspaces: { [workspaceModeKey(root)]: { default: { mode, actions: ["write"], expires } } } }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ root, env });
    await server.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    try {
      const result = await client.callTool({ name: "rung_status", arguments: {} });
      const status = result.structuredContent!.result as { agentModes: unknown[] };
      expect(status.agentModes).toEqual(expect.arrayContaining([
        expect.objectContaining({ plc: "Locked", mode, source: "workspace", expires, readOnly: expect.any(String), allowedActions: [], asksFor: [] }),
        expect.objectContaining({ plc: "PLC_1", mode, source: "workspace", expires,
          allowedActions: mode === "bypass" ? [...AGENT_ACTIONS] : mode === "auto" ? ["write"] : [],
          asksFor: mode === "ask" ? [...AGENT_ACTIONS] : mode === "auto" ? AGENT_ACTIONS.filter(action => action !== "write") : [] }),
      ]));
      expect(client.getInstructions()).toMatch(/never change.*agent-mode/i);
    } finally { await client.close(); await server.close(); }
  });
});
