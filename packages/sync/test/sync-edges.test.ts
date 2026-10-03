// SPDX-License-Identifier: BUSL-1.1
// Letter case in users, PLC boundaries, diagnostics of what a pass compiled, one bridge restart at a time.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig } from "@rung/core";
import type { ExportResult } from "@rung/bridge-client";
import { syncOnce, confirmDelete, Watcher } from "../src/index.js";
import { FakeBridge } from "./fake-bridge.js";

class EdgeBridge extends FakeBridge {
  imports: string[] = [];
  deletes: string[] = [];
  compileCalls: string[][] = [];
  closes = 0;
  async close() { this.closes++; }
  async compile(_device: string, addresses: string[] = []) { this.compileCalls.push(addresses); return []; }
  async importObject(address: string, form: string, path: string): Promise<ExportResult> {
    this.imports.push(address);
    const text = readFileSync(path, "utf8");
    if (this.objects.has(address)) this.edit(address, { ["." + form]: text });
    else this.add(address, { form, content: text });
    const dir = mkdtempSync(join(tmpdir(), "rung-edges-export-"));
    return { ...await this.exportObject(address, "auto", dir), compile: [] };
  }
  async deleteObject(address: string) { this.deletes.push(address); this.objects.delete(address); }
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rung-edges-"));
  const bridge = new EdgeBridge();
  const config = defaultConfig(bridge.info.path, "V20", "fake");
  config.sync.backup = "off";
  const state = await StateStore.open(root, { projectPath: config.project.path, tiaVersion: "V20", devices: [] });
  return { root, bridge, config, state, pass: () => syncOnce(root, bridge, state, { config }) };
}
const addr = (name: string, plc = "PLC_1") => `plc:${plc}/blocks/${name}`;
const empty = 'FUNCTION "A" : Void\nBEGIN\nEND_FUNCTION\n';

describe("sync and watch: the edges", () => {
  it("requires force when a caller uses different letter casing", async () => {
    const t = await fixture();
    try {
      t.bridge.add(addr("A"), { content: empty });
      t.bridge.add(addr("Main"), { content: 'ORGANIZATION_BLOCK "Main"\nBEGIN\n "a"();\nEND_ORGANIZATION_BLOCK\n' });
      await t.pass();
      unlinkSync(join(t.root, "plc/PLC_1/blocks/A.scl"));
      await t.pass();
      await expect(confirmDelete(t.root, t.bridge, t.state, addr("A"))).rejects.toMatchObject({ code: "IN_USE" });
      expect(t.bridge.deletes).toEqual([]);
    } finally { await t.state.close(); }
  });

  it("does not mistake a new block on another PLC for a hand rename", async () => {
    const t = await fixture();
    try {
      t.bridge.info.devices = ["PLC_1", "PLC_2"];
      t.bridge.add(addr("A"), { content: empty });
      await t.pass();
      unlinkSync(join(t.root, "plc/PLC_1/blocks/A.scl"));
      mkdirSync(join(t.root, "plc/PLC_2/blocks"), { recursive: true });
      writeFileSync(join(t.root, "plc/PLC_2/blocks/B.scl"), empty.replace('"A"', '"B"'));
      const r = await t.pass();
      expect(r.created).toBe(1);
      expect(t.bridge.imports).toContain(addr("B", "PLC_2"));
    } finally { await t.state.close(); }
  });

  it("clears a user's previous compile error after recompiling it successfully for a DB import", async () => {
    const t = await fixture();
    try {
      const db = 'DATA_BLOCK "Plant"\nVAR\n N : Int;\nEND_VAR\nBEGIN\n N := 0;\nEND_DATA_BLOCK\n';
      t.bridge.add(addr("Plant"), { form: "db", blockType: "DB", content: db });
      t.bridge.add(addr("User"), { content: 'FUNCTION "User" : Void\nVAR_TEMP\n x : Int;\nEND_VAR\nBEGIN\n #x := "Plant".N;\nEND_FUNCTION\n' });
      await t.pass();
      const user = t.state.get(addr("User"))!;
      writeFileSync(join(t.root, ".rung/diagnostics.json"), JSON.stringify({ seq: 1, items: [{ address: user.address, path: user.path, code: "COMPILE", severity: "error", message: "old error", revision: user.tiaFingerprint }] }));
      writeFileSync(join(t.root, "plc/PLC_1/blocks/Plant.db"), db.replace("N := 0", "N := 1"));
      await t.pass();
      expect(t.bridge.compileCalls).toContainEqual([addr("User")]);
      expect(JSON.parse(readFileSync(join(t.root, ".rung/diagnostics.json"), "utf8")).items).toEqual([]);
    } finally { await t.state.close(); }
  });

  it("restarts the bridge only once when concurrent previews turn writes on", async () => {
    const t = await fixture();
    const off = { ...t.config, writesOff: true as const, sync: { ...t.config.sync, import: "manual" as const } };
    let live = off as typeof t.config;
    const bridges: EdgeBridge[] = [];
    const watcher = new Watcher(t.root, t.state, { config: off, reloadConfig: async () => live, bridgeFactory: async () => { const b = new EdgeBridge(); bridges.push(b); return b; } });
    try {
      await watcher.syncNow();
      live = t.config;
      await Promise.all([watcher.preview(), watcher.preview()]);
      expect(bridges).toHaveLength(2);
    } finally { await watcher.stop(); await t.state.close(); }
  });
});
