// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig, type RungConfig } from "@rung/core";
import { pull } from "../src/index.js";
import { isFresh } from "../src/pull.js";
import { BridgeError } from "@rung/bridge-client";
import { FakeBridge } from "./fake-bridge.js";

const MOTOR = "plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor";
const VALVE = "plc:PLC_1/blocks/Motor%2FValve 1";
const SECRET = "plc:PLC_1/blocks/Secret";

function setup(fill: (b: FakeBridge) => void = defaultObjects) {
  const root = mkdtempSync(join(tmpdir(), "rung-pull-"));
  const bridge = new FakeBridge();
  fill(bridge);
  const config: RungConfig = defaultConfig(bridge.info.path, "V20", "fake");
  const binding = { projectPath: bridge.info.path, tiaVersion: "V20", devices: bridge.info.devices };
  const run = async (opts: { force?: boolean; now?: number } = {}) => {
    const state = await StateStore.open(root, binding);
    try {
      return await pull(root, bridge, state, { config, force: opts.force, now: () => opts.now ?? 1_000 });
    } finally {
      await state.close();
    }
  };
  const read = (p: string) => readFileSync(join(root, ...p.split("/")), "utf8");
  const file = (p: string) => join(root, ...p.split("/"));
  return { root, bridge, run, read, file, binding };
}

function defaultObjects(b: FakeBridge) {
  b.add(MOTOR, { content: 'FUNCTION_BLOCK "Fx_Motor"\r\n// Überwachung\r\nEND_FUNCTION_BLOCK' });
  b.add(VALVE);
  b.add(SECRET, { form: "protected.yaml", knowHowProtected: true, content: "readOnly: true\n" });
}

