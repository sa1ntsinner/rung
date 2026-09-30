// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig, type RungConfig } from "@rung/core";
import { BridgeError, type CompileMessage, type ExportResult } from "@rung/bridge-client";
import { pull, syncOnce, confirmDelete, resolveConflict } from "../src/index.js";
import { FakeBridge } from "./fake-bridge.js";

/** TIA stand-in with import/compile/delete. `canon` models TIA re-formatting imported source. */
class TiaFake extends FakeBridge {
  canon: (s: string) => string = (s) => s;
  imports: { address: string; expected: string; text: string }[] = [];
  deletes: string[] = [];
  compileCalls: string[][] = [];
  failImport = new Map<string, string>();
  compileErrors = new Map<string, string>();
  hangImport = false;
  /** the rung process dies (Ctrl+C) before or after TIA Portal carried out the import */
  killed: "before" | "after" | undefined;

  async importObject(address: string, form: string, path: string, expected: string): Promise<ExportResult> {
    const text = readFileSync(path, "utf8");
    this.imports.push({ address, expected, text });
    if (this.hangImport) throw new BridgeError("OUTCOME_UNKNOWN", "timed out");
    if (this.killed === "before") throw new Error("killed");
    const code = this.failImport.get(address);
    if (code) throw new BridgeError(code, "import refused: " + code);
    const o = this.objects.get(address);
    if (expected === "absent") {
      if (o) throw new BridgeError("STALE_REVISION", "exists");
      this.add(address, { form, content: this.canon(text) });
    } else {
      if (!o) throw new BridgeError("NOT_FOUND", address);
      if (o.entry.fingerprint !== expected) throw new BridgeError("STALE_REVISION", "changed in TIA");
      const files: Record<string, string> = { ["." + form]: this.canon(text) };
      for (const [suffix, content] of Object.entries(o.files)) if (suffix !== "." + form) files[suffix] = content;
      this.edit(address, files);
    }
    if (this.killed === "after") throw new Error("killed"); // TIA Portal has it; rung never heard back
    const dir = mkdtempSync(join(tmpdir(), "rung-bridge-out-"));
    return this.exportObject(address, "auto", dir);
  }
  async compile(_device: string, addresses: string[] = []): Promise<CompileMessage[]> {
    this.compileCalls.push(addresses);
    return addresses.filter((a) => this.compileErrors.has(a)).map((a) => ({ address: a, severity: "error", description: this.compileErrors.get(a)! }));
  }
  async deleteObject(address: string, expected: string): Promise<void> {
    const o = this.objects.get(address);
    if (!o) throw new BridgeError("NOT_FOUND", address);
    if (o.entry.fingerprint !== expected) throw new BridgeError("STALE_REVISION", "changed");
    this.deletes.push(address);
    this.objects.delete(address);
  }
}

const A = "plc:PLC_1/blocks/Fx_A";
const B = "plc:PLC_1/blocks/Fx_B";
const T = "plc:PLC_1/types/Fx_T";
const srcA = 'FUNCTION "Fx_A" : Void\nBEGIN\n  #x := 1;\n  #y := 2;\n  #z := 3;\nEND_FUNCTION\n';

function setup(fill?: (b: TiaFake) => void, cfg: (c: RungConfig) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "rung-sync-"));
  const bridge = new TiaFake();
  if (fill) fill(bridge);
  else bridge.add(A, { content: srcA });
  const config = defaultConfig(bridge.info.path, "V20", "fake");
  cfg(config);
  const binding = { projectPath: bridge.info.path, tiaVersion: "V20", devices: [] as string[] };
  const withState = async <T,>(fn: (s: StateStore) => Promise<T>) => {
    const s = await StateStore.open(root, binding);
    try {
      return await fn(s);
    } finally {
      await s.close();
    }
  };
  const sync = (now = 1000) => withState((s) => syncOnce(root, bridge, s, { config, now: () => now }));
  const f = (p: string) => join(root, ...p.split("/"));
  const read = (p: string) => readFileSync(f(p), "utf8");
  const write = (p: string, c: string) => {
    mkdirSync(join(f(p), ".."), { recursive: true });
    writeFileSync(f(p), c);
  };
  return { root, bridge, config, withState, sync, f, read, write };
}
const pA = "plc/PLC_1/blocks/Fx_A.scl";

