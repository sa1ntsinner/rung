// SPDX-License-Identifier: BUSL-1.1
// Tombstones with companion files, a whole-PLC compile in the retry pass, XML tag names, escaped PLC names.
import { it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig } from "@rung/core";
import { BridgeError, type ExportResult, type CompileMessage } from "@rung/bridge-client";
import { syncOnce, confirmDelete, recordCompile } from "../src/sync.js";
import { FakeBridge } from "./fake-bridge.js";

const address = (name: string) => `plc:PLC_1/blocks/${name}`;
class EdgeBridge extends FakeBridge {
  imports: string[] = [];
  async compile(_device: string, _addresses: string[] = []): Promise<CompileMessage[]> { return []; }
  async deleteObject(a: string) { this.objects.delete(a); }
  async importObject(a: string, form: string, source: string, expected = ""): Promise<ExportResult> {
    const before = this.objects.get(a)?.entry.fingerprint;
    if (before && expected && expected !== "absent" && expected !== before) throw new BridgeError("STALE_REVISION", a);
    this.imports.push(a);
    const content = readFileSync(source, "utf8");
    if (this.objects.has(a)) this.edit(a, { ["." + form]: content });
    else this.add(a, { form, content });
    return { ...await this.exportObject(a, "auto", mkdtempSync(join(tmpdir(), "rung-sync-edges-export-"))), compile: [] };
  }
}
async function fixture(bridge = new EdgeBridge()) {
  const root = mkdtempSync(join(tmpdir(), "rung-sync-edges-"));
  const config = defaultConfig(bridge.info.path, "V20", "fake");
  config.sync.backup = "off";
  const state = await StateStore.open(root, { projectPath: config.project.path, tiaVersion: "V20", devices: [] });
  return { root, bridge, config, state, pass: () => syncOnce(root, bridge, state, { config }) };
}

it("an edited SD resource companion makes a restored tombstoned bundle new", async () => {
  const t = await fixture();
  const source = 'FUNCTION_BLOCK "Display"\nNETWORK\nEND_NETWORK\nEND_FUNCTION_BLOCK\n';
  try {
    t.bridge.add(address("Display"), { form: "s7dcl", language: "LAD", blockType: "FB", files: { ".s7dcl": source, ".s7res": '<root><Text>Old title</Text></root>\n' } });
    await t.pass();
    const primary = join(t.root, "plc/PLC_1/blocks/Display.s7dcl");
    const resource = join(t.root, "plc/PLC_1/blocks/Display.s7res");
    unlinkSync(primary);
    unlinkSync(resource);
    await confirmDelete(t.root, t.bridge, t.state, address("Display"));
    // A restored old primary plus a deliberately edited resource is a different bundle.
    writeFileSync(primary, source);
    writeFileSync(resource, '<root><Text>New title</Text></root>\n');
    const report = await t.pass();
    assert.equal(report.created, 1, JSON.stringify(report.diagnostics));
    assert.deepEqual(t.bridge.imports, [address("Display")]);
  } finally { await t.state.close(); }
});

it("a clean whole-PLC compile in the retry answers every first-pass error in that PLC", async () => {
  class StaleBridge extends EdgeBridge {
    async importObject(a: string, form: string, source: string, expected = "") {
      const result = await super.importObject(a, form, source, expected);
      if (a === address("A")) this.objects.get(address("B"))!.entry.fingerprint = "fp:moved";
      return result;
    }
    async compile(_device: string, _addresses: string[] = []) {
      const oldCaller = this.objects.get(address("B"))!.files[".scl"]!.includes("x := TRUE");
      return oldCaller ? [{ address: address("C"), severity: "error" as const, description: "Called block B is inconsistent." }] : [];
    }
  }
  const t = await fixture(new StaleBridge());
  t.config.sync.compile = "all";
  const a = 'FUNCTION "A" : Void\nVAR_INPUT\n x : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION\n';
  const b = 'FUNCTION "B" : Void\nBEGIN\n "A"(x := TRUE);\nEND_FUNCTION\n';
  try {
    t.bridge.add(address("A"), { content: a }).add(address("B"), { content: b }).add(address("C"), { content: 'FUNCTION "C" : Void\nBEGIN\n "B"();\nEND_FUNCTION\n' });
    await t.pass();
    writeFileSync(join(t.root, "plc/PLC_1/blocks/A.scl"), a.replace("x : Bool", "y : Bool"));
    writeFileSync(join(t.root, "plc/PLC_1/blocks/B.scl"), b.replace("x := TRUE", "y := TRUE"));
    const report = await t.pass();
    assert.equal(report.imported, 2);
    // The second whole-PLC compile is clean, including C which was never imported.
    assert.deepEqual(JSON.parse(readFileSync(join(t.root, ".rung/diagnostics.json"), "utf8")).items, []);
    assert.deepEqual(report.diagnostics.filter((d) => d.code === "COMPILE"), []);
  } finally { await t.state.close(); }
});

