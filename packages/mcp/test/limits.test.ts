// SPDX-License-Identifier: BUSL-1.1
import { beforeAll, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StateStore, defaultConfig, saveConfig } from "@rung/core";
import { pull } from "@rung/sync";
import { createMcpServer } from "../src/index.js";
import { FakeBridge } from "../../sync/test/fake-bridge.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rung-mcp-limits-"));
  const bridge = new FakeBridge();
  for (let i = 0; i < 624; i++) bridge.add(`plc:PLC_1/blocks/FB_Mixing${i}`, {
    content: `FUNCTION_BLOCK "FB_Mixing${i}"\nVAR_OUTPUT\n${Array.from({ length: 24 }, (_, n) => `Done${n} : Bool;`).join("\n")}\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n`,
  });
  const config = defaultConfig(bridge.info.path, "V20", "fake");
  await saveConfig(root, config);
  const state = await StateStore.open(root, { projectPath: bridge.info.path, tiaVersion: "V20", devices: [] });
  await pull(root, bridge, state, { config });
  await state.close();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ root, bridgeFactory: async () => Object.assign(bridge, { close: async () => {} }) }).connect(a);
  const client = new Client({ name: "limits", version: "1" });
  await client.connect(b);
  return { client, root };
}

describe("MCP result contracts", () => {
  let client: Client, root: string;
  beforeAll(async () => { ({ client, root } = await fixture()); }, 60_000);
  it("gives every tool its safety hints, title and structured output schema", async () => {
    const tools = (await client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations, tool.name).toEqual(expect.objectContaining({
        readOnlyHint: expect.any(Boolean), destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean), openWorldHint: expect.any(Boolean),
      }));
      expect(tool.outputSchema, tool.name).toBeTruthy();
    }
    for (const name of ["rung_confirm_delete", "rung_resolve"]) {
      expect(tools.find((t) => t.name === name)?._meta?.["anthropic/requiresUserInteraction"]).toBe(true);
    }
    expect(tools.find((t) => t.name === "rung_sync_preview")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "rung_sync")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "rung_sync")?.inputSchema.properties).not.toHaveProperty("preview");
    const result = await client.callTool({ name: "rung_status", arguments: {} });
    expect(result.structuredContent).toBeTruthy();
  });

  it("pages the 624-object fixture with short summaries and an explicit continuation", async () => {
    const result = await client.callTool({ name: "rung_list", arguments: {} });
    const first = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(first).toMatchObject({ total: 624, offset: 0, limit: 50, nextOffset: 50 });
    expect(first.items).toHaveLength(50);
    // Count the entire wire response, including its structured copy; ASCII bytes are a conservative token upper bound.
    expect(JSON.stringify(result).length).toBeLessThan(25_000);
    const second = await client.callTool({ name: "rung_list", arguments: { offset: 50, limit: 50 } });
    const next = JSON.parse((second.content as { text: string }[])[0]!.text);
    expect(next.items[0].path).not.toBe(first.items[0].path);
    expect((await client.callTool({ name: "rung_list", arguments: { limit: 1000 } })).isError).toBe(true);
    expect((await client.callTool({ name: "rung_list", arguments: { offset: -1 } })).isError).toBe(true);
    const paths: string[] = [];
    for (let offset = 0; offset < 624; offset += 100) {
      const response = await client.callTool({ name: "rung_list", arguments: { offset, limit: 100 } });
      paths.push(...JSON.parse((response.content as { text: string }[])[0]!.text).items.map((s: { path: string }) => s.path));
    }
    expect(new Set(paths).size).toBe(624);
    const graph = await client.readResource({ uri: "rung://graph" });
    expect(JSON.stringify(graph).length).toBeLessThan(10_000);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.some((t) => t.uriTemplate === "rung://graph/{object}")).toBe(true);
    const node = await client.readResource({ uri: "rung://graph/FB_Mixing0" });
    expect(JSON.parse((node.contents[0] as { text: string }).text).node.name).toBe("FB_Mixing0");
  });

  it("bounds assignments, simulator observations and large sync previews without dropping their counts", async () => {
    mkdirSync(join(root, "plc", "PLC_1", "tags"), { recursive: true });
    writeFileSync(join(root, "plc", "PLC_1", "tags", "Mixing.tags.st"), `VAR_GLOBAL\n${Array.from({ length: 624 }, (_, n) => `Sensor${n} AT %I${n}.0 : Bool;`).join("\n")}\nEND_VAR\n`);
    // A fresh server sees the newly created sources immediately.
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ root }).connect(a);
    const reader = new Client({ name: "observations", version: "1" }); await reader.connect(b);
    const assignments = await reader.callTool({ name: "rung_assignments", arguments: {} });
    const data = JSON.parse((assignments.content as { text: string }[])[0]!.text);
    expect(data.total).toBe(624); expect(data.items).toHaveLength(50); expect(data.nextOffset).toBe(50);
    expect(JSON.stringify(assignments).length).toBeLessThan(25_000);
    const filtered = await reader.callTool({ name: "rung_assignments", arguments: { area: "Q" } });
    expect(JSON.parse((filtered.content as { text: string }[])[0]!.text).total).toBe(0);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "mixing.test.yaml"), `block: FB_Mixing0\ncases:\n${Array.from({ length: 20 }, (_, n) => `  - name: mixing ${n}\n    steps:\n${"      - cycle: 1\n".repeat(8)}`).join("")}`);
    const tests = await reader.callTool({ name: "rung_test", arguments: { observe: true } });
    const observed = JSON.parse((tests.content as { text: string }[])[0]!.text);
    expect(observed).toMatchObject({ totalCases: 20, passed: 20, failed: 0, nextOffset: 5 });
    expect(observed.items[0].observed).toMatchObject({ total: 8, nextOffset: 5 });
    expect(observed.items[0].observed.items[0]).toMatchObject({ valueCount: 24, nextValueOffset: 10 });
    expect(JSON.stringify(tests).length).toBeLessThan(25_000);
    for (let n = 0; n < 57; n++) writeFileSync(join(root, "plc", "PLC_1", "blocks", `FB_Mixing${n}.scl`), `FUNCTION_BLOCK "FB_Mixing${n}"\nBEGIN\n${"// MixingStation preview detail\n".repeat(1000)}END_FUNCTION_BLOCK\n`);
    const stateBefore = readFileSync(join(root, ".rung", "state.json"), "utf8");
    const preview = await client.callTool({ name: "rung_sync_preview", arguments: {} });
    const planned = JSON.parse((preview.content as { text: string }[])[0]!.text);
    expect(planned.plan).toMatchObject({ total: 58, nextOffset: 5 });
    expect(planned.plan.items[0].diffTruncated).toBe(true);
    expect(planned.plan.items[0]).not.toHaveProperty("before");
    expect(JSON.stringify(preview).length).toBeLessThan(25_000);
    expect(readFileSync(join(root, ".rung", "state.json"), "utf8")).toBe(stateBefore);
    await reader.close();
  });

  it("keeps conflicts and compile errors visible outside the ordinary page", async () => {
    const statePath = join(root, ".rung", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const objects = Object.values(state.objects) as { status: string; readOnly: boolean; path: string }[];
    for (const item of objects) { item.status = "fileDirty"; item.readOnly = true; }
    objects[623]!.status = "conflicted";
    writeFileSync(statePath, JSON.stringify(state));
    const result = await client.callTool({ name: "rung_list", arguments: { limit: 1 } });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text).conflicts).toContain(objects[623]!.path);
    const status = await client.callTool({ name: "rung_status", arguments: {} });
    expect(JSON.stringify(status).length).toBeLessThan(25_000);
    expect(JSON.parse((status.content as { text: string }[])[0]!.text).readOnly).toMatchObject({ total: 624, nextOffset: 50 });
    writeFileSync(join(root, ".rung", "diagnostics.json"), JSON.stringify({ items: [
      ...Array.from({ length: 624 }, (_, n) => ({ severity: "warning", path: `plc/PLC_1/blocks/FB_Mixing${n}.scl`, message: `warning ${n}` })),
      { severity: "error", path: "plc/PLC_1/blocks/FB_Mixing623.scl", message: "compile error beyond page" },
    ] }));
    const resource = await client.readResource({ uri: "rung://diagnostics" });
    const diagnostics = JSON.parse((resource.contents[0] as { text: string }).text);
    expect(diagnostics).toMatchObject({ total: 625, errorCount: 1, nextOffset: 50 });
    expect(diagnostics.items).toContainEqual(expect.objectContaining({ message: "compile error beyond page" }));
    expect(JSON.stringify(resource).length).toBeLessThan(25_000);
    const next = await client.readResource({ uri: "rung://diagnostics/50" });
    expect(JSON.parse((next.contents[0] as { text: string }).text).items).toContainEqual(expect.objectContaining({ message: "warning 50" }));
  });

  it("pages assignment tags and use locations independently from address rows", async () => {
    writeFileSync(join(root, "plc", "PLC_1", "tags", "Aliases.tags.st"), `VAR_GLOBAL\n${Array.from({ length: 14 }, (_, n) => `Alias${n} AT %I0.0 : Bool;`).join("\n")}\nEND_VAR\n`);
    writeFileSync(join(root, "plc", "PLC_1", "blocks", "FB_AddressDetails.scl"), `FUNCTION_BLOCK "FB_AddressDetails"\nVAR_OUTPUT\n Done : Bool;\nEND_VAR\nBEGIN\n${Array.from({ length: 14 }, (_, n) => `#Done := "Alias${n}";`).join("\n")}\nEND_FUNCTION_BLOCK\n`);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ root }).connect(a);
    const reader = new Client({ name: "address-details", version: "1" }); await reader.connect(b);
    const read = async (detailOffset: number) => {
      const response = await reader.callTool({ name: "rung_assignments", arguments: { prefix: "%I0.0", summary: false, limit: 1, detailOffset } });
      return JSON.parse((response.content as { text: string }[])[0]!.text);
    };
    const first = await read(0), second = await read(10);
    expect(first.items[0]).toMatchObject({ address: "%I0.0", tags: { total: 15, nextOffset: 10 }, uses: { total: 14, nextOffset: 10 } });
    expect(second.items[0]).toMatchObject({ address: "%I0.0", tags: { total: 15, offset: 10 }, uses: { total: 14, offset: 10 } });
    expect(second.items[0].tags.items).toHaveLength(5);
    expect(second.items[0].uses.items).toHaveLength(4);
    expect(second.items[0].tags.items[0]).not.toEqual(first.items[0].tags.items[0]);
    await reader.close();
  });
});
