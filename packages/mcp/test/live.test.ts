// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultConfig, saveConfig } from "@rung/core";
import { createMcpServer } from "../src/index.js";

const plc = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const one = (r: { id: number; method: string; params?: { var?: string } }) =>
      r.method === "Api.Login" ? { jsonrpc: "2.0", id: r.id, result: "T" } : r.method === "Api.Logout" ? { jsonrpc: "2.0", id: r.id, result: true } : { jsonrpc: "2.0", id: r.id, result: r.params?.var === '"Fx_Global".Counter' ? 7 : null };
    const p = JSON.parse(body);
    res.end(JSON.stringify(Array.isArray(p) ? p.map(one) : one(p)));
  });
});
afterAll(() => plc.close());

async function connect(env: Record<string, string>, withLive: boolean) {
  const root = mkdtempSync(join(tmpdir(), "rung-mcp-live-"));
  await new Promise<void>((r) => (plc.listening ? r() : plc.listen(0, "127.0.0.1", () => r())));
  const cfg = defaultConfig("C:\\fx\\X.ap20", "V20", "none");
  if (withLive) cfg.live = { webapi: { url: `http://127.0.0.1:${(plc.address() as { port: number }).port}`, user: "Administrator" } };
  await saveConfig(root, cfg);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ root, env }).connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  return client;
}

describe("rung_live_read", () => {
  it("uses the selected shared backend and reports PLC provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-mcp-live-"));
    await saveConfig(root, defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]));
    const scope = { device: "PLC_1", address: "192.168.250.1", transport: "s7commplus" as const, epoch: 2 };
    const [a, b] = InMemoryTransport.createLinkedPair();
    let selected: unknown, closed = false;
    await createMcpServer({ root, liveFactory: async (opts) => { selected = opts; return { readFrame: async (names) => ({ at: 1, scope, items: names.map((name) => ({ name, value: 7 })) }), close: async () => { closed = true; } }; } }).connect(a);
    const c = new Client({ name: "t", version: "1" }); await c.connect(b);
    const r = await c.callTool({ name: "rung_live_read", arguments: { names: ["x"], device: "PLC_1", transport: "s7commplus" } }) as { content: { text: string }[] };
    expect(selected).toEqual({ device: "PLC_1", transport: "s7commplus" });
    expect(JSON.parse(r.content[0]!.text)).toEqual({ at: 1, scope, items: [{ name: "x", value: 7 }] });
    expect(closed).toBe(true);
    const unavailable = await c.callTool({ name: "rung_live_alarms", arguments: { device: "PLC_1" } });
    expect(unavailable.isError).toBe(true);
    expect(JSON.stringify(unavailable.content)).toMatch(/unavailable/);
    expect((await c.listTools()).tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining(["rung_live_modify", "rung_live_run", "rung_live_stop", "rung_live_acknowledge"]));
    await c.close();
  });
  it("reads values from the PLC Web API", async () => {
    const c = await connect({ RUNG_WEBAPI_PASSWORD: "pw" }, true);
    const r = (await c.callTool({ name: "rung_live_read", arguments: { names: ['"Fx_Global".Counter'] } })) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0]!.text)).toEqual([{ name: '"Fx_Global".Counter', value: 7 }]);
  });

  it("explains how to configure it when unconfigured", async () => {
    const c = await connect({}, false);
    const r = (await c.callTool({ name: "rung_live_read", arguments: { names: ["x"] } })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/RUNG_WEBAPI_PASSWORD/);
  });
});
