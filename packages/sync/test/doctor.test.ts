// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError, type ExportResult } from "@rung/bridge-client";
import { doctor, summarize } from "../src/index.js";
import { FakeBridge } from "./fake-bridge.js";

/** Fake whose import rewrites text the way TIA might (keyword casing, header normalization). */
class ImportingFake extends FakeBridge {
  transform: (s: string, round: number) => string = (s) => s;
  failImport = new Set<string>();
  imports: { address: string; expected: string }[] = [];
  private rounds = new Map<string, number>();
  async importObject(address: string, _form: string, path: string, expected: string): Promise<ExportResult> {
    this.imports.push({ address, expected });
    if (this.failImport.has(address)) throw new BridgeError("IMPORT_FAILED", "compile error in source");
    const o = this.objects.get(address)!;
    const round = (this.rounds.get(address) ?? 0) + 1;
    this.rounds.set(address, round);
    const text = readFileSync(path, "utf8");
    this.edit(address, { ["." + o.form]: this.transform(text, round) });
    return { address, form: o.form, files: [], warnings: [], fingerprint: o.entry.fingerprint, bundleHash: "" };
  }
}

const root = () => mkdtempSync(join(tmpdir(), "rung-doctor-"));

describe("doctor", () => {
  it("reports a fixed point on the first pass", async () => {
    const b = new ImportingFake();
    b.add("plc:PLC_1/blocks/A", { content: "a := 1;\n" });
    const rows = await doctor(root(), b);
    expect(rows).toEqual([{ address: "plc:PLC_1/blocks/A", form: "scl", pass1Equal: true, pass2Equal: true }]);
  });

  it("detects normalization that converges on the second pass", async () => {
    const b = new ImportingFake();
    b.add("plc:PLC_1/blocks/A", { content: "if x then y := 1; end_if;\n" });
    b.transform = (s) => s.replace(/\bif\b/g, "IF").replace(/\bthen\b/g, "THEN").replace(/\bend_if\b/g, "END_IF");
    const [row] = await doctor(root(), b);
    expect(row).toMatchObject({ pass1Equal: false, pass2Equal: true });
    expect(row!.diffSample).toContain("IF");
  });

  it("detects forms that never converge", async () => {
    const b = new ImportingFake();
    b.add("plc:PLC_1/blocks/A", { content: "x\n" });
    b.transform = (s, round) => s + `// round ${round}\n`;
    const [row] = await doctor(root(), b);
    expect(row).toMatchObject({ pass1Equal: false, pass2Equal: false });
  });

  it("passes the exact exported revision as the optimistic-concurrency token", async () => {
    const b = new ImportingFake();
    b.add("plc:PLC_1/blocks/A", { content: "x\n" });
    const fp = b.objects.get("plc:PLC_1/blocks/A")!.entry.fingerprint;
    await doctor(root(), b);
    expect(b.imports[0]!.expected).toBe(fp);
  });

  it("records errors per row and keeps going; skips read-only objects without importing", async () => {
    const b = new ImportingFake();
    b.add("plc:PLC_1/blocks/Bad", { content: "x\n" });
    b.add("plc:PLC_1/blocks/Good", { content: "y\n" });
    b.add("plc:PLC_1/blocks/Secret", { form: "protected.yaml", knowHowProtected: true, content: "r\n" });
    b.failImport.add("plc:PLC_1/blocks/Bad");
    const rows = await doctor(root(), b);
    expect(rows.find((r) => r.address.endsWith("/Bad"))!.error).toMatch(/IMPORT_FAILED/);
    expect(rows.find((r) => r.address.endsWith("/Good"))!.pass2Equal).toBe(true);
    expect(rows.find((r) => r.address.endsWith("/Secret"))!.skipped).toBe("read-only");
    expect(b.imports.map((i) => i.address)).not.toContain("plc:PLC_1/blocks/Secret");
  });

  it("summarizes per form and counts errors as failures", async () => {
    const s = summarize([
      { address: "a", form: "scl", pass1Equal: true, pass2Equal: true },
      { address: "b", form: "scl", pass1Equal: false, pass2Equal: true },
      { address: "c", form: "xml", pass1Equal: false, pass2Equal: false },
      { address: "d", form: "xml", pass1Equal: false, pass2Equal: false, error: "IMPORT_FAILED" },
    ]);
    expect(s).toEqual({ scl: { pass1: 1, pass2: 1, never: 0, errors: 0 }, xml: { pass1: 0, pass2: 0, never: 1, errors: 1 } });
  });
});
