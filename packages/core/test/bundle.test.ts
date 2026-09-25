// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, Journal, publishBundle, recoverJournal, bundleHash, sha256, type ObjectState } from "../src/index.js";

const ws = () => mkdtempSync(join(tmpdir(), "rung-bundle-"));
const next = (address: string, path: string, hash: string): ObjectState => ({
  address, path, form: "s7dcl", fileHash: "x", files: [{ path, role: "primary", hash }], tiaFingerprint: "fp:2",
  baseId: "b", readOnly: false, warnings: [], status: "synced",
});

describe("BlobStore", () => {
  it("is content addressed and immutable", async () => {
    const b = new BlobStore(ws());
    const h = await b.put("hello\n");
    expect(h).toBe(sha256("hello\n"));
    expect(await b.put("hello\n")).toBe(h);
    expect((await b.get(h)).toString("utf8")).toBe("hello\n");
  });
});

describe("bundleHash", () => {
  it("depends on roles and hashes only", () => {
    expect(bundleHash([{ role: "primary", hash: "a" }, { role: "res", hash: "b" }])).toBe(bundleHash([{ role: "res", hash: "b" }, { role: "primary", hash: "a" }]));
    expect(bundleHash([{ role: "primary", hash: "a" }])).not.toBe(bundleHash([{ role: "primary", hash: "b" }]));
  });
});

describe("publishBundle", () => {
  it("publishes primary and companions and removes obsolete companions", async () => {
    const root = ws();
    mkdirSync(join(root, "plc/P/blocks"), { recursive: true });
    writeFileSync(join(root, "plc/P/blocks/L.old.s7res"), "old res\n");
    const blobs = new BlobStore(root);
    const h1 = await blobs.put("dcl\n");
    const h2 = await blobs.put("res\n");
    const done = await publishBundle(root, {
      opId: "op1",
      address: "plc:P/blocks/L",
      targets: [
        { path: "plc/P/blocks/L.s7dcl", hash: h1, prevHash: "absent" },
        { path: "plc/P/blocks/L.s7res", hash: h2, prevHash: "absent" },
      ],
      removes: [{ path: "plc/P/blocks/L.old.s7res", prevHash: sha256("old res\n") }],
      nextState: next("plc:P/blocks/L", "plc/P/blocks/L.s7dcl", h1),
    });
    expect(done.nextState.address).toBe("plc:P/blocks/L");
    expect(readFileSync(join(root, "plc/P/blocks/L.s7dcl"), "utf8")).toBe("dcl\n");
    expect(readFileSync(join(root, "plc/P/blocks/L.s7res"), "utf8")).toBe("res\n");
    expect(existsSync(join(root, "plc/P/blocks/L.old.s7res"))).toBe(false);
    expect(await new Journal(root).pending()).toEqual([]);
  });

  it("refuses before writing anything when any target has local changes", async () => {
    const root = ws();
    mkdirSync(join(root, "plc/P/blocks"), { recursive: true });
    writeFileSync(join(root, "plc/P/blocks/L.s7res"), "user edit\n");
    const blobs = new BlobStore(root);
    const h1 = await blobs.put("dcl\n");
    const h2 = await blobs.put("res\n");
    await expect(
      publishBundle(root, {
        opId: "op2",
        address: "plc:P/blocks/L",
        targets: [
          { path: "plc/P/blocks/L.s7dcl", hash: h1, prevHash: "absent" },
          { path: "plc/P/blocks/L.s7res", hash: h2, prevHash: sha256("tia res\n") },
        ],
        removes: [],
        nextState: next("plc:P/blocks/L", "plc/P/blocks/L.s7dcl", h1),
      }),
    ).rejects.toMatchObject({ code: "LOCAL_CHANGES" });
    expect(existsSync(join(root, "plc/P/blocks/L.s7dcl"))).toBe(false);
    expect(readFileSync(join(root, "plc/P/blocks/L.s7res"), "utf8")).toBe("user edit\n");
  });
});

describe("recoverJournal", () => {
  async function crashedIntent(root: string, publishFirst: boolean) {
    const blobs = new BlobStore(root);
    const h1 = await blobs.put("dcl\n");
    const h2 = await blobs.put("res\n");
    const intent = {
      opId: "crash",
      address: "plc:P/blocks/L",
      targets: [
        { path: "plc/P/blocks/L.s7dcl", hash: h1, prevHash: "absent" as const },
        { path: "plc/P/blocks/L.s7res", hash: h2, prevHash: "absent" as const },
      ],
      removes: [],
      nextState: next("plc:P/blocks/L", "plc/P/blocks/L.s7dcl", h1),
    };
    await new Journal(root).write(intent);
    if (publishFirst) {
      mkdirSync(join(root, "plc/P/blocks"), { recursive: true });
      writeFileSync(join(root, "plc/P/blocks/L.s7dcl"), "dcl\n"); // crashed after the first file
    }
    return intent;
  }

  it("rolls a half-published bundle forward", async () => {
    const root = ws();
    await crashedIntent(root, true);
    const r = await recoverJournal(root);
    expect(r.completed.map((c) => c.address)).toEqual(["plc:P/blocks/L"]);
    expect(readFileSync(join(root, "plc/P/blocks/L.s7res"), "utf8")).toBe("res\n");
    expect(await new Journal(root).pending()).toEqual([]);
  });

  it("flags recovery when a target has foreign content, keeping the journal", async () => {
    const root = ws();
    await crashedIntent(root, false);
    mkdirSync(join(root, "plc/P/blocks"), { recursive: true });
    writeFileSync(join(root, "plc/P/blocks/L.s7res"), "someone else\n");
    const r = await recoverJournal(root);
    expect(r.recoveryRequired).toEqual(["plc:P/blocks/L"]);
    expect(readFileSync(join(root, "plc/P/blocks/L.s7res"), "utf8")).toBe("someone else\n");
    expect(readdirSync(join(root, ".rung", "journal"))).toHaveLength(1);
  });
});
