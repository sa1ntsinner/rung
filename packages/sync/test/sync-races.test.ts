// SPDX-License-Identifier: BUSL-1.1
// A person saving while rung merges TIA Portal's change with writes off; a compile of callers TIA Portal refused.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, StateStore, defaultConfig } from "@rung/core";
import { BridgeError, type ExportResult } from "@rung/bridge-client";
import { syncOnce, recordCompile } from "../src/index.js";
import { FakeBridge } from "./fake-bridge.js";

class RacingBridge extends FakeBridge {
  compileError = false;
  async importObject(address: string, form: string, file: string): Promise<ExportResult> {
    this.edit(address, { ["." + form]: readFileSync(file, "utf8") });
    return { ...await this.exportObject(address, "auto", mkdtempSync(join(tmpdir(), "rung-edges-export-"))), compile: [] };
  }
  async compile(_device: string, _addresses: string[] = []) {
    if (this.compileError) throw new BridgeError("COMPILE_FAILED", "Compiler unavailable");
    return [];
  }
}
const A = "plc:PLC_1/blocks/A";
const B = "plc:PLC_1/blocks/B";
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rung-edges-sync-"));
  const bridge = new RacingBridge();
  const config = defaultConfig(bridge.info.path, "V20", "fake");
  config.sync.backup = "off";
  const state = await StateStore.open(root, { projectPath: config.project.path, tiaVersion: "V20", devices: [] });
  return { root, bridge, config, state };
}

describe("a save during a writes-off merge; a compile TIA Portal refused", () => {
  it("preserves a newer save while merging TIA changes with writes off", async () => {
    const t = await fixture();
    const config = { ...t.config, writesOff: true as const, sync: { ...t.config.sync, import: "manual" as const } };
    const src = 'FUNCTION "A" : Void\nBEGIN\n #x := 1;\n #y := 2;\n #z := 3;\n #w := 4;\nEND_FUNCTION\n';
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      t.bridge.add(A, { content: src });
      await syncOnce(t.root, t.bridge, t.state, { config });
      const file = join(t.root, "plc/PLC_1/blocks/A.scl");
      writeFileSync(file, src.replace("#x := 1", "#x := 10"));
      t.bridge.edit(A, { ".scl": src.replace("#w := 4", "#w := 40") });
      const oldHash = t.state.get(A)!.files[0]!.hash;
      const get = BlobStore.prototype.get;
      let saved = false;
      spy = vi.spyOn(BlobStore.prototype, "get").mockImplementation(async function (hash) {
        const data = await get.call(this, hash);
        // baseBundle is read after localBundle captured x=10: simulate the engineer saving x=100 now.
        if (!saved && hash === oldHash) {
          saved = true;
          writeFileSync(file, src.replace("#x := 1", "#x := 100"));
        }
        return data;
      });
      const report = await syncOnce(t.root, t.bridge, t.state, { config });
      expect(saved).toBe(true);
      expect(report.conflicts).toBe(0);
      expect(readFileSync(file, "utf8")).toContain("#x := 100;");
    } finally { spy?.mockRestore(); await t.state.close(); }
  });

  it("retains a caller's previous compile error when recompiling it fails", async () => {
    const t = await fixture();
    const db = 'DATA_BLOCK "A"\nVAR\n N : Int;\nEND_VAR\nBEGIN\n N := 0;\nEND_DATA_BLOCK\n';
    try {
      t.bridge.add(A, { form: "db", blockType: "DB", content: db });
      t.bridge.add(B, { content: 'FUNCTION "B" : Void\nBEGIN\n #x := "A".N;\nEND_FUNCTION\n' });
      await syncOnce(t.root, t.bridge, t.state, { config: t.config });
      await recordCompile(t.root, "PLC_1", [B], [{ address: B, severity: "error", description: "Unknown instruction" }], a => t.state.get(a)?.tiaFingerprint, a => t.state.get(a)?.fileHash);
      writeFileSync(join(t.root, "plc/PLC_1/blocks/A.db"), db.replace("N := 0", "N := 1"));
      t.bridge.compileError = true;
      const report = await syncOnce(t.root, t.bridge, t.state, { config: t.config });
      expect(report.warnings.some(w => w.code === "COMPILE_FAILED")).toBe(true);
      const items = JSON.parse(readFileSync(join(t.root, ".rung/diagnostics.json"), "utf8")).items;
      expect(items.some((d: { address: string; code: string }) => d.address === B && d.code === "COMPILE")).toBe(true);
    } finally { await t.state.close(); }
  });
});
