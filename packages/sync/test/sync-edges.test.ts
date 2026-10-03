// SPDX-License-Identifier: BUSL-1.1
// Letter case in users, tag tables used through their tags, PLC boundaries, diagnostics of what a pass or rung compile
// compiled, one bridge restart at a time and none when the bridge may import already.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig } from "@rung/core";
import type { ExportResult } from "@rung/bridge-client";
import { syncOnce, confirmDelete, recordCompile, Watcher } from "../src/index.js";
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

  it("a tag table is used through its tags: confirm-delete names the blocks and needs --force", async () => {
    const t = await fixture();
    try {
      t.bridge.add("plc:PLC_1/tags/IO", { form: "tags.st", content: 'VAR_GLOBAL\n    Start_PB AT %I0.0 : Bool;  // start\n    "Stop PB" AT %I0.1 : Bool;\nEND_VAR\n' });
      t.bridge.add(addr("Main"), { content: 'ORGANIZATION_BLOCK "Main"\nBEGIN\n "Motor_Run" := "stop pb";\nEND_ORGANIZATION_BLOCK\n' });
      await t.pass();
      unlinkSync(join(t.root, "plc/PLC_1/tags/IO.tags.st"));
      await t.pass();
      await expect(confirmDelete(t.root, t.bridge, t.state, "plc:PLC_1/tags/IO")).rejects.toMatchObject({ code: "IN_USE", message: expect.stringContaining("Main.scl") });
    } finally { await t.state.close(); }
  });

  it("rung compile's messages are kept where status and the editors look; a PLC compile answers for the old ones", async () => {
    const t = await fixture();
    try {
      t.bridge.add(addr("User"), { content: empty.replace('"A"', '"User"') });
      await t.pass();
      const file = join(t.root, ".rung/diagnostics.json");
      writeFileSync(file, JSON.stringify({ seq: 1, items: [{ address: addr("Old"), path: "plc/PLC_1/blocks/Old.scl", code: "COMPILE", severity: "error", message: "fixed since" }, { address: addr("User"), path: "", code: "CONFLICT", severity: "error", message: "a conflict stays" }] }));
      await recordCompile(t.root, "PLC_1", "all", [{ address: addr("User"), file: "plc/PLC_1/blocks/User.scl", severity: "error", description: 'Tag "Gone" not defined.', line: 3 }], () => undefined);
      const items = JSON.parse(readFileSync(file, "utf8")).items as { message: string }[];
      expect(items.map((d) => d.message).sort()).toEqual(['Tag "Gone" not defined.', "a conflict stays"]);
    } finally { await t.state.close(); }
  });

  it("writes off and on again: the bridge that may import already is kept", async () => {
    const t = await fixture();
    const off = { ...t.config, writesOff: true as const, sync: { ...t.config.sync, import: "manual" as const } };
    let live = off as typeof t.config;
    const bridges: EdgeBridge[] = [];
    const watcher = new Watcher(t.root, t.state, { config: off, reloadConfig: async () => live, bridgeFactory: async () => { const b = new EdgeBridge(); bridges.push(b); return b; } });
    try {
      await watcher.syncNow();
      live = t.config;
      await watcher.syncNow(); // on: the bridge started without import rights starts again
      live = off;
      await watcher.syncNow();
      live = t.config;
      await watcher.syncNow(); // on again: that bridge may import, nothing restarts
      expect(bridges).toHaveLength(2);
    } finally { await watcher.stop(); await t.state.close(); }
  });
});
