// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, Journal, StateStore, defaultConfig, sha256, type RungConfig } from "@rung/core";
import { BridgeError, type CompileMessage, type ExportResult } from "@rung/bridge-client";
import { pull, syncOnce, syncQuick, confirmDelete, resolveConflict, restoreFile } from "../src/index.js";
import { withoutLayout } from "../src/sync.js";
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
  /** TIA Portal took the import, but its answer is this error (another Openness client replaced the block meanwhile) */
  failAfter: string | undefined;

  /** the operations TIA Portal committed: the bridge's receipts (undefined: a bridge that keeps none) */
  landed: Set<string> | undefined = new Set();
  async receipts(ops: string[]): Promise<string[] | undefined> {
    return this.landed ? ops.filter((o) => this.landed!.has(o)) : undefined;
  }

  async importObject(address: string, form: string, path: string, expected: string, op = ""): Promise<ExportResult> {
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
    this.landed?.add(op);
    if (this.killed === "after") throw new Error("killed"); // TIA Portal has it; rung never heard back
    if (this.failAfter) throw new BridgeError(this.failAfter, "No object at " + address);
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

  it("hands the next bridge what this one read, so it reads again only what changed", async () => {
    const at = "2026-10-01T12:00:00.0000000Z";
    const t = setup((b) => b.add(A, { content: srcA, revisionKey: "dt:1|True", revisionAt: at, libraryType: "Lib 1.0" }).add(B));
    await t.sync();
    await t.sync();
    expect(t.bridge.known[0]).toEqual({});
    // B came without a key (a bridge that does not keep them): nothing to hand on for it
    expect(t.bridge.known[1]).toEqual({ [A]: { key: "dt:1|True", fingerprint: t.bridge.objects.get(A)!.entry.fingerprint, at, libraryType: "Lib 1.0" } });
    writeFileSync(t.f(".rung/revisions.json"), "{");
    await t.sync();
    expect(t.bridge.known[2]).toEqual({});
  });

  it("a file that only got other line endings (git checkout with core.autocrlf) is no edit: nothing goes to TIA Portal", async () => {
    const t = setup();
    await t.sync();
    const crlf = srcA.replace(/\n/g, "\r\n");
    t.write(pA, "﻿" + crlf);
    const r = await t.sync(2000);
    expect(r.imported).toBe(0);
    expect(t.bridge.imports).toEqual([]);
    expect(t.read(pA)).toBe("﻿" + crlf); // left as git wrote it
    // a change in TIA Portal still replaces it, without calling it a local edit
    t.bridge.edit(A, { ".scl": srcA.replace("#z := 3;", "#z := 30;") });
    const back = await t.sync(3000);
    expect(back.warnings).toEqual([]);
    expect(t.read(pA)).toContain("#z := 30;");
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

  it("resolve --merged refuses an untouched file even when TIA Portal's other changes merged into the .conflict", async () => {
    const t = setup();
    const long = (x: string, z: string) => `FUNCTION "Fx_A" : Void\nBEGIN\n  #x := ${x};\n  #a := 1;\n  #b := 2;\n  #c := 3;\n  #d := 4;\n  #z := ${z};\nEND_FUNCTION\n`;
    t.bridge.edit(A, { ".scl": long("1", "3") });
    await t.sync();
    t.write(pA, long("21", "3")); // the person changes x
    t.bridge.edit(A, { ".scl": long("22", "33") }); // TIA Portal changes x too, and z far away
    await t.sync();
    const conflict = readFileSync(t.f(pA + ".conflict"), "utf8");
    expect(conflict).toContain("#z := 33;"); // TIA's z merged cleanly into the .conflict
    const err = await t.withState((s) => resolveConflict(t.root, s, pA, "merged")).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/still contains conflict markers/);
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

  it("exports a watch table, which has no revision, every pass, or with rung watch's interval once a minute", async () => {
    const W = "plc:PLC_1/watch/Fx_Watch";
    const t = setup((b) => b.add(W, { kind: "watchtable", form: "xml", content: "<Watch/>\n", fingerprint: "none" }));
    const pass = (now: number, unversionedMs?: number) => t.withState((s) => syncOnce(t.root, t.bridge, s, { config: t.config, now: () => now, ...(unversionedMs ? { unversionedMs } : {}) }));
    await pass(1000);
    const exports = () => t.bridge.exportCalls.filter((a) => a === W).length;
    expect(exports()).toBe(1);
    await pass(2000);
    expect(exports()).toBe(2); // rung sync: every time
    await pass(30_000, 60_000);
    expect(exports()).toBe(2); // rung watch, checked 28 s ago
    t.bridge.edit(W, { ".xml": "<Watch><Entry/></Watch>\n" });
    await pass(70_000, 60_000);
    expect(exports()).toBe(3);
    expect(t.read("plc/PLC_1/watch/Fx_Watch.xml")).toBe("<Watch><Entry/></Watch>\n");
    // the clock was put back: a check "from the future" counts as none, for rung sync and rung watch alike
    t.bridge.edit(W, { ".xml": "<Watch><Entry/><Entry/></Watch>\n" });
    await pass(10_000);
    expect(exports()).toBe(4);
    t.bridge.edit(W, { ".xml": "<Watch/>\n" });
    await pass(5_000, 60_000);
    expect(exports()).toBe(5);
    expect(t.read("plc/PLC_1/watch/Fx_Watch.xml")).toBe("<Watch/>\n");
  });

  it.each(["landed", "lost"])("an import whose answer was lost when the bridge stopped (%s) is finished on the next pass with the receipts", async (how) => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#x := 1;", "#x := 2;"));
    if (how === "landed") t.bridge.failAfter = "OUTCOME_UNKNOWN"; // TIA Portal took it; the answer never came
    else t.bridge.hangImport = true; // it never reached TIA Portal
    await expect(t.sync()).rejects.toThrow();
    t.bridge.failAfter = undefined;
    t.bridge.hangImport = false;
    t.write(pA, srcA.replace("#x := 1;", "#x := 3;"));
    const r = await t.sync();
    expect(r.warnings.map((w) => w.code)).not.toContain("RECOVERY_REQUIRED");
    expect(r.conflicts).toBe(0);
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#x := 3;");
    expect((await t.sync()).imported).toBe(0);
  });

  it.each(["landed", "lost"])("a create whose answer was lost when the bridge stopped (%s) is finished on the next pass", async (how) => {
    const t = setup(() => {});
    await t.sync();
    t.write(pA, srcA);
    if (how === "landed") t.bridge.failAfter = "OUTCOME_UNKNOWN";
    else t.bridge.hangImport = true;
    await expect(t.sync()).rejects.toThrow();
    t.bridge.failAfter = undefined;
    t.bridge.hangImport = false;
    const r = await t.sync();
    expect(r.warnings.map((w) => w.code)).not.toContain("RECOVERY_REQUIRED");
    expect(r.conflicts).toBe(0);
    expect(t.bridge.objects.get(A)!.files[".scl"]).toBe(srcA);
    const idle = await t.sync();
    expect(idle.imported + idle.created + idle.conflicts).toBe(0);
  });

  it("finds a landed send in TIA Portal's layout of it (TIA ends its sources with a blank line), so no false conflict", async () => {
    const t = setup((b) => b.add(A, { content: srcA + "\n" }));
    t.bridge.canon = (s) => (s.endsWith("\n\n") ? s : s + "\n");
    await t.sync();
    t.write(pA, srcA.replace("#x := 1;", "#x := 2;")); // the person's layout: no blank line at the end
    t.bridge.failAfter = "OUTCOME_UNKNOWN";
    await expect(t.sync()).rejects.toThrow();
    t.bridge.failAfter = undefined;
    t.write(pA, srcA.replace("#x := 1;", "#x := 3;"));
    const r = await t.sync();
    expect(r.conflicts).toBe(0);
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#x := 3;");
  });

  it.each(["undone", "undone and another line edited"])("an edit TIA Portal took without answering, then %s in the file: the file wins", async (how) => {
    const src = 'FUNCTION "Fx_A" : Void\nBEGIN\n  #x := 1;\n  #y := 2;\n  #z := 3;\n  #w := 4;\nEND_FUNCTION\n';
    const t = setup((b) => b.add(A, { content: src }));
    await t.sync();
    t.write(pA, src.replace("#x := 1;", "#x := 9;"));
    t.bridge.failAfter = "OUTCOME_UNKNOWN"; // TIA Portal took x = 9, the answer never came
    await expect(t.sync()).rejects.toThrow();
    t.bridge.failAfter = undefined;
    t.write(pA, how === "undone" ? src : src.replace("#w := 4;", "#w := 40;")); // the person takes x = 9 back
    const r = await t.sync();
    expect(r.conflicts).toBe(0);
    const tia = t.bridge.objects.get(A)!.files[".scl"]!;
    expect(tia).toContain("#x := 1;");
    if (how !== "undone") expect(tia).toContain("#w := 40;");
    expect(t.read(pA)).toContain("#x := 1;");
  });

  it("a create that never reached TIA Portal does not take an object someone else created there under the name", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write(pA, srcA);
    t.bridge.hangImport = true; // the create never reaches TIA Portal
    await expect(t.sync()).rejects.toThrow();
    t.bridge.hangImport = false;
    t.bridge.add(A, { content: srcA.replace("#x := 1;", "#x := 7;") }); // someone else's Fx_A
    const r = await t.sync();
    expect(r.conflicts).toBe(1);
    expect(t.read(pA)).toBe(srcA); // the person's own file stays theirs
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#x := 7;");
  });

  it("without receipts an import with an unknown outcome waits for rung resolve", async () => {
    const t = setup();
    t.bridge.landed = undefined;
    await t.sync();
    t.write(pA, srcA.replace("#x := 1;", "#x := 2;"));
    t.bridge.failAfter = "OUTCOME_UNKNOWN";
    await expect(t.sync()).rejects.toThrow();
    t.bridge.failAfter = undefined;
    expect((await t.sync()).warnings.map((w) => w.code)).toContain("RECOVERY_REQUIRED");
  });

  it("an import refused as stale is merged on the next pass even while the listing still shows the old fingerprint", async () => {
    const t = setup();
    await t.sync();
    const old = t.bridge.objects.get(A)!.entry.fingerprint;
    // a TIA edit the listing does not show (its fingerprint kept by modification dates)
    t.bridge.edit(A, { ".scl": srcA.replace("#z := 3;", "#z := 30;") });
    const list = t.bridge.listObjects.bind(t.bridge);
    t.bridge.listObjects = async (device: string) => (await list(device)).map((e) => (e.address === A ? { ...e, fingerprint: old } : e));
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    const refused = await t.sync();
    expect(refused.warnings.map((w) => w.code)).toContain("STALE_REVISION");
    await t.sync();
    const tia = t.bridge.objects.get(A)!.files[".scl"]!;
    expect(tia).toContain("#x := 5;");
    expect(tia).toContain("#z := 30;");
    expect(t.read(pA)).toContain("#z := 30;");
  });

  it("creates a new file in a software unit's folder in that unit, and then stays quiet", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write("plc/PLC_1/units/Fx_Unit/blocks/Drives/Fx_InUnit.scl", 'FUNCTION "Fx_InUnit" : Void\nBEGIN\nEND_FUNCTION\n');
    const r = await t.sync();
    expect(r.created).toBe(1);
    expect(t.bridge.imports.map((i) => [i.address, i.expected])).toEqual([["plc:PLC_1/units/Fx_Unit/blocks/Drives/Fx_InUnit", "absent"]]);
    const idle = await t.sync();
    expect(idle.created + idle.imported + idle.exported).toBe(0);
    expect(idle.warnings).toEqual([]);
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

  it("without receipts keeps the file dirty and stops on an unknown import outcome, never retrying automatically", async () => {
    const t = setup();
    t.bridge.landed = undefined; // a bridge that keeps no receipts: nothing tells whether TIA Portal took it
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
    // with a bridge that keeps no receipts (with receipts the next pass settles it by itself)
    const timedOut = async (tiaGotIt: boolean) => {
      const t = setup();
      t.bridge.landed = undefined;
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
      t.bridge.landed = undefined;
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

  it("a file deleted since the last pass can be confirmed at once, as rung status already lists it", async () => {
    const t = setup();
    await t.sync();
    unlinkSync(t.f(pA));
    await t.withState((s) => confirmDelete(t.root, t.bridge, s, A));
    expect(t.bridge.deletes).toEqual([A]);
  });

  it("a block others still use: the confirmation names them and only --force deletes it", async () => {
    const t = setup((b) => b.add(A, { content: srcA }).add(B, { content: 'FUNCTION "Fx_B" : Void\nBEGIN\n  "Fx_A"();\nEND_FUNCTION\n' }));
    await t.sync();
    unlinkSync(t.f(pA));
    await t.sync();
    await expect(t.withState((s) => confirmDelete(t.root, t.bridge, s, A))).rejects.toMatchObject({ code: "IN_USE", message: expect.stringContaining("plc/PLC_1/blocks/Fx_B.scl") });
    expect(t.bridge.deletes).toEqual([]);
    const r = await t.withState((s) => confirmDelete(t.root, t.bridge, s, A, { force: true }));
    expect(r.users).toEqual([B]);
    expect(t.bridge.deletes).toEqual([A]);
  });

  it("a PLC's default tag table is never deleted: the file comes back", async () => {
    const T = "plc:PLC_1/tags/Default tag table";
    const t = setup((b) => b.add(T, { form: "tags.st", content: "VAR_GLOBAL\n    Start AT %I0.0 : Bool;\nEND_VAR\n" }));
    await t.sync();
    const p = "plc/PLC_1/tags/Default tag table.tags.st";
    unlinkSync(t.f(p));
    const r = await t.sync(2000);
    expect(r.pendingDeletes).toBe(0);
    expect(r.warnings.map((w) => w.code)).toContain("NOT_DELETABLE");
    expect(existsSync(t.f(p))).toBe(true);
  });

  it("rung restore puts TIA Portal's version of one file back, keeping the person's, and a deleted file too", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, "my edit\n");
    const r = await t.withState((s) => restoreFile(t.root, s, pA));
    expect(t.read(pA)).toBe(srcA);
    expect(r.copy).toMatch(/^\.rung\/recovery\/restore-/);
    const kept = readdirSync(t.f(r.copy!), { recursive: true }).map(String).filter((f) => f.endsWith(".scl"));
    expect(kept.some((f) => readFileSync(join(t.f(r.copy!), f), "utf8") === "my edit\n")).toBe(true);
    unlinkSync(t.f(pA));
    await t.sync(2000); // a pending delete now
    expect((await t.withState((s) => restoreFile(t.root, s, pA))).wasDeleted).toBe(true);
    expect(t.read(pA)).toBe(srcA);
    const after = await t.sync(3000);
    expect(after.pendingDeletes + after.imported).toBe(0);
  });

  it("a block renamed by hand (git mv and the header) is not created a second time: it says how to rename it in TIA Portal", async () => {
    const t = setup();
    await t.sync();
    unlinkSync(t.f(pA));
    t.write("plc/PLC_1/blocks/Fx_Renamed.scl", srcA.replace('"Fx_A"', '"Fx_Renamed"'));
    const r = await t.sync(2000);
    expect(r.created).toBe(0);
    expect(t.bridge.objects.has("plc:PLC_1/blocks/Fx_Renamed")).toBe(false);
    const d = r.diagnostics.find((x) => x.code === "LOOKS_LIKE_RENAME")!;
    expect(d.message).toContain(`rung rename ${pA} Fx_Renamed`);
    // a new block that only resembles it is created as usual once the old one's delete is confirmed
    await t.withState((s) => confirmDelete(t.root, t.bridge, s, A));
    expect((await t.sync(3000)).created).toBe(1);
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
      "Read-only in rung: an instance of the library type LGF_FloatingAverage 3.0.2; change the type in TIA Portal's library (Edit type). The edit is not sent to TIA Portal; rung restore plc/PLC_1/blocks/Fx_A.scl takes TIA Portal's version back",
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

  it("several interrupted updates in a row: TIA Portal's version is an earlier send, still no conflict (soak, seed 7)", async () => {
    const t = setup();
    await t.sync();
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    t.bridge.killed = "after"; // TIA Portal takes 5, rung never learns it
    await expect(t.sync()).rejects.toThrow("killed");
    t.write(pA, srcA.replace("#x := 1;", "#x := 6;"));
    t.bridge.killed = "before"; // 6 is sent, TIA Portal never gets it
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    t.bridge.edit(A, { ".scl": t.bridge.objects.get(A)!.files[".scl"]!.replace("#z := 3;", "#z := 30;") }); // someone in TIA Portal
    t.write(pA, srcA.replace("#x := 1;", "#x := 7;"));
    const r = await t.sync();
    expect(r.conflicts).toBe(0);
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#x := 7;");
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#z := 30;");
    expect(t.read(pA)).toContain("#z := 30;");
    await t.withState(async (s) => expect([s.get(A)!.sending, s.get(A)!.sent]).toEqual([undefined, undefined]));
  });

  it("an interrupted merge TIA Portal took, then TIA Portal edited again: the file's newer edit merges, no conflict (soak, seed 7)", async () => {
    const t = setup();
    await t.sync();
    const tiaNow = () => t.bridge.objects.get(A)!.files[".scl"]!;
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    t.bridge.edit(A, { ".scl": tiaNow().replace("#z := 3;", "#z := 30;") });
    t.bridge.killed = "after"; // TIA Portal takes the merge (x 5, z 30), the file never gets z 30
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    t.bridge.edit(A, { ".scl": tiaNow().replace("#z := 30;", "#z := 31;") }); // the same person again, on their line
    t.write(pA, srcA.replace("#x := 1;", "#x := 6;"));
    const r = await t.sync();
    expect(r.conflicts).toBe(0);
    expect(tiaNow()).toContain("#x := 6;");
    expect(tiaNow()).toContain("#z := 31;");
    expect(t.read(pA)).toBe(tiaNow());
  });

  it("an interrupted merge TIA Portal took keeps TIA Portal's side when the file is edited again", async () => {
    const t = setup();
    await t.sync();
    const tiaNow = () => t.bridge.objects.get(A)!.files[".scl"]!;
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    t.bridge.edit(A, { ".scl": tiaNow().replace("#z := 3;", "#z := 30;") });
    t.bridge.killed = "after";
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    t.write(pA, srcA.replace("#x := 1;", "#x := 6;")); // the file still has z 3: rung never wrote the merge back
    const r = await t.sync();
    expect(r.conflicts).toBe(0);
    expect(tiaNow()).toContain("#x := 6;");
    expect(tiaNow()).toContain("#z := 30;"); // not reverted to the file's old line
    expect(t.read(pA)).toBe(tiaNow());
  });

  it("an import TIA Portal took although its answer was an error, then both edited: the next pass merges (soak, seed 7)", async () => {
    const t = setup();
    await t.sync();
    const tiaNow = () => t.bridge.objects.get(A)!.files[".scl"]!;
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    t.bridge.failAfter = "NOT_FOUND";
    expect((await t.sync()).imported).toBe(0);
    t.bridge.failAfter = undefined;
    t.bridge.edit(A, { ".scl": tiaNow().replace("#z := 3;", "#z := 30;") });
    t.write(pA, srcA.replace("#x := 1;", "#x := 6;"));
    const r = await t.sync();
    expect(r.conflicts).toBe(0);
    expect(tiaNow()).toContain("#x := 6;");
    expect(tiaNow()).toContain("#z := 30;");
    expect(t.read(pA)).toBe(tiaNow());
  });

  it("a write-back a kill interrupted, then the file edited: the edit merges with TIA Portal's version (soak, seed 7)", async () => {
    const t = setup();
    await t.sync();
    const tiaNow = () => t.bridge.objects.get(A)!.files[".scl"]!;
    t.bridge.edit(A, { ".scl": tiaNow().replace("#z := 3;", "#z := 30;") }); // someone in TIA Portal
    // rung read TIA Portal's version and was killed before writing it to the file
    const hash = await new BlobStore(t.root).put(tiaNow());
    const st = await t.withState(async (s) => s.get(A)!);
    const next = { ...st, files: [{ ...st.files[0]!, hash }], tiaFingerprint: t.bridge.objects.get(A)!.entry.fingerprint };
    await new Journal(t.root).write({ opId: "killed", address: A, targets: [{ path: pA, hash, prevHash: sha256(readFileSync(t.f(pA))) }], removes: [], nextState: next });
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;")); // the person edits the file meanwhile
    const r = await t.sync();
    expect(r.warnings.map((w) => w.code)).toEqual(["WRITE_BACK_DROPPED"]);
    expect(r.conflicts).toBe(0);
    expect(tiaNow()).toContain("#x := 5;");
    expect(tiaNow()).toContain("#z := 30;");
    expect(t.read(pA)).toBe(tiaNow());
    const idle = await t.sync();
    expect(idle.imported + idle.exported + idle.merged + idle.conflicts + idle.warnings.length).toBe(0);
  });

  it("an interrupted create TIA Portal made, then edited on both sides: both edits stay (soak, seed 7)", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write(pA, srcA);
    t.bridge.killed = "after";
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    const tiaNow = () => t.bridge.objects.get(A)!.files[".scl"]!;
    t.bridge.edit(A, { ".scl": tiaNow().replace("#z := 3;", "#z := 30;") });
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    const r = await t.sync();
    expect(r.conflicts).toBe(0);
    expect(tiaNow()).toContain("#x := 5;");
    expect(tiaNow()).toContain("#z := 30;");
    expect(t.read(pA)).toBe(tiaNow());
  });

  it("an interrupted create: a change of spaces inside a string in TIA Portal is an edit, not layout", async () => {
    const t = setup(() => {});
    await t.sync();
    const src = srcA.replace("#z := 3;", "#s := 'a b';");
    t.write(pA, src);
    t.bridge.killed = "after";
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    const tiaNow = () => t.bridge.objects.get(A)!.files[".scl"]!;
    t.bridge.edit(A, { ".scl": tiaNow().replace("'a b'", "'ab'") });
    t.write(pA, src.replace("#x := 1;", "#x := 5;"));
    const r = await t.sync();
    expect(r.conflicts).toBe(0);
    expect(tiaNow()).toContain("#s := 'ab';");
    expect(tiaNow()).toContain("#x := 5;");
  });

  it("an interrupted create whose next send TIA Portal refuses keeps its base: no whole-file conflict later (soak, seed 11)", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write(pA, srcA);
    t.bridge.killed = "after";
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    t.bridge.failImport.set(A, "STALE_REVISION"); // someone changed it in TIA Portal just before the send
    await t.sync();
    t.bridge.failImport.delete(A);
    await t.withState(async (s) => expect(s.get(A)?.files.length).toBe(1));
    const tiaNow = () => t.bridge.objects.get(A)!.files[".scl"]!;
    t.bridge.edit(A, { ".scl": tiaNow().replace("#z := 3;", "#z := 30;") });
    const r = await t.sync();
    expect(r.conflicts).toBe(0);
    expect(tiaNow()).toContain("#x := 5;");
    expect(tiaNow()).toContain("#z := 30;");
  });

  it("an interrupted create edited on both sides whose merged send TIA Portal refuses: the next pass merges again, nothing of TIA's is lost", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write(pA, srcA);
    t.bridge.killed = "after";
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    const tiaNow = () => t.bridge.objects.get(A)!.files[".scl"]!;
    t.bridge.edit(A, { ".scl": tiaNow().replace("#z := 3;", "#z := 30;") }); // TIA Portal changed before the retry
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    t.bridge.failImport.set(A, "IMPORT_FAILED"); // the merged send is refused
    const refused = await t.sync();
    expect(refused.imported + refused.merged).toBe(0);
    t.bridge.failImport.delete(A);
    // TIA Portal unchanged since: the next pass must still merge, not send the file over TIA's edit
    const r = await t.sync();
    expect(r.conflicts).toBe(0);
    expect(tiaNow()).toContain("#x := 5;");
    expect(tiaNow()).toContain("#z := 30;");
    expect(t.read(pA)).toBe(tiaNow());
  });

  it("an interrupted create both edited on the same line is a conflict, not an overwrite", async () => {
    const t = setup(() => {});
    await t.sync();
    t.write(pA, srcA);
    t.bridge.killed = "after";
    await expect(t.sync()).rejects.toThrow("killed");
    t.bridge.killed = undefined;
    t.bridge.edit(A, { ".scl": t.bridge.objects.get(A)!.files[".scl"]!.replace("#x := 1;", "#x := 7;") });
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    const r = await t.sync();
    expect(r.conflicts).toBe(1);
    expect(t.bridge.objects.get(A)!.files[".scl"]).toContain("#x := 7;");
    expect(t.read(pA)).toContain("#x := 5;");
  });

  it("with receipts, an older send TIA Portal holds again is someone's change back to it: a conflict, not a base (fifth review)", async () => {
    const t = setup();
    await t.sync();
    const tiaNow = () => t.bridge.objects.get(A)!.files[".scl"]!;
    t.write(pA, srcA.replace("#x := 1;", "#x := 5;"));
    t.bridge.killed = "after"; // TIA Portal takes 5
    await expect(t.sync()).rejects.toThrow("killed");
    t.write(pA, srcA.replace("#x := 1;", "#x := 6;"));
    await expect(t.sync()).rejects.toThrow("killed"); // and 6
    t.bridge.killed = undefined;
    t.bridge.edit(A, { ".scl": tiaNow().replace("#x := 6;", "#x := 5;") }); // someone in TIA Portal puts 5 back
    t.write(pA, srcA.replace("#x := 1;", "#x := 7;"));
    const r = await t.sync();
    expect(r.conflicts).toBe(1); // neither 7 nor the change back to 5 is dropped silently
    expect(tiaNow()).toContain("#x := 5;");
    expect(t.read(pA)).toContain("#x := 7;");
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

  it.runIf(process.platform === "linux")("a file renamed only by letter case on Linux creates nothing: TIA Portal would take it for the object it mirrors", async () => {
    const t = setup();
    await t.sync();
    renameSync(t.f(pA), t.f("plc/PLC_1/blocks/fx_a.scl"));
    const r = await t.sync(2000);
    expect([r.created, r.imported, t.bridge.imports.length]).toEqual([0, 0, 0]);
    expect([...t.bridge.objects.keys()]).toEqual([A]);
    expect(r.warnings.find((w) => w.code === "IGNORED_FILE")?.message).toBe("Fx_A is mirrored as plc/PLC_1/blocks/Fx_A.scl; a name that differs only in letter case is the same object (rename it in TIA Portal: rung rename)");
    // the old name back: nothing to do
    renameSync(t.f("plc/PLC_1/blocks/fx_a.scl"), t.f(pA));
    const back = await t.sync(3000);
    expect(back.imported + back.exported + back.created + back.conflicts + back.removed).toBe(0);
    expect(await t.withState(async (s) => s.get(A)!.status)).toBe("synced");
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

describe("TIA Portal's layout of a text", () => {
  it("ignores spaces and line breaks, but not where a line comment ends or what is inside strings and comments", () => {
    expect(withoutLayout("BEGIN\n  #x := 1;\n\n")).toBe(withoutLayout("BEGIN #x:=1;"));
    expect(withoutLayout("// note\n#x := 1;")).not.toBe(withoutLayout("// note #x := 1;"));
    // a quote in a comment opens no string
    expect(withoutLayout("// don't\n#x := 1;  #y := 2;")).toBe(withoutLayout("// don't\n#x := 1;\n#y := 2;"));
    expect(withoutLayout("(* it's *) #x := 1;")).toBe(withoutLayout("(* it's *)\n#x := 1;"));
    expect(withoutLayout("#s := 'a  b';")).not.toBe(withoutLayout("#s := 'a b';"));
  });
});

describe("syncQuick: the files rung watch saw change, without listing the project", () => {
  const quick = (t: ReturnType<typeof setup>, paths: string[]) => t.withState((s) => syncQuick(t.root, t.bridge, s, { config: t.config, now: () => 5000 }, paths));

  it("imports an edited file, writes TIA Portal's version back and compiles it, with no listing and no export first", async () => {
    const t = setup((b) => b.add(A, { content: srcA }).add(B, { content: 'FUNCTION "Fx_B" : Void\nBEGIN\n  "Fx_A"();\nEND_FUNCTION\n' }));
    t.bridge.canon = (s) => s.replace(/:=  +/g, ":= ");
    await t.sync();
    const listings = t.bridge.known.length;
    const before = t.bridge.objects.get(A)!.entry.fingerprint;
    t.bridge.exportCalls = [];
    t.write(pA, srcA.replace("#y := 2;", "#y :=   20;"));
    const r = await quick(t, [pA]);
    expect(r).toMatchObject({ imported: 1, objects: [A] });
    expect(t.bridge.known.length).toBe(listings);
    // the revision of the last complete pass, which TIA Portal checks; the only export is the import's answer
    expect(t.bridge.imports[0]!.expected).toBe(before);
    expect(t.bridge.exportCalls).toEqual([A]);
    expect(t.read(pA)).toContain("#y := 20;");
    // the block that calls it is compiled with it
    expect(t.bridge.compileCalls.at(-1)).toEqual(expect.arrayContaining([A, B]));
    // and the next complete pass finds nothing to do
    const idle = await t.sync(6000);
    expect(idle.imported + idle.exported + idle.merged).toBe(0);
  });

  it("does nothing, and asks the bridge nothing, for rung's own write-back or a file that is no source", async () => {
    const t = setup();
    await t.sync();
    let asked = 0;
    const info = t.bridge.projectInfo.bind(t.bridge);
    t.bridge.projectInfo = async () => (asked++, info());
    t.write("plc/PLC_1/blocks/notes.txt", "x");
    t.write("plc/PLC_1/blocks/Fx_A.scl.conflict", "x");
    const r = await quick(t, [pA, "plc/PLC_1/blocks/notes.txt", "plc/PLC_1/blocks/Fx_A.scl.conflict", "plc/PLC_1/blocks/.Fx_A.scl.swp"]);
    expect(r).toMatchObject({ imported: 0, objects: [] });
    expect(asked).toBe(0);
  });

  it("leaves new, deleted and conflicted files, interrupted sends and stale objects to the complete pass", async () => {
    const t = setup((b) => b.add(A, { content: srcA }).add(B));
    await t.sync();
    const pB = "plc/PLC_1/blocks/Fx_B.scl";
    t.write("plc/PLC_1/blocks/Fx_New.scl", 'FUNCTION "Fx_New" : Void\nBEGIN\nEND_FUNCTION\n');
    expect(await quick(t, ["plc/PLC_1/blocks/Fx_New.scl"])).toBeNull();
    unlinkSync(t.f("plc/PLC_1/blocks/Fx_New.scl"));
    unlinkSync(t.f(pB));
    expect(await quick(t, [pB])).toBeNull();
    await t.sync(); // B is a pending delete now
    t.write(pB, "edited\n");
    expect(await quick(t, [pB])).toBeNull();
    // a stale state: TIA Portal refused the last send as stale, the next pass must merge
    await t.withState(async (s) => s.upsert({ ...s.get(A)!, tiaFingerprint: `stale:${s.get(A)!.tiaFingerprint}` }));
    t.write(pA, srcA.replace("#x := 1;", "#x := 10;"));
    expect(await quick(t, [pA])).toBeNull();
    expect(t.bridge.imports).toEqual([]);
  });

  it("an object changed in TIA Portal since the last listing is refused as stale and merged by the complete pass", async () => {
    const t = setup();
    await t.sync();
    t.bridge.edit(A, { ".scl": srcA.replace("#z := 3;", "#z := 30;") });
    t.write(pA, srcA.replace("#x := 1;", "#x := 10;"));
    expect(await quick(t, [pA])).toBeNull();
    const r = await t.sync(6000);
    expect(r.merged).toBe(1);
    const text = t.bridge.objects.get(A)!.files[".scl"]!;
    expect(text).toContain("#x := 10;");
    expect(text).toContain("#z := 30;");
    expect(t.read(pA)).toBe(text);
  });

  it("keeps what it did not look at in the diagnostics editors read: a conflict elsewhere stays", async () => {
    const t = setup((b) => b.add(A, { content: srcA }).add(B, { content: "b1\nb2\nb3\n" }));
    await t.sync();
    t.bridge.edit(B, { ".scl": "b1\nTIA\nb3\n" });
    t.write("plc/PLC_1/blocks/Fx_B.scl", "b1\nmine\nb3\n");
    await t.sync(6000);
    const saved = () => JSON.parse(readFileSync(join(t.root, ".rung", "diagnostics.json"), "utf8")).items as { address: string; code: string }[];
    expect(saved().some((d) => d.address === B && d.code === "CONFLICT")).toBe(true);
    t.write(pA, srcA.replace("#x := 1;", "#x := 10;"));
    expect(await quick(t, [pA])).toMatchObject({ imported: 1 });
    expect(saved().some((d) => d.address === B && d.code === "CONFLICT")).toBe(true);
  });
});

describe("compile scope after an import", () => {
  /** A bridge that, like rung's, tells what its compile during the import said. */
  class Telling extends TiaFake {
    override async importObject(address: string, form: string, path: string, expected: string, op = ""): Promise<ExportResult> {
      const r = await super.importObject(address, form, path, expected, op);
      return { ...r, compile: [{ address, severity: "warning", description: `compiled ${address.split("/").pop()} on import` }] };
    }
  }
  const caller = 'FUNCTION "Fx_B" : Void\nBEGIN\n  "Fx_A"();\nEND_FUNCTION\n';
  const make = () => {
    const t = setup((b) => b.add(A, { content: srcA }).add(B, { content: caller }));
    const telling = Object.assign(new Telling(), { objects: t.bridge.objects });
    return { ...t, bridge: telling, sync: (now = 1000) => t.withState((s) => syncOnce(t.root, telling, s, { config: t.config, now: () => now })) };
  };

  it("a body change compiles nothing more: the import's own compile answers for the block", async () => {
    const t = make();
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y := 20;"));
    const r = await t.sync(2000);
    expect(r.imported).toBe(1);
    expect(t.bridge.compileCalls).toEqual([]);
    expect(r.diagnostics).toEqual([expect.objectContaining({ address: A, code: "COMPILE", severity: "warning", message: "compiled Fx_A on import" })]);
  });

  it("a DB's start value changed: its users compile too, TIA Portal marks them inconsistent after any import of a DB", async () => {
    const D = "plc:PLC_1/blocks/Fx_Db";
    const db = 'DATA_BLOCK "Fx_Db"\nVERSION : 0.1\n   VAR\n      Max : Real;\n   END_VAR\nBEGIN\n   Max := 2700.0;\nEND_DATA_BLOCK\n';
    const user = 'FUNCTION "Fx_B" : Void\nBEGIN\n  "Fx_Db".Max := 1.0;\nEND_FUNCTION\n';
    const t = setup((b) => b.add(D, { form: "db", content: db }).add(B, { content: user }));
    const telling = Object.assign(new Telling(), { objects: t.bridge.objects });
    const sync = (now: number) => t.withState((s) => syncOnce(t.root, telling, s, { config: t.config, now: () => now }));
    await sync(1000);
    t.write("plc/PLC_1/blocks/Fx_Db.db", db.replace("2700.0", "2650.0"));
    const r = await sync(2000);
    expect(r.imported).toBe(1);
    expect(telling.compileCalls).toEqual([[B]]);
  });

  it("an interface change compiles the callers too, not the block a second time", async () => {
    const t = make();
    await t.sync();
    t.write(pA, srcA.replace("BEGIN", "VAR_INPUT\n  extra : Bool;\nEND_VAR\nBEGIN"));
    const r = await t.sync(2000);
    expect(r.imported).toBe(1);
    expect(t.bridge.compileCalls).toEqual([[B]]);
  });

  it("a parameter renamed in the block and its call in one pass: the caller's old text compiled by the first import is not reported", async () => {
    class Stale extends TiaFake {
      override async importObject(address: string, form: string, path: string, expected: string, op = ""): Promise<ExportResult> {
        const r = await super.importObject(address, form, path, expected, op);
        // TIA compiling Fx_A also compiles the caller's text it has then: the old call
        const compile = address === A ? [{ address: B, severity: "error" as const, description: "The formal parameter 'x' is invalid." }] : [{ address, severity: "info" as const, description: `compiled ${address.split("/").pop()} on import` }];
        return { ...r, compile };
      }
    }
    const t = setup((b) => b.add(A, { content: srcA }).add(B, { content: caller }));
    const stale = Object.assign(new Stale(), { objects: t.bridge.objects });
    const sync = (now: number) => t.withState((s) => syncOnce(t.root, stale, s, { config: t.config, now: () => now }));
    await sync(1000);
    t.write(pA, srcA.replace("BEGIN", "VAR_INPUT\n  y2 : Bool;\nEND_VAR\nBEGIN"));
    t.write("plc/PLC_1/blocks/Fx_B.scl", caller.replace('"Fx_A"()', '"Fx_A"(y2 := TRUE)'));
    const r = await sync(2000);
    expect(r.imported).toBe(2);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("a bridge that does not tell gets the compile of the block and its callers as before", async () => {
    const t = setup((b) => b.add(A, { content: srcA }).add(B, { content: caller }));
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y := 20;"));
    await t.sync(2000);
    expect(t.bridge.compileCalls).toEqual([[A, B]]);
  });
});

describe("preview: the next pass's plan, with nothing written", () => {
  it("lists what goes to TIA Portal and what comes back, with the lines, and changes nothing; the real pass then does just that", async () => {
    const pB = "plc/PLC_1/blocks/Fx_B.scl";
    const pC = "plc/PLC_1/blocks/Fx_C.scl";
    const t = setup((b) => b.add(A, { content: srcA }).add(B, { content: "b1\nb2\n" }).add("plc:PLC_1/blocks/Fx_C", { content: "c\n" }));
    await t.sync();
    t.write(pA, srcA.replace("#y := 2;", "#y := 20;"));
    t.bridge.edit(B, { ".scl": "b1\nb2 from TIA\n" });
    t.write("plc/PLC_1/blocks/Fx_New.scl", 'FUNCTION "Fx_New" : Void\nBEGIN\nEND_FUNCTION\n');
    unlinkSync(t.f(pC));
    const snapshot = () => [readdirSync(t.f("plc/PLC_1/blocks")).sort().join(","), t.read(pA), t.read(pB), readFileSync(t.f(".rung/state.json"), "utf8"), existsSync(t.f(".rung/diagnostics.json")) ? readFileSync(t.f(".rung/diagnostics.json"), "utf8") : ""];
    const before = snapshot();
    const r = await t.withState((s) => syncOnce(t.root, t.bridge, s, { config: t.config, now: () => 2000, preview: true }));
    const plan = r.plan!;
    const of = (path: string) => plan.entries.find((e) => e.path === path);
    expect(of(pA)).toMatchObject({ action: "update", before: srcA, after: srcA.replace("#y := 2;", "#y := 20;") });
    expect(of(pB)).toMatchObject({ action: "export", before: "b1\nb2\n", after: "b1\nb2 from TIA\n" });
    expect(of("plc/PLC_1/blocks/Fx_New.scl")).toMatchObject({ action: "create", before: "" });
    expect(of(pC)).toMatchObject({ action: "pending-delete" });
    expect(plan.compile).toEqual(expect.arrayContaining([A, "plc:PLC_1/blocks/Fx_New"]));
    expect(t.bridge.imports).toEqual([]);
    expect(t.bridge.compileCalls).toEqual([]);
    expect(snapshot()).toEqual(before);
    // the real pass does what the plan said
    const real = await t.sync(3000);
    expect(real).toMatchObject({ imported: 1, created: 1, exported: 1, pendingDeletes: 1 });
  });

  it("plans with writes off as if they were on, and shows a conflict without writing its file", async () => {
    const pB = "plc/PLC_1/blocks/Fx_B.scl";
    const t = setup((b) => b.add(A, { content: srcA }).add(B, { content: "b1\nb2\nb3\n" }), (c) => {
      c.sync.import = "manual";
      c.writesOff = true;
    });
    await t.sync();
    t.write(pA, srcA.replace("#x := 1;", "#x := 10;"));
    t.bridge.edit(B, { ".scl": "b1\nTIA\nb3\n" });
    t.write(pB, "b1\nmine\nb3\n");
    const r = await t.withState((s) => syncOnce(t.root, t.bridge, s, { config: t.config, now: () => 2000, preview: true }));
    expect(r.plan!.entries.map((e) => [e.path, e.action])).toEqual(expect.arrayContaining([[pA, "update"], [pB, "conflict"]]));
    expect(existsSync(t.f(pB + ".conflict"))).toBe(false);
    expect(t.bridge.imports).toEqual([]);
  });
});

describe("an archive before the first write of the day", () => {
  class Archiving extends TiaFake {
    archives: (string | undefined)[] = [];
    fail: string | undefined;
    async archive(dir?: string): Promise<{ path: string; bytes: number; savedFirst: boolean; removed: string[] }> {
      if (this.fail) throw new BridgeError("INTERNAL", this.fail);
      this.archives.push(dir);
      return { path: `C:\backups\RungFixture_${this.archives.length}.zap20`, bytes: 2048, savedFirst: false, removed: [] };
    }
  }
  const make = (cfg?: (c: RungConfig) => void) => {
    const t = setup(undefined, cfg);
    const b = Object.assign(new Archiving(), { objects: t.bridge.objects });
    return { ...t, bridge: b, sync: (now: number) => t.withState((s) => syncOnce(t.root, b, s, { config: t.config, now: () => now })) };
  };
  const day = (d: number, h = 9) => new Date(2026, 9, d, h).getTime();

  it("is made once a day, before the first import, and named in the report", async () => {
    const t = make();
    await t.sync(day(5));
    expect(t.bridge.archives).toEqual([]); // nothing written: no archive
    t.write(pA, srcA.replace("#x := 1;", "#x := 10;"));
    const first = await t.sync(day(5, 10));
    expect(first.imported).toBe(1);
    expect(first.backup).toEqual({ path: "C:\backups\RungFixture_1.zap20", bytes: 2048 });
    t.write(pA, srcA.replace("#x := 1;", "#x := 11;"));
    const again = await t.sync(day(5, 15));
    expect(again.imported).toBe(1);
    expect(again.backup).toBeUndefined();
    t.write(pA, srcA.replace("#x := 1;", "#x := 12;"));
    expect((await t.sync(day(6))).backup).toBeDefined();
    expect(t.bridge.archives.length).toBe(2);
  });

  it("without the archive nothing is written, and the next pass tries again", async () => {
    const t = make();
    await t.sync(day(5));
    t.bridge.fail = "the disk is full";
    t.write(pA, srcA.replace("#x := 1;", "#x := 10;"));
    const r = await t.sync(day(5, 10));
    expect(r.imported).toBe(0);
    expect(t.bridge.imports).toEqual([]);
    expect(r.diagnostics).toEqual([expect.objectContaining({ code: "BACKUP_FAILED", message: expect.stringContaining("the disk is full") })]);
    t.bridge.fail = undefined;
    const next = await t.sync(day(5, 11));
    expect(next.imported).toBe(1);
    expect(next.backup).toBeDefined();
  });

  it("goes where backupDir says, and not at all with sync.backup = off or in a preview", async () => {
    const t = make((c) => (c.sync.backupDir = "D:\rung-backups"));
    await t.sync(day(5));
    t.write(pA, srcA.replace("#x := 1;", "#x := 10;"));
    await t.withState((s) => syncOnce(t.root, t.bridge, s, { config: t.config, now: () => day(5, 10), preview: true }));
    expect(t.bridge.archives).toEqual([]);
    await t.sync(day(5, 10));
    expect(t.bridge.archives).toEqual(["D:\rung-backups"]);
    const off = make((c) => (c.sync.backup = "off"));
    await off.sync(day(5));
    off.write(pA, srcA.replace("#x := 1;", "#x := 10;"));
    expect((await off.sync(day(5, 10))).imported).toBe(1);
    expect(off.bridge.archives).toEqual([]);
  });
});
