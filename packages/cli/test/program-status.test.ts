// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BridgeClient } from "@rung/bridge-client";
import { WorkspaceIndex } from "@rung/lsp";
import { reconstructionRevision } from "@rung/sim";
import { main } from "../src/main.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rung-status-"));
  const blocks = join(root, "plc", "P", "blocks"); mkdirSync(blocks, { recursive: true });
  writeFileSync(join(root, "rung.toml"), "format = 1\n");
  const file = join(blocks, "Counter.scl");
  writeFileSync(file, 'FUNCTION_BLOCK "Counter"\nVAR_OUTPUT\n Count : Int;\nEND_VAR\nBEGIN\n #Count := #Count + 1;\nEND_FUNCTION_BLOCK');
  writeFileSync(join(blocks, "Counter_DB.db"), 'DATA_BLOCK "Counter_DB"\n"Counter"\nBEGIN\nEND_DATA_BLOCK');
  const index = new WorkspaceIndex(); await index.load(root);
  const capture = { scope: { plc: "P", instance: '"Counter_DB"', epoch: 1 }, sourceRevision: reconstructionRevision(index, pathToFileURL(file).href),
    time: 10, clockStart: 0, coherence: "controlled-cycle", before: { mem: { COUNT: 4 }, globals: {} }, observed: { COUNT: 5 } };
  const captureFile = join(root, "capture.json"); writeFileSync(captureFile, JSON.stringify(capture));
  const out: string[] = [], err: string[] = [];
  const io = { cwd: root, env: {}, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
  const argv = ["program-status", file, "--capture", captureFile, "--instance", "Counter_DB", "--json"];
  return { root, file, captureFile, capture, out, err, io, argv };
}

afterEach(() => vi.restoreAllMocks());
describe("offline captured program status CLI", () => {
  it("explains a captured write without opening a live reader", async () => {
    const f = await fixture();
    const spawn = vi.spyOn(BridgeClient, "spawn").mockRejectedValue(new Error("must remain offline"));
    expect(await main([...f.argv, "--why", "#Count"], f.io)).toBe(0);
    const result = JSON.parse(f.out.join(""));
    expect(result.why).toMatchObject({ kind: "value", value: "5", children: [{ kind: "write", at: { line: 6 } }, { kind: "note" }] });
    expect(spawn).not.toHaveBeenCalled();
  });
  it("replays JSON without opening a bridge or changing source/capture files", async () => {
    const f = await fixture(); const before = readFileSync(f.captureFile, "utf8");
    const spawn = vi.spyOn(BridgeClient, "spawn").mockRejectedValue(new Error("must remain offline"));
    expect(await main(f.argv, f.io)).toBe(0);
    const result = JSON.parse(f.out.join(""));
    expect(result.after.COUNT).toBe(5); expect(result.exact).toBe(false);
    expect(result.freshness).toBe("capture-only"); expect(result.divergences).toEqual([]);
    expect(spawn).not.toHaveBeenCalled(); expect(readFileSync(f.captureFile, "utf8")).toBe(before);
  });
  it("returns divergence separately from unavailable reconstruction", async () => {
    const f = await fixture(); f.capture.observed.COUNT = 7; writeFileSync(f.captureFile, JSON.stringify(f.capture));
    expect(await main(f.argv, f.io)).toBe(2);
    expect(JSON.parse(f.out.join("")).divergences).toEqual([{ path: "COUNT", reconstructed: 5, observed: 7 }]);
  });
  it("rejects changed source, a wrong instance and incomplete pre-state with JSON reasons", async () => {
    const f = await fixture();
    writeFileSync(f.file, readFileSync(f.file, "utf8").replace("+ 1", "+ 2"));
    expect(await main(f.argv, f.io)).toBe(1);
    expect(JSON.parse(f.out.join("")).reason).toMatch(/source/i);
    f.out.length = 0;
    expect(await main(f.argv.map(a => a === "Counter_DB" ? "Other_DB" : a), f.io)).toBe(1);
    expect(JSON.parse(f.out.join("")).reason).toMatch(/instance/i);
    f.out.length = 0;
    writeFileSync(f.captureFile, JSON.stringify({ ...f.capture, before: {} }));
    expect(await main(f.argv, f.io)).toBe(1); expect(JSON.parse(f.out.join("")).kind).toBe("unavailable");
  });
  it("refuses oversized captures and documents the capture option", async () => {
    const f = await fixture(); writeFileSync(f.captureFile, " ".repeat(1_048_577));
    expect(await main(f.argv, f.io)).toBe(1);
    expect(JSON.parse(f.out.join("")).reason).toMatch(/capture.*limit/i);
    f.out.length = 0;
    expect(await main(["program-status", "--help"], f.io)).toBe(0);
    expect(f.out.join("")).toContain("--capture");
  });
});
