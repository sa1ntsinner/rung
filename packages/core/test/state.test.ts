// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { StateStore, type ObjectState, type Binding } from "../src/index.js";

const binding: Binding = { projectPath: "C:\\fx\\RungFixture.ap20", tiaVersion: "V20", devices: ["PLC_1"] };
const root = () => mkdtempSync(join(tmpdir(), "rung-state-"));
const obj = (address: string, path: string): ObjectState => ({
  address,
  path,
  form: "scl",
  fileHash: "h1",
  files: [{ path, role: "primary", hash: "f1" }],
  tiaFingerprint: "fp:1",
  baseId: "b1",
  readOnly: false,
  warnings: [],
  status: "synced",
});

describe("StateStore", () => {
  it("round-trips objects and indexes by path", async () => {
    const r = root();
    const s = await StateStore.open(r, binding);
    s.upsert(obj("plc:P/blocks/A", "plc/P/blocks/A.scl"));
    expect(s.get("plc:P/blocks/A")?.path).toBe("plc/P/blocks/A.scl");
    expect(s.byPath("plc/P/blocks/A.scl")?.address).toBe("plc:P/blocks/A");
    s.upsert({ ...obj("plc:P/blocks/A", "plc/P/blocks/Moved.scl") });
    expect(s.byPath("plc/P/blocks/A.scl")).toBeUndefined();
    expect(s.byPath("plc/P/blocks/Moved.scl")?.address).toBe("plc:P/blocks/A");
    s.remove("plc:P/blocks/A");
    expect(s.all()).toEqual([]);
    await s.close();
  });

  it("returned records cannot mutate the store", async () => {
    const s = await StateStore.open(root(), binding);
    s.upsert(obj("plc:P/blocks/A", "plc/P/blocks/A.scl"));
    s.get("plc:P/blocks/A")!.files.push({ path: "x", role: "y", hash: "z" });
    expect(s.get("plc:P/blocks/A")!.files).toHaveLength(1);
    await s.close();
  });

  it("rolls back a failed transaction deeply", async () => {
    const s = await StateStore.open(root(), binding);
    s.upsert(obj("plc:P/blocks/A", "plc/P/blocks/A.scl"));
    expect(() =>
      s.transaction(() => {
        s.upsert({ ...obj("plc:P/blocks/A", "plc/P/blocks/A.scl"), status: "conflicted" });
        s.upsert(obj("plc:P/blocks/B", "plc/P/blocks/B.scl"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.get("plc:P/blocks/A")!.status).toBe("synced");
    expect(s.get("plc:P/blocks/B")).toBeUndefined();
    expect(s.byPath("plc/P/blocks/B.scl")).toBeUndefined();
    await s.close();
  });

  it("persists deterministically and reopens", async () => {
    const r = root();
    const s = await StateStore.open(r, binding);
    s.upsert(obj("plc:P/blocks/B", "plc/P/blocks/B.scl"));
    s.upsert(obj("plc:P/blocks/A", "plc/P/blocks/A.scl"));
    await s.close();
    const first = readFileSync(join(r, ".rung", "state.json"), "utf8");
    const s2 = await StateStore.open(r, binding);
    expect(s2.all().map((o) => o.address)).toEqual(["plc:P/blocks/A", "plc:P/blocks/B"]);
    await s2.flush(true);
    await s2.close();
    expect(readFileSync(join(r, ".rung", "state.json"), "utf8")).toBe(first);
  });

  it("rejects a second writer with STATE_LOCKED", async () => {
    const r = root();
    const s = await StateStore.open(r, binding);
    await expect(StateStore.open(r, binding)).rejects.toMatchObject({ code: "STATE_LOCKED" });
    await s.close();
    const again = await StateStore.open(r, binding);
    await again.close();
  });

  it("recovers a stale lock from a dead process on this host", async () => {
    const r = root();
    const s = await StateStore.open(r, binding);
    await s.close();
    writeFileSync(join(r, ".rung", "lock"), JSON.stringify({ host: hostname(), pid: 999999, nonce: "dead" }));
    const s2 = await StateStore.open(r, binding);
    expect(JSON.parse(readFileSync(join(r, ".rung", "lock"), "utf8")).pid).toBe(process.pid);
    await s2.close();
    expect(existsSync(join(r, ".rung", "lock"))).toBe(false);
  });

  it("never reaps a lock owned by another host", async () => {
    const r = root();
    const s = await StateStore.open(r, binding);
    await s.close();
    writeFileSync(join(r, ".rung", "lock"), JSON.stringify({ host: "some-other-machine", pid: 1, nonce: "x" }));
    await expect(StateStore.open(r, binding)).rejects.toMatchObject({ code: "STATE_LOCKED" });
  });

  it("detects a workspace bound to another project", async () => {
    const r = root();
    const s = await StateStore.open(r, binding);
    await s.close();
    await expect(StateStore.open(r, { ...binding, projectPath: "C:\\other\\X.ap20" })).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
  });

  it("refuses unknown state formats", async () => {
    const r = root();
    const s = await StateStore.open(r, binding);
    await s.close();
    writeFileSync(join(r, ".rung", "state.json"), JSON.stringify({ format: 99, objects: {} }));
    await expect(StateStore.open(r, binding)).rejects.toMatchObject({ code: "STATE_FORMAT" });
  });
});
