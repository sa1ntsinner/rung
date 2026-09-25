// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, openSync, closeSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic, sha256, normalizeText, replaceGuarded, WorkspaceError } from "../src/index.js";

const dir = () => mkdtempSync(join(tmpdir(), "rung-atomic-"));

describe("normalizeText", () => {
  it("strips BOM, converts CRLF and ensures one trailing LF", () => {
    expect(normalizeText("﻿a\r\nb")).toBe("a\nb\n");
    expect(normalizeText("a\n")).toBe("a\n");
    expect(normalizeText("")).toBe("");
  });
});

describe("sha256", () => {
  it("hashes strings as UTF-8 and bytes as-is", () => {
    expect(sha256("Ü")).toBe(sha256(Buffer.from("Ü", "utf8")));
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("writeFileAtomic", () => {
  it("creates parents and publishes complete content", async () => {
    const d = dir();
    const p = join(d, "a", "b", "big.txt");
    const big = "x".repeat(5 * 1024 * 1024);
    await writeFileAtomic(p, big);
    expect(readFileSync(p, "utf8")).toBe(big);
    expect(readdirSync(join(d, "a", "b"))).toEqual(["big.txt"]);
  });
  it("replaces existing content", async () => {
    const d = dir();
    const p = join(d, "f.txt");
    writeFileSync(p, "old");
    await writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
  });
});

describe("replaceGuarded", () => {
  it("creates a missing file when absence is expected", async () => {
    const d = dir();
    const p = join(d, "x.scl");
    const r = await replaceGuarded(p, "A\n", { expectedHash: "absent", recoveryDir: join(d, "rec") });
    expect(readFileSync(p, "utf8")).toBe("A\n");
    expect(r.preimage).toBeUndefined();
  });

  it("refuses to overwrite a file that appeared unexpectedly", async () => {
    const d = dir();
    const p = join(d, "x.scl");
    writeFileSync(p, "user work");
    await expect(replaceGuarded(p, "A\n", { expectedHash: "absent", recoveryDir: join(d, "rec") })).rejects.toMatchObject({ code: "LOCAL_CHANGES" });
    expect(readFileSync(p, "utf8")).toBe("user work");
  });

  it("replaces when the current content matches and keeps the preimage", async () => {
    const d = dir();
    const p = join(d, "x.scl");
    writeFileSync(p, "old\n");
    const r = await replaceGuarded(p, "new\n", { expectedHash: sha256("old\n"), recoveryDir: join(d, "rec") });
    expect(readFileSync(p, "utf8")).toBe("new\n");
    expect(r.preimage && readFileSync(r.preimage, "utf8")).toBe("old\n");
  });

  it("preserves a local edit instead of overwriting it", async () => {
    const d = dir();
    const p = join(d, "x.scl");
    writeFileSync(p, "edited by user\n");
    await expect(replaceGuarded(p, "new\n", { expectedHash: sha256("old\n"), recoveryDir: join(d, "rec") })).rejects.toBeInstanceOf(WorkspaceError);
    expect(readFileSync(p, "utf8")).toBe("edited by user\n");
  });

  it("force mode snapshots the local edit and then replaces", async () => {
    const d = dir();
    const p = join(d, "x.scl");
    writeFileSync(p, "edited by user\n");
    const r = await replaceGuarded(p, "new\n", { expectedHash: sha256("old\n"), recoveryDir: join(d, "rec"), force: true });
    expect(readFileSync(p, "utf8")).toBe("new\n");
    expect(readFileSync(r.preimage!, "utf8")).toBe("edited by user\n");
  });

  it("keeps late writes through a handle opened before the swap", async () => {
    const d = dir();
    const p = join(d, "x.scl");
    writeFileSync(p, "old\n");
    const fd = openSync(p, "r+");
    const r = await replaceGuarded(p, "new\n", { expectedHash: sha256("old\n"), recoveryDir: join(d, "rec") });
    writeSync(fd, "LATE", 0);
    closeSync(fd);
    expect(readFileSync(p, "utf8")).toBe("new\n");
    // the late write landed in the retained preimage, not in the published file, and is not lost
    expect(readFileSync(r.preimage!, "utf8").startsWith("LATE")).toBe(true);
    expect(existsSync(r.preimage!)).toBe(true);
  });
});