it("confirm-delete decodes XML tag names before checking their users", async () => {
  const t = await fixture();
  const table = "plc:PLC_1/tags/IO";
  try {
    t.bridge.add(table, { form: "tags.xml", kind: "tagtable", files: { ".tags.xml": '<Document><SW.Tags.PlcTagTable><AttributeList><Name>IO</Name></AttributeList><ObjectList><SW.Tags.PlcTag ID="1"><AttributeList><DataTypeName>Bool</DataTypeName><LogicalAddress>%I0.0</LogicalAddress><Name>Start &amp; Go</Name></AttributeList></SW.Tags.PlcTag></ObjectList></SW.Tags.PlcTagTable></Document>\n' } });
    t.bridge.add(address("Main"), { content: 'ORGANIZATION_BLOCK "Main"\nBEGIN\n IF "Start & Go" THEN\n  ;\n END_IF;\nEND_ORGANIZATION_BLOCK\n' });
    await t.pass();
    unlinkSync(join(t.root, "plc/PLC_1/tags/IO.tags.xml"));
    await assert.rejects(() => confirmDelete(t.root, t.bridge, t.state, table), { code: "IN_USE" });
    assert.ok(t.bridge.objects.has(table));
  } finally { await t.state.close(); }
});

it("a whole-PLC rung compile clears errors under an escaped PLC name", async () => {
  const root = mkdtempSync(join(tmpdir(), "rung-compile-name-"));
  const device = "CON"; // A valid PLC name, encoded for the reserved Windows folder name.
  const a = "plc:%43ON/blocks/A";
  await recordCompile(root, device, "all", [{ address: a, severity: "error", description: "old error" }], () => "fp:old");
  await recordCompile(root, device, "all", [], () => "fp:new");
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".rung/diagnostics.json"), "utf8")).items, []);
});

it("sync's clean whole-PLC compile clears unimported errors under an escaped PLC name", async () => {
  class ConBridge extends EdgeBridge {
    async listObjects(_device: string) { return [...this.objects.values()].map((o) => ({ ...o.entry })); }
  }
  const bridge = new ConBridge();
  bridge.info.devices = ["CON"];
  const t = await fixture(bridge);
  t.config.sync.compile = "all";
  const a = "plc:%43ON/blocks/A", b = "plc:%43ON/blocks/B";
  const source = 'FUNCTION "A" : Void\nBEGIN\n  #x := 1;\nEND_FUNCTION\n';
  try {
    bridge.add(a, { content: source }).add(b, { content: 'FUNCTION "B" : Void\nBEGIN\nEND_FUNCTION\n' });
    await t.pass();
    const before = t.state.get(b)!;
    writeFileSync(join(t.root, ".rung/diagnostics.json"), JSON.stringify({ seq: 1, items: [{ address: b, path: before.path, severity: "error", code: "COMPILE", message: "old error", fileHash: before.fileHash }] }));
    writeFileSync(join(t.root, "plc/%43ON/blocks/A.scl"), source.replace("#x := 1", "#x := 2"));
    const report = await t.pass();
    assert.equal(report.imported, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(t.root, ".rung/diagnostics.json"), "utf8")).items, []);
  } finally { await t.state.close(); }
});
