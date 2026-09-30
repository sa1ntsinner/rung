// SPDX-License-Identifier: BUSL-1.1
// The MCP tools do what their descriptions promise, and when they cannot, say what to do next.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StateStore, defaultConfig, saveConfig, type RungConfig } from "@rung/core";
import { pull } from "@rung/sync";
import { createMcpServer, type McpContext } from "../src/index.js";
import { FakeBridge } from "../../sync/test/fake-bridge.js";

const MOTOR = 'FUNCTION_BLOCK "Fx_Motor"\nVAR_INPUT\n  Start : Bool;\nEND_VAR\nBEGIN\n  #nope := 1;\nEND_FUNCTION_BLOCK\n';

async function connect(root: string, extra: Partial<McpContext> = {}) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ root, ...extra }).connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, text: r.content[0]!.text };
  };
}

/** A workspace mirrored from a fake project with one FB on PLC_1. */
async function workspace(cfg: (c: RungConfig) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "rung-mcp-tools-"));
  const bridge = new FakeBridge();
  bridge.add("plc:PLC_1/blocks/Fx_Motor", { content: MOTOR });
  const config = defaultConfig(bridge.info.path, "V20", "fake");
  cfg(config);
  await saveConfig(root, config);
  const state = await StateStore.open(root, { projectPath: bridge.info.path, tiaVersion: "V20", devices: config.devices });
  await pull(root, bridge, state, { config });
  await state.close();
  return { root, bridge, config };
}

describe("rung mcp outside a workspace", () => {
  it("tools that need one say how a person makes one, instead of reporting an empty workspace", async () => {
    const call = await connect(mkdtempSync(join(tmpdir(), "rung-mcp-none-")));
    for (const tool of ["rung_status", "rung_sync", "rung_list", "rung_compile", "rung_download_request"]) {
      const r = await call(tool);
      expect([tool, r.isError, r.text]).toEqual([tool, true, expect.stringMatching(/is not a rung workspace \(no rung\.toml\)\. A person binds a folder to a project with rung init --project <path to the \.ap20 or \.project>, then rung pull\.$/)]);
    }
    expect((await call("rung_check")).isError).toBe(false);
  });
});

describe("rung mcp tools", () => {
  it("compare and the download request name the PLC the workspace mirrors, and ask when there are several", async () => {
    const { root } = await workspace();
    const asked: string[] = [];
    const bridge = (devices: string[]) => async () =>
      Object.assign(new FakeBridge(), {
        close: async () => {},
        compile: async () => [],
        projectInfo: async () => ({ name: "X", path: "C:\\fx\\X.ap20", tiaVersion: "V20", devices, isLocalSession: false }),
        compare: async (device: string) => (asked.push(device), { identical: 1, items: [] }),
      });
    expect((await (await connect(root, { bridgeFactory: bridge(["PLC_1"]) }))("rung_compare")).isError).toBe(false);
    expect(asked).toEqual(["PLC_1"]);
    // nothing mirrored yet: the project's only PLC, whatever its name
    const empty = mkdtempSync(join(tmpdir(), "rung-mcp-empty-"));
    await saveConfig(empty, defaultConfig("C:\\fx\\X.ap20", "V20", "fake"));
    await (await connect(empty, { bridgeFactory: bridge(["Line_A"]) }))("rung_compare");
    expect(asked).toEqual(["PLC_1", "Line_A"]);
    const two = await (await connect(empty, { bridgeFactory: bridge(["Line_A", "Line_B"]) }))("rung_compare");
    expect(two).toEqual({ isError: true, text: "The project has several PLCs (Line_A, Line_B); pass device." });
    const request = await (await connect(empty))("rung_download_request");
    expect(request).toEqual({ isError: true, text: "Nothing is mirrored yet, so rung cannot tell which PLC; pass device." });
    expect((await (await connect(root))("rung_download_request")).text).toMatch(/PLC_1/);
  });

  it("take workspace paths with backslashes, and refuse one that is not a file of the workspace", async () => {
    const { root } = await workspace();
    const call = await connect(root);
    const d = await call("rung_diagnostics", { path: "plc\\PLC_1\\blocks\\Fx_Motor.scl" });
    expect(JSON.parse(d.text).source).toEqual([expect.objectContaining({ path: "plc/PLC_1/blocks/Fx_Motor.scl", code: "UNDECLARED" })]);
    expect(await call("rung_diagnostics", { path: "plc/PLC_1/blocks/Fx_Motr.scl" })).toEqual({ isError: true, text: "plc/PLC_1/blocks/Fx_Motr.scl is not a file of this workspace (rung_list lists the mirrored objects)" });
    expect((await call("rung_diff", { path: "plc\\PLC_1\\blocks\\Fx_Motor.scl" })).text).toBe("(no changes)");
  });

  it("compile and confirm_delete take a workspace path as well as an address", async () => {
    const { root, config } = await workspace();
    const compiled: string[][] = [];
    const deleted: string[] = [];
    const bridgeFactory = async () =>
      Object.assign(new FakeBridge(), {
        close: async () => {},
        compile: async (_d: string, addresses: string[]) => (compiled.push(addresses), []),
        deleteObject: async (address: string) => (deleted.push(address), undefined),
      }) as never;
    const call = await connect(root, { bridgeFactory });
    expect((await call("rung_compile", { addresses: ["plc/PLC_1/blocks/Fx_Motor.scl"] })).isError).toBe(false);
    expect(compiled).toEqual([["plc:PLC_1/blocks/Fx_Motor"]]);
    // deleted in the workspace, then confirmed by its path
    unlinkSync(join(root, "plc", "PLC_1", "blocks", "Fx_Motor.scl"));
    const state = await StateStore.open(root, { projectPath: config.project.path, tiaVersion: "V20", devices: [] });
    state.upsert({ ...state.get("plc:PLC_1/blocks/Fx_Motor")!, status: "pendingDelete" });
    await state.close();
    expect(await call("rung_confirm_delete", { address: "plc/PLC_1/blocks/Fx_Motor.scl" })).toEqual({ isError: false, text: "deleted plc:PLC_1/blocks/Fx_Motor" });
    expect(deleted).toEqual(["plc:PLC_1/blocks/Fx_Motor"]);
  });

  it("list takes only the statuses it knows, and test says when a filter matches nothing", async () => {
    const { root } = await workspace();
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "motor.test.yaml"), "block: Fx_Motor\ncases:\n  - steps:\n      - cycle: 1\n");
    const call = await connect(root);
    expect((await call("rung_list", { status: "conflict" })).isError).toBe(true);
    expect(JSON.parse((await call("rung_list", { status: "synced" })).text)).toEqual([expect.objectContaining({ path: "plc/PLC_1/blocks/Fx_Motor.scl" })]);
    expect(await call("rung_test", { filter: "valve" })).toEqual({ isError: false, text: 'No tests match "valve" (by file path or block name); tests/**/*.test.yaml has 1 file.' });
  });

  it("live reads never send the password over plain http to a PLC on the network", async () => {
    const { root } = await workspace((c) => (c.live = { webapi: { url: "http://192.0.2.10", user: "Administrator" } }));
    const call = await connect(root, { env: { RUNG_WEBAPI_PASSWORD: "pw" } });
    expect(await call("rung_live_read", { names: ['"Fx_Global".Counter'] })).toEqual({
      isError: true,
      text: "http://192.0.2.10 is plain http: the password would travel unencrypted. Use https:// (set insecure = true for the PLC's self-signed certificate), or set RUNG_WEBAPI_ALLOW_HTTP=1 if you really mean it",
    });
  });
});
