// SPDX-License-Identifier: BUSL-1.1
// Letter case in users, tag tables used through their tags, PLC boundaries, diagnostics of what a pass or rung compile
// compiled, one bridge restart at a time and none when the bridge may import already.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig } from "@rung/core";
import { BridgeError, type ExportResult } from "@rung/bridge-client";
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

  it("a hand rename of an FC with a return value, written with its header unquoted, is still recognised; the advice is in a safe order", async () => {
    const t = await fixture();
    try {
      const fc = 'FUNCTION "Scale" : Real\nVAR_INPUT\n Raw : Int;\nEND_VAR\nBEGIN\n #Scale := INT_TO_REAL(#Raw) / 27.648;\nEND_FUNCTION\n';
      t.bridge.add(addr("Scale"), { content: fc });
      await t.pass();
      unlinkSync(join(t.root, "plc/PLC_1/blocks/Scale.scl"));
      writeFileSync(join(t.root, "plc/PLC_1/blocks/Scale2.scl"), fc.replace('FUNCTION "Scale"', "FUNCTION Scale2").replace("#Scale :=", "#Scale2 :="));
      const r = await t.pass();
      expect(r.created).toBe(0);
      const d = r.diagnostics.find((x) => x.code === "LOOKS_LIKE_RENAME")!;
      expect(d.message.indexOf("remove plc/PLC_1/blocks/Scale2.scl")).toBeLessThan(d.message.indexOf("rung restore plc/PLC_1/blocks/Scale.scl"));
    } finally { await t.state.close(); }
  });

  it("a path with a space is quoted in the command a message suggests", async () => {
    const t = await fixture();
    try {
      t.bridge.add(addr("Valve 1"), { content: empty.replace('"A"', '"Valve 1"') });
      await t.pass();
      unlinkSync(join(t.root, "plc/PLC_1/blocks/Valve 1.scl"));
      const r = await t.pass();
      expect(r.diagnostics.find((x) => x.code === "DELETE_PENDING")!.message).toContain('rung confirm-delete "plc/PLC_1/blocks/Valve 1.scl"');
    } finally { await t.state.close(); }
  });

  it("with writes off, TIA Portal's change comes into an edited file; the same line is a conflict now", async () => {
    const t = await fixture();
    const off = { ...t.config, writesOff: true as const, sync: { ...t.config.sync, import: "manual" as const } };
    try {
      const src = 'FUNCTION "A" : Void\nBEGIN\n  #x := 1;\n  #y := 2;\n  #z := 3;\n  #w := 4;\nEND_FUNCTION\n';
      t.bridge.add(addr("A"), { content: src });
      await syncOnce(t.root, t.bridge, t.state, { config: off });
      const file = join(t.root, "plc/PLC_1/blocks/A.scl");
      writeFileSync(file, src.replace("#x := 1;", "#x := 10;"));
      t.bridge.edit(addr("A"), { ".scl": src.replace("#w := 4;", "#w := 40;") });
      const r = await syncOnce(t.root, t.bridge, t.state, { config: off });
      expect(readFileSync(file, "utf8")).toContain("#x := 10;");
      expect(readFileSync(file, "utf8")).toContain("#w := 40;");
      expect(t.bridge.imports).toEqual([]);
      expect(r.warnings.map((w) => w.code)).toContain("WRITES_OFF");
      t.bridge.edit(addr("A"), { ".scl": src.replace("#x := 1;", "#x := 11;").replace("#w := 4;", "#w := 40;") });
      const c = await syncOnce(t.root, t.bridge, t.state, { config: off });
      expect(c.conflicts).toBe(1);
      expect(t.bridge.imports).toEqual([]);
    } finally { await t.state.close(); }
  });

  it("a compile error stands while its file does, though TIA Portal's revision of an inconsistent block moves", async () => {
    const t = await fixture();
    try {
      t.bridge.add(addr("A"), { content: empty });
      await t.pass();
      await recordCompile(t.root, "PLC_1", [addr("A")], [{ address: addr("A"), file: "plc/PLC_1/blocks/A.scl", severity: "error", description: "Unknown instruction." }], (a) => t.state.get(a)?.tiaFingerprint, (a) => t.state.get(a)?.fileHash);
      // the next listing has another revision for the same text (TIA Portal does that for blocks that do not compile)
      t.bridge.objects.get(addr("A"))!.entry.fingerprint = "fp:moved";
      await t.pass();
      const items = JSON.parse(readFileSync(join(t.root, ".rung/diagnostics.json"), "utf8")).items as { message: string }[];
      expect(items.map((d) => d.message)).toEqual(["Unknown instruction."]);
    } finally { await t.state.close(); }
  });

  it("the old file of a block deleted (here or in TIA Portal) that git brings back unchanged is held, an edited one is created", async () => {
    const t = await fixture();
    try {
      const a = 'FUNCTION "A" : Void\nBEGIN\n  #x := 1;\nEND_FUNCTION\n';
      const b = 'FUNCTION "B" : Void\nBEGIN\n  #y := 1;\nEND_FUNCTION\n';
      t.bridge.add(addr("A"), { content: a }).add(addr("B"), { content: b });
      await t.pass();
      const fileA = join(t.root, "plc/PLC_1/blocks/A.scl");
      const fileB = join(t.root, "plc/PLC_1/blocks/B.scl");
      // A deleted by rung, B deleted in TIA Portal by someone else
      unlinkSync(fileA);
      await confirmDelete(t.root, t.bridge, t.state, addr("A"));
      t.bridge.objects.delete(addr("B"));
      await t.pass();
      // a git checkout brings both old files back
      writeFileSync(fileA, a);
      writeFileSync(fileB, b);
      const r = await t.pass();
      expect(r.created).toBe(0);
      expect(r.diagnostics.filter((d) => d.code === "CAME_BACK").map((d) => d.message.split(";")[0])).toEqual(["A was deleted in TIA Portal", "B is gone from TIA Portal (renamed or deleted there)"]);
      // changed, it is meant as a new block
      writeFileSync(fileA, a.replace("#x := 1;", "#x := 2;"));
      expect((await t.pass()).created).toBe(1);
    } finally { await t.state.close(); }
  });

  it("a caller refused as stale in the first pass and imported in the second: its old text's errors are not reported", async () => {
    class Renaming extends EdgeBridge {
      override async importObject(address: string, form: string, path: string, expected = ""): Promise<ExportResult> {
        // like TIA Portal: an import against a revision the object no longer has is refused
        const now = this.objects.get(address)?.entry.fingerprint;
        if (now && expected && expected !== "absent" && now !== expected) throw new BridgeError("STALE_REVISION", `${address} changed in TIA Portal`);
        const r = await super.importObject(address, form, path);
        // TIA Portal moves the caller's revision when the block it calls changes
        if (address === addr("A")) this.objects.get(addr("B"))!.entry.fingerprint = "fp:moved";
        return r;
      }
      override async compile(_device: string, addresses: string[] = []) {
        this.compileCalls.push(addresses);
        const oldCall = (this.objects.get(addr("B"))!.files[".scl"] ?? "").includes("x := TRUE");
        return addresses.includes(addr("B")) && oldCall ? [{ address: addr("B"), severity: "error" as const, description: "The formal parameter 'x' is invalid." }] : [];
      }
    }
    const t = await fixture();
    const bridge = Object.assign(new Renaming(), { objects: t.bridge.objects });
    try {
      t.bridge.add(addr("A"), { content: 'FUNCTION "A" : Void\nVAR_INPUT\n x : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION\n' });
      t.bridge.add(addr("B"), { content: 'FUNCTION "B" : Void\nBEGIN\n "A"(x := TRUE);\nEND_FUNCTION\n' });
      await syncOnce(t.root, bridge, t.state, { config: t.config });
      writeFileSync(join(t.root, "plc/PLC_1/blocks/A.scl"), 'FUNCTION "A" : Void\nVAR_INPUT\n y : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION\n');
      writeFileSync(join(t.root, "plc/PLC_1/blocks/B.scl"), 'FUNCTION "B" : Void\nBEGIN\n "A"(y := TRUE);\nEND_FUNCTION\n');
      const r = await syncOnce(t.root, bridge, t.state, { config: t.config });
      expect(r.imported).toBe(2);
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
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