describe("syncOnce", () => {
  it("behaves like pull on a fresh workspace", async () => {
    const t = setup();
    const r = await t.sync();
    expect(r.exported).toBe(1);
    expect(t.read(pA)).toBe(srcA);
  });

  it("imports a file edit, rewrites the file canonically and then stays quiet (no loop)", async () => {
    const t = setup();
    t.bridge.canon = (s) => s.replace(/\bbegin\b/i, "BEGIN").replace(/:=  +/g, ":= ");
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y :=   20;"));
    const r = await t.sync();
    expect(r.imported).toBe(1);
    expect(t.bridge.imports[0]!.expected).toMatch(/^fp:/);
    expect(t.read(pA)).toContain("#y := 20;"); // TIA's canonical form written back
    t.bridge.imports.length = 0;
    t.bridge.exportCalls = [];
    for (let i = 0; i < 10; i++) {
      const idle = await t.sync(2000 + i);
      expect(idle.imported + idle.exported).toBe(0);
    }
    expect(t.bridge.imports).toEqual([]);
    expect(t.bridge.exportCalls).toEqual([]);
  });

  it("exports a TIA edit and then stays quiet", async () => {
    const t = setup();
    await t.sync();
    t.bridge.edit(A, { ".scl": srcA.replace("#z := 3;", "#z := 30;") });
    expect((await t.sync()).exported).toBe(1);
    expect(t.read(pA)).toContain("#z := 30;");
    const idle = await t.sync();
    expect(idle.imported + idle.exported).toBe(0);
  });

  it("merges non-overlapping edits from both sides and imports the result", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#x := 1;", "#x := 10;"));
    t.bridge.edit(A, { ".scl": srcA.replace("#z := 3;", "#z := 30;") });
    const r = await t.sync();
    expect(r.merged).toBe(1);
    const text = t.read(pA);
    expect(text).toContain("#x := 10;");
    expect(text).toContain("#z := 30;");
    expect(t.bridge.objects.get(A)!.files[".scl"]).toBe(text);
  });

  it("turns overlapping edits into a conflict, keeping both versions and importing nothing", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y := 21;"));
    t.bridge.edit(A, { ".scl": srcA.replace("#y := 2;", "#y := 22;") });
    const r = await t.sync();
    expect(r.conflicts).toBe(1);
    expect(t.bridge.imports).toEqual([]);
    expect(t.read(pA)).toContain("#y := 21;"); // the user's file is untouched
    expect(t.read(pA + ".conflict")).toContain("<<<<<<< file");
    expect(t.read(pA + ".conflict")).toContain("#y := 22;");
    // stays conflicted without importing until resolved
    const again = await t.sync();
    expect(again.imported).toBe(0);
    expect(again.warnings.map((w) => w.code)).toContain("CONFLICT");
  });

  it("resolves a conflict with the merged file and imports it against the TIA revision it saw", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y := 21;"));
    t.bridge.edit(A, { ".scl": srcA.replace("#y := 2;", "#y := 22;") });
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y := 23;"));
    await t.withState((s) => resolveConflict(t.root, s, pA, "merged"));
    expect(existsSync(t.f(pA + ".conflict"))).toBe(false);
    const r = await t.sync();
    expect(r.imported).toBe(1);
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#y := 23;");
  });

  it("resolve --merged refuses when nothing was merged: the file is still only its own side", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y := 21;"));
    t.bridge.edit(A, { ".scl": srcA.replace("#y := 2;", "#y := 22;") });
    await t.sync();
    const err = await t.withState((s) => resolveConflict(t.root, s, pA, "merged")).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/still contains conflict markers: merge it there, or merge into/);
    expect(existsSync(t.f(pA + ".conflict"))).toBe(true);
  });

  it("resolve --merged takes a hand-merged .conflict file and keeps a recovery copy of the rest", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y := 21;"));
    t.bridge.edit(A, { ".scl": srcA.replace("#y := 2;", "#y := 22;") });
    await t.sync();
    // the user merges inside the .conflict file and removes the markers
    t.write(pA + ".conflict", srcA.replace("#y := 2;", "#y := 21 + 22;"));
    await t.withState((s) => resolveConflict(t.root, s, pA, "merged"));
    expect(t.read(pA)).toContain("#y := 21 + 22;");
    expect(existsSync(t.f(pA + ".conflict"))).toBe(false);
    const recovered = readdirSync(t.f(".rung/recovery"), { recursive: true }).map(String);
    expect(recovered.some((f) => f.endsWith(".scl"))).toBe(true); // the replaced primary is kept
    const r = await t.sync();
    expect(r.imported).toBe(1);
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#y := 21 + 22;");
  });

  it("resolve --merged refuses while both the file and the .conflict file still have markers", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y := 21;"));
    t.bridge.edit(A, { ".scl": srcA.replace("#y := 2;", "#y := 22;") });
    await t.sync();
    t.write(pA, t.read(pA + ".conflict"));
    await expect(t.withState((s) => resolveConflict(t.root, s, pA, "merged"))).rejects.toThrow(/conflict markers/);
  });

  it("resolve --theirs takes the TIA version", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y := 21;"));
    t.bridge.edit(A, { ".scl": srcA.replace("#y := 2;", "#y := 22;") });
    await t.sync();
    await t.withState((s) => resolveConflict(t.root, s, pA, "theirs"));
    expect(t.read(pA)).toContain("#y := 22;");
    const r = await t.sync();
    expect(r.imported + r.exported).toBe(0);
  });

  it("refuses to import edits of read-only objects and reports READ_ONLY_EDIT", async () => {
    const t = setup((b) => b.add("plc:PLC_1/blocks/Fx_F", { language: "F_LAD", isFailsafe: true, content: "safety\n" }));
    await t.sync();
    t.write("plc/PLC_1/blocks/Fx_F.scl", "hacked\n");
    const r = await t.sync();
    expect(t.bridge.imports).toEqual([]);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: "READ_ONLY_EDIT", address: "plc:PLC_1/blocks/Fx_F" }));
  });

  it("creates new objects from new files, types before the blocks that use them", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write("plc/PLC_1/blocks/30_New/Fx_User.scl", 'FUNCTION "Fx_User" : Void\nVAR_TEMP\n  t : "Fx_T";\nEND_VAR\nBEGIN\nEND_FUNCTION\n');
    t.write("plc/PLC_1/types/Fx_T.udt", 'TYPE "Fx_T"\nSTRUCT\n  a : Bool;\nEND_STRUCT;\nEND_TYPE\n');
    const r = await t.sync();
    expect(r.created).toBe(2);
    expect(t.bridge.imports.map((i) => i.address)).toEqual([T, "plc:PLC_1/blocks/30_New/Fx_User"]);
    expect(t.bridge.imports.every((i) => i.expected === "absent")).toBe(true);
    const idle = await t.sync();
    expect(idle.created + idle.imported).toBe(0);
  });

  it("does not create objects when imports are manual", async () => {
    const t = setup(() => {}, (c) => (c.sync.import = "manual"));
    await t.sync();
    t.write("plc/PLC_1/blocks/Fx_New.scl", 'FUNCTION "Fx_New" : Void\nBEGIN\nEND_FUNCTION\n');
    t.write(pA, "x\n");
    const r = await t.sync();
    expect(t.bridge.imports).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain("IMPORT_MANUAL");
  });

  it("blocks dependants of a failed import in the same pass", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write("plc/PLC_1/types/Fx_T.udt", 'TYPE "Fx_T"\nSTRUCT\nEND_STRUCT;\nEND_TYPE\n');
    t.write("plc/PLC_1/blocks/Fx_User.scl", 'FUNCTION "Fx_User" : Void\nVAR_TEMP\n  t : "Fx_T";\nEND_VAR\nBEGIN\nEND_FUNCTION\n');
    t.bridge.failImport.set(T, "IMPORT_FAILED");
    const r = await t.sync();
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ address: T, code: "IMPORT_FAILED" }));
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ address: "plc:PLC_1/blocks/Fx_User", code: "DEPENDENCY_BLOCKED" }));
    expect(t.bridge.imports.map((i) => i.address)).toEqual([T]);
  });

  it("reports cyclic dependencies instead of guessing an order", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write("plc/PLC_1/types/Fx_P.udt", 'TYPE "Fx_P"\nSTRUCT\n  q : "Fx_Q";\nEND_STRUCT;\nEND_TYPE\n');
    t.write("plc/PLC_1/types/Fx_Q.udt", 'TYPE "Fx_Q"\nSTRUCT\n  p : "Fx_P";\nEND_STRUCT;\nEND_TYPE\n');
    const r = await t.sync();
    expect(r.diagnostics.filter((d) => d.code === "DEPENDENCY_BLOCKED")).toHaveLength(2);
    expect(t.bridge.imports).toEqual([]);
  });

  it("refuses to import a file that is not UTF-8 instead of dropping its characters", async () => {
    const t = setup();
    await t.sync();
    // "Grüße" in Windows-1252: ü = 0xFC, ß = 0xDF
    writeFileSync(t.f(pA), Buffer.concat([Buffer.from(srcA.replace("BEGIN", "BEGIN\n  // Gr"), "utf8"), Buffer.from([0xfc, 0xdf]), Buffer.from("e\n", "utf8")]));
    const r = await t.sync();
    expect(t.bridge.imports).toEqual([]);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_ENCODING", address: A }));
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("skips an unreadable file for one pass instead of aborting the whole sync", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#x := 1;", "#x := 9;"));
    chmodSync(t.f(pA), 0o000);
    try {
      const r = await t.sync();
      expect(r.warnings.map((w) => w.code)).toContain("FILE_LOCKED");
    } finally {
      chmodSync(t.f(pA), 0o644);
    }
    expect((await t.sync()).imported).toBe(1);
  });

  it("publishes compile diagnostics for imported objects", async () => {
    const t = setup();
    await t.sync();
    t.bridge.compileErrors.set(A, "Tag #q not defined");
    t.write(pA, srcA.replace("#x := 1;", "#q := 1;"));
    const r = await t.sync();
    expect(t.bridge.compileCalls).toEqual([[A]]);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ address: A, path: pA, severity: "error", code: "COMPILE", message: "Tag #q not defined" }));
    const saved = JSON.parse(readFileSync(join(t.root, ".rung", "diagnostics.json"), "utf8"));
    expect(saved.items).toHaveLength(1);
    expect(saved.seq).toBeGreaterThan(0);
  });

  it("a UDT and the DB that uses it, edited together, both go to TIA in one rung sync", async () => {
    const DBG = "plc:PLC_1/blocks/Fx_G";
    const t = setup((b) => {
      b.add(T, { form: "udt", kind: "type", content: 'TYPE "Fx_T"\n   STRUCT\n      a : Bool;\n   END_STRUCT;\nEND_TYPE\n' });
      b.add(DBG, { form: "db", blockType: "GlobalDB", content: 'DATA_BLOCK "Fx_G"\n   VAR\n      s : "Fx_T";\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n' });
    });
    await t.sync();
    // like TIA: importing the UDT gives the DB that uses it a new revision
    const importObject = t.bridge.importObject.bind(t.bridge);
    t.bridge.importObject = async (address, form, path, expected, op) => {
      const r = await importObject(address, form, path, expected, op);
      if (address === T) t.bridge.objects.get(DBG)!.entry.fingerprint = "fp:regenerated";
      return r;
    };
    t.write("plc/PLC_1/types/Fx_T.udt", t.read("plc/PLC_1/types/Fx_T.udt").replace("a : Bool;", "a : Bool;\n      b : Int;"));
    t.write("plc/PLC_1/blocks/Fx_G.db", t.read("plc/PLC_1/blocks/Fx_G.db").replace('s : "Fx_T";', 's : "Fx_T";\n      n : Int;'));
    const r = await t.sync();
    expect(r.imported).toBe(2);
    expect(r.warnings.filter((w) => w.code === "STALE_REVISION")).toEqual([]);
    expect(t.bridge.objects.get(DBG)!.files[".db"]).toContain("n : Int;");
  });

  it("compiles the instance DBs and callers of an imported block too, and hides 'No block was compiled'", async () => {
    const FB = "plc:PLC_1/blocks/FB_Pump";
    const IDB = "plc:PLC_1/blocks/FB_Pump_DB";
    const OB = "plc:PLC_1/blocks/Main";
    const t = setup((b) => {
      b.add(FB, { content: 'FUNCTION_BLOCK "FB_Pump"\nBEGIN\n  #x := 1;\nEND_FUNCTION_BLOCK\n', blockType: "FB" });
      b.add(IDB, { form: "db", content: 'DATA_BLOCK "FB_Pump_DB"\n"FB_Pump"\nBEGIN\nEND_DATA_BLOCK\n', blockType: "InstanceDB" });
      b.add(OB, { content: 'ORGANIZATION_BLOCK "Main"\nBEGIN\n  "FB_Pump_DB"();\nEND_ORGANIZATION_BLOCK\n', blockType: "OB" });
      b.add("plc:PLC_1/blocks/Other", { content: 'FUNCTION "Other" : Void\nBEGIN\nEND_FUNCTION\n' });
    });
    await t.sync();
    t.write("plc/PLC_1/blocks/FB_Pump.scl", t.read("plc/PLC_1/blocks/FB_Pump.scl").replace("#x := 1;", "#x := 2;"));
    t.bridge.compile = async (_d: string, addresses: string[] = []) => {
      t.bridge.compileCalls.push(addresses);
      return [{ severity: "info", description: "No block was compiled. All blocks are up-to-date." }];
    };
    const r = await t.sync();
    expect(t.bridge.compileCalls.at(-1)!.sort()).toEqual([FB, IDB, OB]);
    expect(r.diagnostics).toEqual([]);
  });

  it("keeps compile errors of a still-broken block across quiet passes, and drops them once it compiles", async () => {
    const t = setup();
    await t.sync();
    t.bridge.compileErrors.set(A, "Tag #q not defined");
    t.write(pA, srcA.replace("#x := 1;", "#q := 1;"));
    await t.sync();
    const saved = () => JSON.parse(readFileSync(join(t.root, ".rung", "diagnostics.json"), "utf8")).items as { code: string; message: string }[];
    const quiet = await t.sync(); // nothing changed: no import, no compile
    expect(quiet.diagnostics).toEqual([]); // the report only carries what is new
    expect(saved().map((d) => d.message)).toEqual(["Tag #q not defined"]);
    t.bridge.compileErrors.delete(A);
    t.write(pA, srcA);
    await t.sync();
    expect(saved()).toEqual([]);
  });

  it("drops a kept compile error when the block changes in TIA Portal", async () => {
    const t = setup();
    await t.sync();
    t.bridge.compileErrors.set(A, "Tag #q not defined");
    t.write(pA, srcA.replace("#x := 1;", "#q := 1;"));
    await t.sync();
    t.bridge.edit(A, { ".scl": srcA.replace("#x := 1;", "#x := 5;") }); // fixed in TIA
    await t.sync();
    expect(JSON.parse(readFileSync(join(t.root, ".rung", "diagnostics.json"), "utf8")).items).toEqual([]);
  });

  it("keeps the file dirty and stops on an unknown import outcome, never retrying automatically", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#x := 1;", "#x := 11;"));
    t.bridge.hangImport = true;
    await expect(t.sync()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    t.bridge.hangImport = false;
    const r = await t.sync();
    expect(r.imported).toBe(0);
    expect(r.warnings.map((w) => w.code)).toContain("RECOVERY_REQUIRED");
    expect(t.bridge.imports).toHaveLength(1);
  });

  describe("rung resolve after an import whose outcome is unknown", () => {
    const timedOut = async (tiaGotIt: boolean) => {
      const t = setup();
      await t.sync();
      t.write(pA, srcA.replace("#x := 1;", "#x := 11;"));
      const orig = t.bridge.importObject.bind(t.bridge);
      t.bridge.importObject = async (...args) => {
        if (tiaGotIt) await orig(...args);
        else t.bridge.imports.push({ address: args[0], expected: args[3], text: "" });
        throw new BridgeError("OUTCOME_UNKNOWN", "timed out");
      };
      await expect(t.sync(2000)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      t.bridge.importObject = orig;
      return t;
    };

    it("--ours sends the file again when TIA Portal never got it", async () => {
      const t = await timedOut(false);
      await t.withState((s) => resolveConflict(t.root, s, pA, "ours"));
      const r = await t.sync(3000);
      expect([r.imported, r.conflicts]).toEqual([1, 0]);
      expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#x := 11;");
    });

    it("--ours sends nothing twice when TIA Portal has it already", async () => {
      const t = await timedOut(true);
      await t.withState((s) => resolveConflict(t.root, s, pA, "ours"));
      const r = await t.sync(3000);
      expect([r.imported, r.merged, r.conflicts, t.bridge.imports.length]).toEqual([0, 0, 0, 1]);
      expect(t.read(pA)).toContain("#x := 11;");
      const idle = await t.sync(4000);
      expect(idle.imported + idle.exported + idle.conflicts).toBe(0);
    });

    it("--theirs takes what TIA Portal has and keeps the file in recovery", async () => {
      const t = await timedOut(false);
      await t.withState((s) => resolveConflict(t.root, s, pA, "theirs"));
      await t.sync(3000);
      expect(t.read(pA)).toBe(srcA);
      expect(readdirSync(t.f(".rung/recovery"), { recursive: true }).map(String).some((f) => f.endsWith("Fx_A.scl"))).toBe(true);
      expect(t.bridge.imports).toHaveLength(1);
    });

    it("--ours creates a new object again when TIA Portal never got it", async () => {
      const t = setup(() => {});
      await t.sync();
      t.write(pA, srcA);
      t.bridge.hangImport = true;
      await expect(t.sync(2000)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      t.bridge.hangImport = false;
      expect((await t.sync(2500)).warnings.map((w) => w.code)).toContain("RECOVERY_REQUIRED");
      await t.withState((s) => resolveConflict(t.root, s, pA, "ours"));
      expect((await t.sync(3000)).created).toBe(1);
      expect(t.bridge.objects.get(A)!.files[".scl"]).toBe(srcA);
    });
  });

  it("treats STALE_REVISION during import as a concurrent TIA edit and merges on the next pass", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#x := 1;", "#x := 10;"));
    const orig = t.bridge.importObject.bind(t.bridge);
    let first = true;
    t.bridge.importObject = async (a, f, p, e, o) => {
      if (first) {
        first = false;
        t.bridge.edit(A, { ".scl": srcA.replace("#z := 3;", "#z := 30;") }); // someone saves in TIA meanwhile
      }
      return orig(a, f, p, e, o);
    };
    const r1 = await t.sync();
    expect(r1.warnings.map((w) => w.code)).toContain("STALE_REVISION");
    const r2 = await t.sync();
    expect(r2.merged).toBe(1);
    expect(t.read(pA)).toContain("#x := 10;");
    expect(t.read(pA)).toContain("#z := 30;");
  });

  it("does not overwrite an edit made while the import was running", async () => {
    const t = setup();
    t.bridge.canon = (s) => s.replace("#x :=", "#x  :=");
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y := 20;"));
    const orig = t.bridge.importObject.bind(t.bridge);
    t.bridge.importObject = async (...args) => {
      const res = await orig(...args);
      t.write(pA, srcA.replace("#y := 2;", "#y := 200;")); // user saves again during import
      return res;
    };
    await t.sync();
    expect(t.read(pA)).toContain("#y := 200;");
    t.bridge.importObject = orig;
    const r = await t.sync();
    expect(r.imported).toBe(1); // the newer edit goes to TIA on the next pass
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#y := 200;");
  });

  it("asks for confirmation before deleting in TIA and deletes only after confirmation", async () => {
    const t = setup();
    await t.sync();
    unlinkSync(t.f(pA));
    const r = await t.sync();
    expect(r.pendingDeletes).toBe(1);
    expect(t.bridge.deletes).toEqual([]);
    expect(existsSync(t.f(pA))).toBe(false);
    await t.withState((s) => confirmDelete(t.root, t.bridge, s, A));
    expect(t.bridge.deletes).toEqual([A]);
    const after = await t.sync();
    expect(after.pendingDeletes + after.exported).toBe(0);
  });

  it("restores a deleted file when deletes are disabled", async () => {
    const t = setup(undefined, (c) => (c.sync.delete = "never"));
    await t.sync();
    unlinkSync(t.f(pA));
    await t.sync();
    expect(t.read(pA)).toBe(srcA);
  });

  it("refuses a stale delete confirmation", async () => {
    const t = setup();
    await t.sync();
    unlinkSync(t.f(pA));
    await t.sync();
    t.bridge.edit(A, { ".scl": "changed in TIA\n" });
    await expect(t.withState((s) => confirmDelete(t.root, t.bridge, s, A))).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(t.bridge.objects.has(A)).toBe(true);
  });

  it("keeps a local edit of an object deleted in TIA as a conflict", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, "my edit\n");
    t.bridge.objects.delete(A);
    const r = await t.sync();
    expect(r.warnings.map((w) => w.code)).toContain("LOCAL_CHANGES");
    expect(t.read(pA)).toBe("my edit\n");
  });

  it("resolve --ours recreates an object that was deleted in TIA; the conflict does not come back", async () => {
    const t = setup();
    await t.sync();
    const mine = srcA.replace("#x := 1;", "#x := 7;");
    t.write(pA, mine);
    t.bridge.objects.delete(A);
    await t.sync();
    await t.withState((s) => resolveConflict(t.root, s, pA, "ours"));
    const r = await t.sync();
    expect(r.created).toBe(1);
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#x := 7;");
    const again = await t.sync();
    expect(again.warnings.map((w) => w.code)).not.toContain("LOCAL_CHANGES");
    expect(again.conflicts).toBe(0);
  });

  it("resolve --theirs accepts a TIA delete and keeps the edited file in recovery", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, "my edit\n");
    t.bridge.objects.delete(A);
    await t.sync();
    await t.withState((s) => resolveConflict(t.root, s, pA, "theirs"));
    expect(existsSync(t.f(pA))).toBe(false);
    expect(readdirSync(t.f(".rung/recovery"), { recursive: true }).map(String).some((f) => f.endsWith("Fx_A.scl"))).toBe(true);
    const r = await t.sync();
    expect(r.created + r.imported + r.conflicts).toBe(0);
  });

  it("treats an object new on both sides with different content as a conflict", async () => {
    const t = setup(() => {});
    t.write(pA, "mine\n");
    t.bridge.add(A, { content: "theirs\n" });
    const r = await t.sync();
    expect(r.conflicts).toBe(1);
    expect(t.read(pA)).toBe("mine\n");
    expect(t.bridge.imports).toEqual([]);
  });

  it("ignores conflict files and unrelated files in the workspace", async () => {
    const t = setup();
    await t.sync();
    t.write("plc/PLC_1/blocks/notes.txt", "hello");
    t.write(pA + ".conflict", "x");
    const r = await t.sync();
    expect(r.created + r.imported).toBe(0);
  });

  it("mirrors an instance of a library type read-only and says why an edit is not sent", async () => {
    const t = setup();
    await t.sync(); // mirrored before it was tied to the type
    t.bridge.objects.get(A)!.entry.libraryType = "LGF_FloatingAverage 3.0.2";
    await t.sync();
    expect(await t.withState(async (s) => s.get(A)!.readOnly)).toBe(true);
    t.write(pA, srcA.replace("#x := 1;", "#x := 9;"));
    const r = await t.sync();
    expect(t.bridge.imports).toEqual([]);
    expect(r.diagnostics.find((d) => d.code === "READ_ONLY_EDIT")?.message).toBe(
      "Read-only in rung: an instance of the library type LGF_FloatingAverage 3.0.2; change the type in TIA Portal's library (Edit type). The edit is not sent to TIA Portal; restore the file",
    );
  });

  it("a force table is mirrored for reading; an edit never reaches TIA Portal", async () => {
    const F = "plc:PLC_1/force/Force table";
    const t = setup((b) => b.add(F, { kind: "forcetable", form: "xml", content: "<Force/>\n" }));
    await t.sync();
    t.write("plc/PLC_1/force/Force table.xml", "<Force>mine</Force>\n");
    const r = await t.sync();
    expect(t.bridge.imports).toEqual([]);
    expect(r.diagnostics.find((d) => d.code === "READ_ONLY_EDIT")?.message).toMatch(/^Read-only in rung: a force table: forcing stays in TIA Portal\./);
  });

  it("a read-only file stays read-only when TIA Portal's change is written into it", async () => {
    const t = setup();
    await t.sync();
    chmodSync(t.f(pA), 0o444);
    t.bridge.edit(A, { ".scl": srcA.replace("#z := 3;", "#z := 30;") });
    expect((await t.sync()).exported).toBe(1);
    expect(t.read(pA)).toContain("#z := 30;");
    expect(statSync(t.f(pA)).mode & 0o200).toBe(0);
    chmodSync(t.f(pA), 0o644);
  });

  it("says which files it does not read: a second form, a spelling rung never writes, a wrong folder", async () => {
    const t = setup();
    await t.sync();
    t.write("plc/PLC_1/blocks/Fx_A.awl", "x");
    t.write("plc/PLC_1/blocks/Motor%2fValve.scl", 'FUNCTION "Motor/Valve" : Void\nBEGIN\nEND_FUNCTION\n');
    t.write("plc/PLC_1/tags/Fx_T.scl", "x");
    t.write("plc/PLC_1/blocks/Fx_N.scl", "x");
    t.write("plc/PLC_1/blocks/Fx_N.awl", "x");
    const r = await t.sync();
    expect(r.warnings.filter((w) => w.code === "IGNORED_FILE").map((w) => `${w.address}: ${w.message}`).sort()).toEqual([
      "plc/PLC_1/blocks/Fx_A.awl: a second file for Fx_A; rung mirrors it as plc/PLC_1/blocks/Fx_A.scl",
      "plc/PLC_1/blocks/Fx_N.awl: plc/PLC_1/blocks/Fx_N.awl and plc/PLC_1/blocks/Fx_N.scl are the same object; keep one",
      "plc/PLC_1/blocks/Fx_N.scl: plc/PLC_1/blocks/Fx_N.awl and plc/PLC_1/blocks/Fx_N.scl are the same object; keep one",
      "plc/PLC_1/blocks/Motor%2fValve.scl: rung spells this file plc/PLC_1/blocks/Motor%2FValve.scl; rename it",
      "plc/PLC_1/tags/Fx_T.scl: .scl files are not read in tags/ (.tags.st, .tags.xml, .st)",
    ]);
    expect(r.created + r.imported).toBe(0);
    expect(t.bridge.imports).toEqual([]);
  });

  it("says so when files are under a PLC folder the workspace does not sync", async () => {
    const t = setup(undefined, (c) => (c.devices = ["PLC_1"]));
    t.bridge.info.devices = ["PLC_1", "PLC_2"];
    await t.sync();
    t.write("plc/PLC1/blocks/Fx_New.scl", 'FUNCTION "Fx_New" : Void\nBEGIN\nEND_FUNCTION\n');
    t.write("plc/PLC1/blocks/Fx_Other.scl", 'FUNCTION "Fx_Other" : Void\nBEGIN\nEND_FUNCTION\n');
    t.write("plc/PLC_2/blocks/Fx_B.scl", 'FUNCTION "Fx_B" : Void\nBEGIN\nEND_FUNCTION\n');
    const r = await t.sync(2000);
    expect(r.warnings.filter((w) => w.code === "IGNORED_FILE").map((w) => `${w.address}: ${w.message}`)).toEqual([
      "plc/PLC1: the project has no PLC PLC1 (its PLCs: PLC_1, PLC_2); the files under it are not synced",
      "plc/PLC_2: PLC_2 is not among the devices in rung.toml; the files under it are not synced",
    ]);
    expect(t.bridge.imports).toEqual([]);
  });

  it("finishes a create that Ctrl+C interrupted after TIA Portal made the object: no conflict, no second import", async () => {
    const t = setup(() => {});
    t.bridge.canon = (s) => s.replace("begin", "BEGIN");
    await t.sync();
    t.write(pA, srcA.replace("BEGIN", "begin"));
    t.bridge.killed = "after";
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    const r = await t.sync();
    expect(r).toMatchObject({ created: 1, conflicts: 0 });
    expect(t.bridge.imports).toHaveLength(1);
    expect(t.read(pA)).toBe(srcA); // TIA's form
    expect(existsSync(t.f(pA + ".conflict"))).toBe(false);
    const idle = await t.sync();
    expect(idle.imported + idle.exported + idle.created + idle.conflicts).toBe(0);
  });

  it("an interrupted create edited afterwards sends the newer file", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write(pA, srcA);
    t.bridge.killed = "after";
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    const r = await t.sync();
    expect(r).toMatchObject({ imported: 1, conflicts: 0 });
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#x := 5;");
  });

  it("an update Ctrl+C interrupted after TIA Portal took it, then edited again: the newer edit goes in, no conflict", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    t.bridge.killed = "after";
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    t.bridge.edit(A, { ".scl": t.bridge.objects.get(A)!.files[".scl"]!.replace("#z := 3;", "#z := 30;") }); // someone in TIA Portal
    t.write(pA, srcA.replace("#x := 1;", "#x := 6;"));
    const r = await t.sync();
    expect(r.conflicts).toBe(0);
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#x := 6;");
    expect(t.read(pA)).toContain("#z := 30;");
  });

  it("an interrupted update TIA Portal never got stays a conflict when TIA Portal changed the same line", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    t.bridge.killed = "before";
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    t.bridge.edit(A, { ".scl": srcA.replace("#x := 1;", "#x := 7;") });
    const r = await t.sync();
    expect(r.conflicts).toBe(1); // neither 5 nor 7 is dropped silently
  });

  it("creates again what an interrupted pass never got into TIA Portal, and pull meanwhile keeps the file", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write(pA, srcA);
    t.bridge.killed = "before";
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    await t.withState((s) => pull(t.root, t.bridge, s, { config: t.config, now: () => 1 }));
    expect(t.read(pA)).toBe(srcA);
    const r = await t.sync();
    expect(r.created).toBe(1);
    expect(t.bridge.objects.has(A)).toBe(true);
  });

  it("an empty new file creates nothing until it has content", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write(pA, "");
    const r = await t.sync();
    expect([r.created, r.warnings.length, r.diagnostics.length, t.bridge.imports.length]).toEqual([0, 0, 0, 0]);
    t.write(pA, srcA);
    expect((await t.sync()).created).toBe(1);
  });

  it("rung watch does not send refused content again until the file or TIA Portal changes; rung sync always tries", async () => {
    const t = setup();
    const refused = new Map();
    const watchPass = (now: number) => t.withState((s) => syncOnce(t.root, t.bridge, s, { config: t.config, now: () => now, refused }));
    await watchPass(1000);
    t.write(pA, srcA.replace("#x := 1;", "#x := ;"));
    t.bridge.failImport.set(A, "IMPORT_FAILED");
    const first = await watchPass(2000);
    expect(first.diagnostics.map((d) => d.code)).toEqual(["IMPORT_FAILED"]);
    for (let i = 0; i < 3; i++) expect((await watchPass(3000 + i)).diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual(["IMPORT_FAILED: import refused: IMPORT_FAILED"]);
    expect(t.bridge.imports).toHaveLength(1);
    // a new file TIA Portal refuses is not sent again either
    const pB = "plc/PLC_1/blocks/Fx_B.scl";
    t.write(pB, 'FUNCTION "Fx_B" : Void\nBEGIN\n  #a := ;\nEND_FUNCTION\n');
    t.bridge.failImport.set(B, "IMPORT_FAILED");
    await watchPass(4000);
    await watchPass(4001);
    expect(t.bridge.imports.map((i) => i.address)).toEqual([A, B]);
    // TIA Portal changed (the missing UDT was added there, say): worth another try
    t.bridge.add(T, { kind: "type", form: "udt", content: 'TYPE "Fx_T"\nEND_TYPE\n' });
    await watchPass(5000);
    expect(t.bridge.imports.map((i) => i.address)).toEqual([A, B, A, B]);
    // the file changed: sent again
    t.write(pA, srcA.replace("#x := 1;", "#x := 2;"));
    t.bridge.failImport.delete(A);
    expect((await watchPass(6000)).imported).toBe(1);
    // a one-shot rung sync keeps no memory of refusals
    await t.sync(7000);
    await t.sync(7001);
    expect(t.bridge.imports.map((i) => i.address)).toEqual([A, B, A, B, A, B, B]);
  });

  it("an emptied file sends nothing (an editor half-way through saving, a sync client): the table in TIA Portal keeps its tags", async () => {
    const TT = "plc:PLC_1/tags/IO";
    const pT = "plc/PLC_1/tags/IO.tags.st";
    const table = "VAR_GLOBAL\n    Start AT %I0.0 : Bool;\nEND_VAR\n";
    const t = setup((b) => b.add(TT, { kind: "tagtable", form: "tags.st", content: table }));
    await t.sync();
    t.write(pT, "");
    const r = await t.sync(2000);
    expect(t.bridge.imports).toEqual([]);
    expect(r.warnings.find((w) => w.code === "EMPTY_FILE")).toEqual({ address: pT, code: "EMPTY_FILE", message: "the file is empty; nothing is sent to TIA Portal (delete the file to delete IO there)" });
    expect(t.read(pT)).toBe("");
    t.write(pT, table.replace("Start", "Go"));
    expect((await t.sync(3000)).imported).toBe(1);
    expect(t.bridge.objects.get(TT)!.files[".tags.st"]).toContain("Go AT %I0.0");
  });

  it("a refused create leaves just a new file behind", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write(pA, srcA);
    t.bridge.failImport.set(A, "IMPORT_FAILED");
    expect((await t.sync()).created).toBe(0);
    expect(await t.withState(async (s) => s.get(A))).toBeUndefined();
    t.bridge.failImport.clear();
    expect((await t.sync()).created).toBe(1);
  });

  it("clears staging folders an interrupted pass left in .rung/tmp, never a fresh one", async () => {
    const t = setup();
    await t.sync();
    const old = t.f(".rung/tmp/left-over");
    const fresh = t.f(".rung/tmp/in-use");
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(old, "obj.scl"), "x");
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(old, hourAgo, hourAgo);
    await t.sync();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("a read-only object whose edit was refused is synced again once the file is restored", async () => {
    const t = setup((b) => b.add(A, { content: srcA, knowHowProtected: true }));
    await t.sync();
    const original = t.read(pA);
    t.write(pA, original + "// mine\n");
    expect((await t.sync()).diagnostics.map((d) => d.code)).toEqual(["READ_ONLY_EDIT"]);
    expect(await t.withState(async (s) => s.get(A)!.status)).toBe("fileDirty");
    t.write(pA, original);
    await t.sync();
    expect(await t.withState(async (s) => s.get(A)!.status)).toBe("synced");
  });

  it.runIf(process.platform === "win32")("creates nothing in TIA Portal whose files would be too long for Windows", async () => {
    const t = setup();
    await t.sync();
    const deep = "plc/PLC_1/blocks/" + "Folder_With_A_Long_Name/".repeat(9) + "Fx_Deep.scl";
    t.write(deep, 'FUNCTION "Fx_Deep" : Void\nBEGIN\nEND_FUNCTION\n');
    const r = await t.sync();
    expect(r.created).toBe(0);
    expect(t.bridge.imports).toEqual([]);
    expect(r.warnings.find((w) => w.code === "PATH_TOO_LONG")?.address).toBe(deep);
  });

  it("follows a case-only rename in TIA Portal: no conflict, the file follows the new name", async () => {
    const t = setup();
    await t.sync();
    const FX = "plc:PLC_1/blocks/FX_A";
    t.bridge.objects.delete(A);
    t.bridge.add(FX, { content: srcA.replace('"Fx_A"', '"FX_A"') });
    const r = await t.sync(2000);
    expect([r.conflicts, r.removed]).toEqual([0, 0]);
    expect(readdirSync(t.f("plc/PLC_1/blocks"))).toEqual(["FX_A.scl"]);
    expect(t.read("plc/PLC_1/blocks/FX_A.scl")).toContain('FUNCTION "FX_A"');
    expect(await t.withState(async (s) => s.all().map((x) => `${x.address} ${x.status}`))).toEqual([`${FX} synced`]);
    const idle = await t.sync(3000);
    expect(idle.imported + idle.exported + idle.created + idle.conflicts + idle.removed).toBe(0);
  });

  it("keeps a local edit across a case-only rename in TIA Portal", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#z := 3;", "#z := 30;"));
    const FX = "plc:PLC_1/blocks/FX_A";
    t.bridge.objects.delete(A);
    t.bridge.add(FX, { content: srcA.replace('"Fx_A"', '"FX_A"') });
    const r = await t.sync(2000);
    expect(r.conflicts).toBe(0);
    expect(t.bridge.objects.get(FX)!.files[".scl"]).toContain("#z := 30;");
    expect(t.read("plc/PLC_1/blocks/FX_A.scl")).toContain("#z := 30;");
    expect(t.bridge.objects.has(A)).toBe(false);
  });

  it.runIf(process.platform !== "linux")("a file renamed only by letter case is the same object: nothing is created", async () => {
    const t = setup();
    await t.sync();
    renameSync(t.f(pA), t.f("plc/PLC_1/blocks/fx_a.scl"));
    const r = await t.sync(2000);
    expect([r.created, r.imported, t.bridge.imports.length]).toEqual([0, 0, 0]);
    expect([...t.bridge.objects.keys()]).toEqual([A]);
    expect(r.warnings.find((w) => w.code === "IGNORED_FILE")?.message).toBe("Fx_A is mirrored as plc/PLC_1/blocks/Fx_A.scl; a name that differs only in letter case is the same object (rename it in TIA Portal: rung rename)");
    // an edit of the renamed file still goes to TIA Portal
    writeFileSync(t.f("plc/PLC_1/blocks/fx_a.scl"), srcA.replace("#x := 1;", "#x := 11;"));
    const e = await t.sync(3000);
    expect(e.imported).toBe(1);
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#x := 11;");
    // so does one of a file whose extension changed case
    renameSync(t.f("plc/PLC_1/blocks/fx_a.scl"), t.f("plc/PLC_1/blocks/Fx_A.SCL"));
    writeFileSync(t.f("plc/PLC_1/blocks/Fx_A.SCL"), srcA.replace("#x := 1;", "#x := 12;"));
    const u = await t.sync(4000);
    expect([u.imported, u.warnings.map((w) => w.code)]).toEqual([1, ["IGNORED_FILE"]]);
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#x := 12;");
  });

  it("interoperates with pull state (pull then sync is quiet)", async () => {
    const t = setup();
    await t.withState((s) => pull(t.root, t.bridge, s, { config: t.config, now: () => 1 }));
    const r = await t.sync();
    expect(r.imported + r.exported + r.created).toBe(0);
    expect(readdirSync(t.f("plc/PLC_1/blocks"))).toEqual(["Fx_A.scl"]);
  });
});

