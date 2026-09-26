// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StateStore, defaultConfig, saveConfig } from "@rung/core";
import { pull } from "@rung/sync";
import { createMcpServer } from "../src/index.js";
import { FakeBridge } from "../../sync/test/fake-bridge.js";

let root: string;
let client: Client;
const MOTOR = 'FUNCTION_BLOCK "Fx_Motor"\nVAR_INPUT\n  Start : Bool; // start command\nEND_VAR\nBEGIN\n  "Fx_Global".Counter := "Fx_Global".Counter + 1;\n  #nope := 1;\nEND_FUNCTION_BLOCK\n';

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const t = r.content[0]!.text;
  let data: unknown = t;
  try {
    data = JSON.parse(t);
  } catch {
    /* plain text */
  }
  return { isError: !!r.isError, data, text: t };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "rung-mcp-"));
  const bridge = new FakeBridge();
  bridge.add("plc:PLC_1/blocks/Fx_Motor", { content: MOTOR });
  bridge.add("plc:PLC_1/blocks/Fx_Global", { form: "db", content: 'DATA_BLOCK "Fx_Global"\nVAR\n  Counter : DInt;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n' });
  bridge.add("plc:PLC_1/blocks/Main", { content: 'ORGANIZATION_BLOCK "Main"\nBEGIN\n  "Fx_Global".Counter := 0;\nEND_ORGANIZATION_BLOCK\n' });
  bridge.add("plc:PLC_1/blocks/Fx_Safety", { language: "F_LAD", isFailsafe: true, form: "xml", content: "<x/>\n" });
  const config = defaultConfig(bridge.info.path, "V20", "fake");
  await saveConfig(root, config);
  const state = await StateStore.open(root, { projectPath: bridge.info.path, tiaVersion: "V20", devices: [] });
  await pull(root, bridge, state, { config });
  await state.close();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ root }).connect(a);
  client = new Client({ name: "test", version: "1" });
  await client.connect(b);
});

describe("rung mcp", () => {
  it("lists a small, documented tool surface and the safety instructions", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["rung_check", "rung_compile", "rung_confirm_delete", "rung_diagnostics", "rung_diff", "rung_download_request", "rung_explain", "rung_find_usages", "rung_graph", "rung_list", "rung_live_read", "rung_resolve", "rung_rules", "rung_status", "rung_sync", "rung_test"]);
    expect(client.getInstructions()).toMatch(/Never download to a PLC/);
  });

  it("reports status without a running watch and lists read-only objects", async () => {
    const s = await call("rung_status");
    expect(s.data).toMatchObject({ watching: false, objects: 4, readOnly: ["plc/PLC_1/blocks/Fx_Safety.xml"] });
  });

  it("explains an object with its interface and users", async () => {
    const e = await call("rung_explain", { name: "Fx_Global" });
    expect(e.data).toMatchObject({ kind: "DB", path: "plc/PLC_1/blocks/Fx_Global.db", interface: [{ name: "Counter", type: "DInt" }] });
    expect((e.data as { usedBy: string[] }).usedBy.sort()).toEqual(["Fx_Motor (reads)", "Fx_Motor (writes)", "Main (writes)"]);
  });

  it("finds usages and impact through the graph, accepting paths", async () => {
    const u = await call("rung_find_usages", { name: "plc/PLC_1/blocks/Fx_Global.db" });
    expect((u.data as { by: string; how: string; members: string[] }[]).find((x) => x.by === "Main")).toMatchObject({ how: "writes", members: ["Counter"] });
    const impact = await call("rung_graph", { query: "impact", name: "Fx_Global" });
    expect((impact.data as { name: string }[]).map((x) => x.name).sort()).toEqual(["Fx_Motor", "Main"]);
    expect((await call("rung_graph", { query: "callers", name: "Nope" })).isError).toBe(true);
  });

  it("returns source diagnostics per file", async () => {
    const d = await call("rung_diagnostics", { path: "plc/PLC_1/blocks/Fx_Motor.scl" });
    expect((d.data as { source: { code: string; line: number }[] }).source).toEqual([expect.objectContaining({ code: "UNDECLARED", line: 7 })]);
  });

  it("diffs a file against the last synced version", async () => {
    const p = join(root, "plc", "PLC_1", "blocks", "Fx_Motor.scl");
    writeFileSync(p, readFileSync(p, "utf8").replace("#nope := 1;", "#Start := TRUE;"));
    const d = await call("rung_diff", { path: "plc/PLC_1/blocks/Fx_Motor.scl" });
    expect(d.text).toContain("-  #nope := 1;");
    expect(d.text).toContain("+  #Start := TRUE;");
  });

  it("refuses to sync or compile without an owner or bridge, and never downloads", async () => {
    expect((await call("rung_sync")).isError).toBe(true);
    expect((await call("rung_compile")).isError).toBe(true);
    const req = (await call("rung_download_request", { device: "PLC_1", summary: "Faster valve close" })).text;
    expect(req).toMatch(/never download/);
    expect(req).toMatch(/Faster valve close/);
    expect(req).toMatch(/rung download/);
  });

  it("serves the graph resource", async () => {
    const r = await client.readResource({ uri: "rung://graph" });
    const g = JSON.parse((r.contents[0] as { text: string }).text) as { nodes: { name: string }[] };
    expect(g.nodes.map((n) => n.name)).toContain("Fx_Motor");
  });
});

