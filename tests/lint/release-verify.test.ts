// SPDX-License-Identifier: MIT
// tools/release/verify.mjs, which the GitHub Action runs on the rung.cjs it downloads.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const verify = fileURLToPath(new URL("../../tools/release/verify.mjs", import.meta.url));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function release(files: Record<string, string>, sums: string) {
  const dir = mkdtempSync(join(tmpdir(), "rung-release-"));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  writeFileSync(join(dir, "SHA256SUMS.txt"), sums);
  return (...names: string[]) => spawnSync(process.execPath, [verify, dir, ...names], { encoding: "utf8" });
}

describe("release checksums", () => {
  it("passes a file whose line matches, in sha256sum's text and binary forms", () => {
    const run = release({ "rung.cjs": "cli", "rung.exe": "exe" }, `${sha("x")}  rung-1.0.0-win-x64.zip\n${sha("cli")}  rung.cjs\r\n${sha("exe")} *rung.exe\n`);
    const r = run("rung.cjs", "rung.exe");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("stops on a changed file and on one the list does not have", () => {
    const run = release({ "rung.cjs": "changed", "other.js": "x" }, `${sha("cli")}  rung.cjs\n`);
    expect(run("rung.cjs")).toMatchObject({ status: 1, stderr: expect.stringContaining("rung.cjs: sha256 ") });
    expect(run("other.js")).toMatchObject({ status: 1, stderr: "other.js: not in SHA256SUMS.txt\n" });
  });
});