describe("a table whose form changes in TIA Portal's export (tags.xml → tags.st)", () => {
  const TT = "plc:PLC_1/tags/IO";
  it("a local edit of the old form is sent, not a conflict, and the new form replaces the old file", async () => {
    const t = setup((b) => b.add(TT, { kind: "tagtable", form: "tags.xml", content: "<table v1/>\n", fingerprint: "dt:1" }));
    await t.sync();
    expect(t.read("plc/PLC_1/tags/IO.tags.xml")).toBe("<table v1/>\n");
    // rung now exports the table as text; the table itself did not change in TIA Portal
    const o = t.bridge.objects.get(TT)!;
    o.form = "tags.st";
    o.files = { ".tags.st": "VAR_GLOBAL\nEND_VAR\n" };
    t.bridge.importObject = async (address: string, form: string, path: string, expected: string) => {
      t.bridge.imports.push({ address, expected, text: readFileSync(path, "utf8") });
      o.files = { ".tags.st": "VAR_GLOBAL\n    // v2\nEND_VAR\n" };
      o.entry.fingerprint = "dt:2";
      return t.bridge.exportObject(address, "auto", mkdtempSync(join(tmpdir(), "rung-bridge-out-")));
    };
    t.write("plc/PLC_1/tags/IO.tags.xml", "<table v2/>\n");
    const r = await t.sync(2000);
    expect(r.conflicts).toBe(0);
    expect(t.bridge.imports.map((i) => [i.text, i.expected])).toEqual([["<table v2/>\n", "dt:1"]]);
    expect(t.read("plc/PLC_1/tags/IO.tags.st")).toBe("VAR_GLOBAL\n    // v2\nEND_VAR\n");
    expect(existsSync(t.f("plc/PLC_1/tags/IO.tags.xml"))).toBe(false);
    const quiet = await t.sync(3000);
    expect(quiet.imported + quiet.exported + quiet.pendingDeletes).toBe(0);
  });
});

