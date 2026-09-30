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

  it("recovers a crash after the old file was moved aside but before the new one landed", async () => {
    const root = ws();
    const blobs = new BlobStore(root);
    mkdirSync(join(root, "plc/P/blocks"), { recursive: true });
    const oldHash = sha256("old\n");
    const newHash = await blobs.put("new\n");
    const intent = {
      opId: "gap",
      address: "plc:P/blocks/A",
      targets: [{ path: "plc/P/blocks/A.scl", hash: newHash, prevHash: oldHash }],
      removes: [],
      nextState: next("plc:P/blocks/A", "plc/P/blocks/A.scl", newHash),
    };
    await new Journal(root).write(intent);
    // simulate: replaceGuarded moved the old file into recovery, then the process died
    mkdirSync(join(root, ".rung", "recovery", "gap"), { recursive: true });
    writeFileSync(join(root, ".rung", "recovery", "gap", "1-x-A.scl"), "old\n");
    const r = await recoverJournal(root);
    expect(r).toEqual({ completed: [intent.nextState], recoveryRequired: [], dropped: [] });
    expect(readFileSync(join(root, "plc/P/blocks/A.scl"), "utf8")).toBe("new\n");
  });

  it("keeps the journal entry when asked, so state can be flushed first", async () => {
    const root = ws();
    const h = await new BlobStore(root).put("x\n");
    await publishBundle(root, { opId: "keep", address: "plc:P/blocks/K", targets: [{ path: "plc/P/blocks/K.scl", hash: h, prevHash: "absent" }], removes: [], nextState: next("plc:P/blocks/K", "plc/P/blocks/K.scl", h) }, { keepJournal: true });
    expect((await new Journal(root).pending()).map((i) => i.opId)).toEqual(["keep"]);
    const r = await recoverJournal(root);
    expect(r.completed).toHaveLength(1);
  });

  it("does not trash the new file on a case-only rename", async () => {
    const root = ws();
    mkdirSync(join(root, "plc/P/blocks"), { recursive: true });
    writeFileSync(join(root, "plc/P/blocks/Motor.scl"), "m\n");
    const h = await new BlobStore(root).put("m\n");
    await publishBundle(root, {
      opId: "case",
      address: "plc:P/blocks/MOTOR",
      targets: [{ path: "plc/P/blocks/MOTOR.scl", hash: h, prevHash: process.platform === "linux" ? "absent" : sha256("m\n") }],
      removes: [{ path: "plc/P/blocks/Motor.scl", prevHash: sha256("m\n") }],
      nextState: next("plc:P/blocks/MOTOR", "plc/P/blocks/MOTOR.scl", h),
    });
    expect(readFileSync(join(root, "plc/P/blocks/MOTOR.scl"), "utf8")).toBe("m\n");
  });

  it("drops a write-back whose file was edited since: the edit stays, the state is not moved on", async () => {
    const root = ws();
    await crashedIntent(root, false);
    mkdirSync(join(root, "plc/P/blocks"), { recursive: true });
    writeFileSync(join(root, "plc/P/blocks/L.s7res"), "someone else\n");
    const r = await recoverJournal(root);
    expect(r).toEqual({ completed: [], recoveryRequired: [], dropped: ["plc:P/blocks/L"] });
    expect(readFileSync(join(root, "plc/P/blocks/L.s7res"), "utf8")).toBe("someone else\n");
    expect(existsSync(join(root, "plc/P/blocks/L.s7dcl"))).toBe(false);
    expect(readdirSync(join(root, ".rung", "journal"))).toHaveLength(0);
  });

  it("drops a write-back whose file to remove was edited since, and keeps that file", async () => {
    const root = ws();
    const h = await new BlobStore(root).put("new\n");
    mkdirSync(join(root, "plc/P/blocks"), { recursive: true });
    writeFileSync(join(root, "plc/P/blocks/B.scl"), "old\n");
    writeFileSync(join(root, "plc/P/blocks/B.s7res"), "edited\n");
    await new Journal(root).write({
      opId: "rm",
      address: "plc:P/blocks/B",
      targets: [{ path: "plc/P/blocks/B.scl", hash: h, prevHash: sha256("old\n") }],
      removes: [{ path: "plc/P/blocks/B.s7res", prevHash: sha256("res\n") }],
      nextState: next("plc:P/blocks/B", "plc/P/blocks/B.scl", h),
    });
    const r = await recoverJournal(root);
    expect(r).toEqual({ completed: [], recoveryRequired: [], dropped: ["plc:P/blocks/B"] });
    expect(readFileSync(join(root, "plc/P/blocks/B.s7res"), "utf8")).toBe("edited\n");
  });

  it("puts back a file the dropped write-back had moved aside", async () => {
    const root = ws();
    const blobs = new BlobStore(root);
    mkdirSync(join(root, "plc/P/blocks"), { recursive: true });
    const a = await blobs.put("new a\n");
    const b = await blobs.put("new b\n");
    await new Journal(root).write({
      opId: "both",
      address: "plc:P/blocks/A",
      targets: [
        { path: "plc/P/blocks/A.s7dcl", hash: a, prevHash: sha256("old a\n") },
        { path: "plc/P/blocks/A.s7res", hash: b, prevHash: sha256("old b\n") },
      ],
      removes: [],
      nextState: next("plc:P/blocks/A", "plc/P/blocks/A.s7dcl", a),
    });
    mkdirSync(join(root, ".rung", "recovery", "both"), { recursive: true });
    writeFileSync(join(root, ".rung", "recovery", "both", "1-x-A.s7dcl"), "old a\n"); // moved aside, then killed
    writeFileSync(join(root, "plc/P/blocks/A.s7res"), "edited b\n");
    const r = await recoverJournal(root);
    expect(r.dropped).toEqual(["plc:P/blocks/A"]);
    expect([readFileSync(join(root, "plc/P/blocks/A.s7dcl"), "utf8"), readFileSync(join(root, "plc/P/blocks/A.s7res"), "utf8")]).toEqual(["old a\n", "edited b\n"]);
  });
});
