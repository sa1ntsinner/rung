// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
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

  async importObject(address: string, form: string, path: string, expected: string): Promise<ExportResult> {
    const text = readFileSync(path, "utf8");
    this.imports.push({ address, expected, text });
    if (this.hangImport) throw new BridgeError("OUTCOME_UNKNOWN", "timed out");
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

  it("interoperates with pull state (pull then sync is quiet)", async () => {
    const t = setup();
    await t.withState((s) => pull(t.root, t.bridge, s, { config: t.config, now: () => 1 }));
    const r = await t.sync();
    expect(r.imported + r.exported + r.created).toBe(0);
    expect(readdirSync(t.f("plc/PLC_1/blocks"))).toEqual(["Fx_A.scl"]);
  });
});