describe("network settings (plc/<PLC>/hardware/network.yaml)", () => {
  const N = "plc:PLC_1/hardware/network";
  const pN = "plc/PLC_1/hardware/network.yaml";
  const yaml = '"PLC_1 / PROFINET interface_1":\n  ip: 192.168.0.1\n  subnetMask: 255.255.255.0\n\n"IO device_1 / PROFINET interface":\n  ip: 192.168.0.2\n  deviceName: auto\n';

  it("sends an edit, merges it with a change made in TIA Portal, and puts a deleted file back", async () => {
    const t = setup((b) => b.add(N, { kind: "hardware", form: "yaml", content: yaml }));
    await t.sync();
    expect(t.read(pN)).toBe(yaml);
    t.write(pN, yaml.replace("192.168.0.1", "192.168.0.10"));
    t.bridge.edit(N, { ".yaml": yaml.replace("deviceName: auto", "deviceName: line-io") });
    const r = await t.sync(2000);
    expect(r.merged).toBe(1);
    expect(t.read(pN)).toBe(yaml.replace("192.168.0.1", "192.168.0.10").replace("deviceName: auto", "deviceName: line-io"));
    unlinkSync(t.f(pN));
    const d = await t.sync(3000);
    expect(d.pendingDeletes).toBe(0);
    expect(d.warnings.map((w) => w.code)).toContain("NOT_DELETABLE");
    expect(t.read(pN)).toContain("ip: 192.168.0.10");
    expect(t.bridge.deletes).toEqual([]);
  });
});
