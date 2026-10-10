// SPDX-License-Identifier: BUSL-1.1
import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "@rung/core";
import * as common from "../src/common.js";
import { main } from "../src/main.js";
import { modelSummary } from "../src/modelSummary.js";
afterEach(() => vi.restoreAllMocks());
it("bounds large summaries and reports deep or repeated nodes", () => {
  const node = { type: "Project", name: "Root", attributes: {}, children: {} };
  expect(modelSummary({ ...node, children: { Items: Array.from({ length: 205 }, (_, i) => ({ ...node, name: `Item${i}` })) } }, "Hardware")).toContain("limited to 200 objects");
  expect(modelSummary({ ...node, children: { Items: [node, node] } }, "Libraries")).toContain("incomplete");
});
it("omits anonymous metadata containers while retaining their named children", () => {
  const tree = { type: "ServiceImpl", attributes: {}, children: { Nodes: [{ type: "Node", name: "X1", attributes: { Address: "192.168.0.1" }, children: {} }] } };
  const result = modelSummary(tree, "Hardware");
  expect(result).not.toContain("(unnamed)");
  expect(result).toContain("X1 — Address: 192.168.0.1");
});
it.each(["hardware", "library"])("summarizes %s while preserving full JSON", async command => {
  const root = await mkdtemp(join(tmpdir(), "rung-summary-"));
  await saveConfig(root, defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]));
  const tree = { type: "ProjectImpl", name: "Station", attributes: {}, children: { Devices: [{ type: "DeviceItemImpl", name: "PLC_1", attributes: { TypeName: "CPU 1214C", Address: "192.168.250.1", FirmwareVersion: "V4.7", Guid: "type-guid", SNMPReadWriteCommunityName: "private" }, attributeInfo: { Name: { access: "ReadWrite", type: "System.String" } }, children: {}, truncated: true }] } };
  const raw = command === "hardware" ? { version: 1, revision: "r", tree } : tree;
  const close = vi.fn(async () => {}), request = vi.fn(async () => raw);
  vi.spyOn(common, "bridgeFor").mockResolvedValue({ request, close } as never);
  const out: string[] = [], io = { cwd: root, env: {}, stdout: (s: string) => out.push(s), stderr: vi.fn() };
  try {
    expect(await main([command], io)).toBe(0);
    const summary = out.join("");
    expect(summary).toContain("CPU 1214C"); expect(summary).toContain("192.168.250.1");
    expect(summary).toContain("V4.7"); expect(summary).toContain("type-guid");
    expect(summary).toContain("incomplete"); expect(summary).toContain("--json");
    expect(summary).not.toContain("DeviceItemImpl"); expect(summary).not.toContain("SNMPReadWriteCommunityName");
    out.length = 0;
    expect(await main([command, "--json"], io)).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual(raw);
    expect(close).toHaveBeenCalledTimes(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