describe("pull", () => {
  it("reports an object TIA Portal has not compiled on every pull, not only the first", async () => {
    const t = setup((b) => b.add(MOTOR, { isConsistent: false }));
    const first = await t.run();
    const second = await t.run({ now: 2_000 });
    for (const r of [first, second]) expect(r.warnings).toContainEqual({ address: MOTOR, path: "plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl", code: "INCONSISTENT", message: "not compiled in TIA Portal since its last change (rung compile)" });
  });

  it("exports everything on first pull with normalized text", async () => {
    const t = setup();
    const r = await t.run();
    expect(r.exported).toBe(3);
    expect(t.read("plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl")).toBe('FUNCTION_BLOCK "Fx_Motor"\n// Überwachung\nEND_FUNCTION_BLOCK\n');
    expect(existsSync(t.file("plc/PLC_1/blocks/Motor%2FValve 1.scl"))).toBe(true);
    expect(r.readOnly).toBe(1);
    const state = await StateStore.open(t.root, t.binding);
    expect(state.get(SECRET)!.readOnly).toBe(true);
    expect(state.get(MOTOR)!.readOnly).toBe(false);
    await state.close();
  });

  it("is incremental: unchanged strong revisions are not exported again", async () => {
    const t = setup();
    await t.run();
    const before = statSync(t.file("plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl")).mtimeMs;
    t.bridge.exportCalls = [];
    const r = await t.run();
    expect(r).toMatchObject({ exported: 0, unchanged: 3 });
    expect(t.bridge.exportCalls).toEqual([]);
    expect(statSync(t.file("plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl")).mtimeMs).toBe(before);
  });

  it("re-exports only the changed object", async () => {
    const t = setup();
    await t.run();
    t.bridge.edit(VALVE, { ".scl": "// valve v2\n" });
    t.bridge.exportCalls = [];
    const r = await t.run();
    expect(t.bridge.exportCalls).toEqual([VALVE]);
    expect(r.exported).toBe(1);
    expect(t.read("plc/PLC_1/blocks/Motor%2FValve 1.scl")).toBe("// valve v2\n");
  });

  it("restores a locally deleted file", async () => {
    const t = setup();
    await t.run();
    unlinkSync(t.file("plc/PLC_1/blocks/Motor%2FValve 1.scl"));
    const r = await t.run();
    expect(r.exported).toBe(1);
    expect(existsSync(t.file("plc/PLC_1/blocks/Motor%2FValve 1.scl"))).toBe(true);
  });

  it("preserves local edits and reports LOCAL_CHANGES", async () => {
    const t = setup();
    await t.run();
    writeFileSync(t.file("plc/PLC_1/blocks/Motor%2FValve 1.scl"), "// my edit\n");
    t.bridge.edit(VALVE, { ".scl": "// tia edit\n" });
    const r = await t.run();
    expect(r.warnings).toContainEqual(expect.objectContaining({ address: VALVE, code: "LOCAL_CHANGES" }));
    expect(t.read("plc/PLC_1/blocks/Motor%2FValve 1.scl")).toBe("// my edit\n");
  });

  it("keeps a local edit even when TIA did not change", async () => {
    const t = setup();
    await t.run();
    writeFileSync(t.file("plc/PLC_1/blocks/Motor%2FValve 1.scl"), "// my edit\n");
    const r = await t.run();
    expect(r.warnings).toContainEqual(expect.objectContaining({ address: VALVE, code: "LOCAL_CHANGES" }));
    expect(t.read("plc/PLC_1/blocks/Motor%2FValve 1.scl")).toBe("// my edit\n");
  });

  it("--force replaces local edits but retains them for recovery", async () => {
    const t = setup();
    await t.run();
    writeFileSync(t.file("plc/PLC_1/blocks/Motor%2FValve 1.scl"), "// my edit\n");
    const forced = await t.run({ force: true });
    // the report names what it replaced and where the person's version is
    expect(forced.overwritten).toEqual([{ path: "plc/PLC_1/blocks/Motor%2FValve 1.scl", copy: expect.stringMatching(/^\.rung\/recovery\//) }]);
    expect(t.read("plc/PLC_1/blocks/Motor%2FValve 1.scl")).toBe(`// ${VALVE}\n`);
    const rec = join(t.root, ".rung", "recovery");
    const found = readdirSync(rec, { recursive: true }).map(String).filter((f) => f.endsWith(".scl"));
    expect(found.some((f) => readFileSync(join(rec, f), "utf8") === "// my edit\n")).toBe(true);
  });

  it("does not overwrite an unrelated pre-existing file on first pull", async () => {
    const t = setup();
    mkdirSync(t.file("plc/PLC_1/blocks"), { recursive: true });
    writeFileSync(t.file("plc/PLC_1/blocks/Motor%2FValve 1.scl"), "// hand written\n");
    const r = await t.run();
    expect(r.warnings).toContainEqual(expect.objectContaining({ address: VALVE, code: "LOCAL_CHANGES" }));
    expect(t.read("plc/PLC_1/blocks/Motor%2FValve 1.scl")).toBe("// hand written\n");
  });

  it("adopts an identical pre-existing file", async () => {
    const t = setup();
    mkdirSync(t.file("plc/PLC_1/blocks"), { recursive: true });
    writeFileSync(t.file("plc/PLC_1/blocks/Motor%2FValve 1.scl"), `// ${VALVE}\n`);
    const r = await t.run();
    expect(r.warnings).toEqual([]);
    expect(r.exported).toBe(3);
  });

  it("moves files of objects deleted in TIA to trash after a complete inventory", async () => {
    const t = setup();
    await t.run();
    t.bridge.objects.delete(VALVE);
    const r = await t.run();
    expect(r.removed).toBe(1);
    expect(existsSync(t.file("plc/PLC_1/blocks/Motor%2FValve 1.scl"))).toBe(false);
    expect(readdirSync(join(t.root, ".rung", "trash"), { recursive: true }).map(String).some((f) => f.endsWith("Valve 1.scl"))).toBe(true);
  });

  it("never deletes when the inventory failed", async () => {
    const t = setup();
    await t.run();
    t.bridge.failList = true;
    await expect(t.run()).rejects.toMatchObject({ code: "PORTAL_DISPOSED" });
    expect(existsSync(t.file("plc/PLC_1/blocks/Motor%2FValve 1.scl"))).toBe(true);
  });

  it("keeps a locally edited file of a TIA-deleted object as a conflict", async () => {
    const t = setup();
    await t.run();
    writeFileSync(t.file("plc/PLC_1/blocks/Motor%2FValve 1.scl"), "// my edit\n");
    t.bridge.objects.delete(VALVE);
    const r = await t.run();
    expect(r.removed).toBe(0);
    expect(r.warnings).toContainEqual(expect.objectContaining({ address: VALVE, code: "LOCAL_CHANGES" }));
    expect(t.read("plc/PLC_1/blocks/Motor%2FValve 1.scl")).toBe("// my edit\n");
  });

  it("continues after an export failure and leaves the old file untouched", async () => {
    const t = setup();
    await t.run();
    t.bridge.edit(VALVE, { ".scl": "// v2\n" });
    t.bridge.edit(MOTOR, { ".scl": "// motor v2\n" });
    t.bridge.failExport.add(VALVE);
    const r = await t.run();
    expect(r.warnings).toContainEqual(expect.objectContaining({ address: VALVE, code: "EXPORT_FAILED" }));
    expect(t.read("plc/PLC_1/blocks/Motor%2FValve 1.scl")).toBe(`// ${VALVE}\n`);
    expect(t.read("plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl")).toBe("// motor v2\n");
  });

  it("writes nothing for case-colliding objects", async () => {
    const t = setup((b) => {
      b.add("plc:PLC_1/blocks/Motor");
      b.add("plc:PLC_1/blocks/MOTOR");
      b.add("plc:PLC_1/blocks/Other");
    });
    const r = await t.run();
    expect(r.collisions).toHaveLength(1);
    expect(existsSync(t.file("plc/PLC_1/blocks/Motor.scl"))).toBe(false);
    expect(existsSync(t.file("plc/PLC_1/blocks/MOTOR.scl"))).toBe(false);
    expect(existsSync(t.file("plc/PLC_1/blocks/Other.scl"))).toBe(true);
  });

  it("mirrors a software unit's objects into its own folder and skips system blocks with UNSUPPORTED_OBJECT", async () => {
    const t = setup((b) => {
      b.add("plc:PLC_1/units/Fx_Unit/blocks/Drives/Fx_Fc", { unit: "Fx_Unit" });
      b.add("plc:PLC_1/units/Fx_Unit/types/Fx_UnitType", { unit: "Fx_Unit", kind: "type", form: "udt" });
      b.add("plc:PLC_1/blocks/Sys", { isSystem: true });
    });
    t.bridge.info = { ...t.bridge.info, units: ["PLC_1/Fx_Unit"] };
    const r = await t.run();
    expect(r.warnings.map((w) => w.code)).toEqual(["UNSUPPORTED_OBJECT"]);
    expect(r.exported).toBe(2);
    expect(existsSync(t.file("plc/PLC_1/units/Fx_Unit/blocks/Drives/Fx_Fc.scl"))).toBe(true);
    expect(existsSync(t.file("plc/PLC_1/units/Fx_Unit/types/Fx_UnitType.udt"))).toBe(true);
  });

  it("rejects entries whose unit metadata contradicts the address", async () => {
    const t = setup((b) => b.add("plc:PLC_1/units/Fx_Unit/blocks/Fx_Fc", { unit: "Other" }));
    const r = await t.run();
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: "BAD_ADDRESS" }));
  });

  it("keeps system instance DB dependencies in the mirror while forbidding edits", async () => {
    const address = "plc:PLC_1/blocks/System blocks/R_TRIG_HighLevel";
    const t = setup(b => b.add(address, { isSystem: true, blockType: "InstanceDB", language: "DB", form: "db", content: 'DATA_BLOCK "R_TRIG_HighLevel"\n"R_TRIG"\nBEGIN\nEND_DATA_BLOCK\n' }));
    const result = await t.run();
    expect(result.exported).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(t.read("plc/PLC_1/blocks/System blocks/R_TRIG_HighLevel.db")).toContain('"R_TRIG"');
    const state = await StateStore.open(t.root, t.binding);
    try { expect(state.get(address)!.readOnly).toBe(true); } finally { await state.close(); }
  });

  it("rejects entries whose namespace metadata contradicts the address", async () => {
    const t = setup((b) => b.add("plc:PLC_1/blocks/Fx~M", { namespace: "Other" }));
    const r = await t.run();
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: "BAD_ADDRESS" }));
  });

  it("publishes SD primary plus companions and handles resource-only changes and fallbacks", async () => {
    const L = "plc:PLC_1/blocks/20_Valves/Fx_Lad";
    const t = setup((b) => b.add(L, { form: "s7dcl", language: "LAD", files: { ".s7dcl": "dcl v1\n", ".s7res": "res v1\n" } }));
    await t.run();
    expect(t.read("plc/PLC_1/blocks/20_Valves/Fx_Lad.s7dcl")).toBe("dcl v1\n");
    expect(t.read("plc/PLC_1/blocks/20_Valves/Fx_Lad.s7res")).toBe("res v1\n");
    t.bridge.edit(L, { ".s7dcl": "dcl v1\n", ".s7res": "res v2\n" });
    await t.run();
    expect(t.read("plc/PLC_1/blocks/20_Valves/Fx_Lad.s7res")).toBe("res v2\n");
    // SD export failed → bridge fell back to XML: old SD files are replaced by the XML primary
    const o = t.bridge.objects.get(L)!;
    o.form = "xml";
    t.bridge.edit(L, { ".xml": "<xml/>\n" });
    await t.run();
    expect(t.read("plc/PLC_1/blocks/20_Valves/Fx_Lad.xml")).toBe("<xml/>\n");
    expect(existsSync(t.file("plc/PLC_1/blocks/20_Valves/Fx_Lad.s7dcl"))).toBe(false);
    expect(existsSync(t.file("plc/PLC_1/blocks/20_Valves/Fx_Lad.s7res"))).toBe(false);
  });

  it("rejects companion suffixes that could escape the directory", async () => {
    const t = setup((b) => b.add("plc:PLC_1/blocks/Evil", { files: { ".scl": "x\n", "/../../../pwn.txt": "boom" } }));
    const r = await t.run();
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: "EXPORT_FAILED" }));
    expect(existsSync(join(t.root, "..", "pwn.txt"))).toBe(false);
  });

  it("verifies weak revisions by hash after weakVerifyMs", async () => {
    const W = "plc:PLC_1/tags/Default tag table";
    const t = setup((b) => b.add(W, { kind: "tagtable", form: "tags.xml", fingerprint: "dt:1", content: "<tags/>\n" }));
    await t.run({ now: 1_000 });
    t.bridge.exportCalls = [];
    await t.run({ now: 2_000 });
    expect(t.bridge.exportCalls).toEqual([]); // still fresh
    t.bridge.objects.get(W)!.files = { ".tags.xml": "<tags changed/>\n" }; // weak token did not move
    await t.run({ now: 1_000 + 3_600_001 });
    expect(t.bridge.exportCalls).toEqual([W]);
    expect(t.read("plc/PLC_1/tags/Default tag table.tags.xml")).toBe("<tags changed/>\n");
  });

  it("always re-verifies objects without a revision token", async () => {
    const W = "plc:PLC_1/watch/Fx_Watch";
    const t = setup((b) => b.add(W, { kind: "watchtable", form: "xml", fingerprint: "none", content: "<w/>\n" }));
    await t.run({ now: 1_000 });
    t.bridge.objects.get(W)!.files = { ".xml": "<w changed/>\n" };
    t.bridge.exportCalls = [];
    await t.run({ now: 2_000 });
    expect(t.bridge.exportCalls).toEqual([W]);
    expect(t.read("plc/PLC_1/watch/Fx_Watch.xml")).toBe("<w changed/>\n");
  });

  it("does not count a re-verified object with identical bytes as exported", async () => {
    const W = "plc:PLC_1/force/Fx_Force";
    const t = setup((b) => b.add(W, { kind: "forcetable", form: "xml", fingerprint: "none", content: "<f/>\n" }));
    expect((await t.run({ now: 1_000 })).exported).toBe(1);
    const again = await t.run({ now: 2_000 });
    expect(t.bridge.exportCalls).toContain(W);
    expect([again.exported, again.unchanged]).toEqual([0, 1]);
  });

  it("follows a case-only rename without losing the file or leaving a phantom entry", async () => {
    const t = setup((b) => b.add("plc:PLC_1/blocks/Motor", { content: "// m\n" }));
    await t.run();
    t.bridge.objects.delete("plc:PLC_1/blocks/Motor");
    t.bridge.add("plc:PLC_1/blocks/MOTOR", { content: "// m\n" });
    const r = await t.run();
    expect(r.warnings).toEqual([]);
    const names = readdirSync(t.file("plc/PLC_1/blocks"));
    expect(names).toEqual(["MOTOR.scl"]);
    const state = await StateStore.open(t.root, t.binding);
    expect(state.all().map((s) => s.address)).toEqual(["plc:PLC_1/blocks/MOTOR"]);
    await state.close();
  });

  it("aborts on a bridge timeout instead of waiting for every object", async () => {
    const t = setup((b) => {
      for (let i = 0; i < 5; i++) b.add(`plc:PLC_1/blocks/B${i}`);
    });
    const orig = t.bridge.exportObject.bind(t.bridge);
    let calls = 0;
    t.bridge.exportObject = async (...a: Parameters<typeof orig>) => {
      if (++calls === 2) throw new BridgeError("TIMEOUT", "stuck");
      return orig(...a);
    };
    await expect(t.run()).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(calls).toBe(2);
    const state = await StateStore.open(t.root, t.binding);
    expect(state.all()).toHaveLength(1); // the object exported before the timeout was checkpointed
    await state.close();
  });

  it("sweeps temp files left by a crashed atomic write", async () => {
    const t = setup();
    mkdirSync(t.file("plc/PLC_1/blocks"), { recursive: true });
    writeFileSync(t.file("plc/PLC_1/blocks/.x.scl.rung-tmp-0123456789ab"), "junk");
    await t.run();
    expect(existsSync(t.file("plc/PLC_1/blocks/.x.scl.rung-tmp-0123456789ab"))).toBe(false);
  });

  it("detects a project swap", async () => {
    const t = setup();
    t.bridge.info = { ...t.bridge.info, path: "C:\\other\\Other.ap20" };
    await expect(t.run()).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
  });

  it("handles 2,000 objects in deep folders incrementally with monotonic progress", async () => {
    const t = setup((b) => {
      for (let i = 0; i < 2000; i++) b.add(`plc:PLC_1/blocks/G${i % 10}/S${i % 7}/Deep${i % 3}/B${i}`);
    });
    const progress: number[] = [];
    const state = await StateStore.open(t.root, t.binding);
    const r1 = await pull(t.root, t.bridge, state, { config: defaultConfig(t.bridge.info.path, "V20", "fake"), onProgress: (d) => progress.push(d), now: () => 1 });
    await state.close();
    expect(r1.exported).toBe(2000);
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1]!)).toBe(true);
    t.bridge.edit("plc:PLC_1/blocks/G5/S5/Deep2/B1265", { ".scl": "// changed\n" });
    t.bridge.exportCalls = [];
    const r2 = await t.run();
    expect(r2.exported).toBe(1);
    expect(t.bridge.exportCalls).toEqual(["plc:PLC_1/blocks/G5/S5/Deep2/B1265"]);
  }, 600_000);
});

describe("isFresh", () => {
  const st = (tiaFingerprint: string, verifiedAt: number) => ({ address: "a", path: "p", form: "xml", fileHash: "", files: [], tiaFingerprint, baseId: "", readOnly: false, warnings: [], status: "synced" as const, verifiedAt });
  it("never takes a state marked stale for checked, whatever its fingerprint or check time says", () => {
    expect(isFresh("none", st("xh:1", 9_000), 10_000, 3_600_000, 60_000)).toBe(true);
    expect(isFresh("none", st("stale:xh:1", 9_000), 10_000, 3_600_000, 60_000)).toBe(false);
    expect(isFresh("dt:1", st("stale:dt:1", 9_000), 10_000, 3_600_000)).toBe(false);
    expect(isFresh("fp:1", st("fp:1", 0), 10_000, 3_600_000)).toBe(true);
    expect(isFresh("fp:1", st("stale:fp:1", 0), 10_000, 3_600_000)).toBe(false);
  });
});
