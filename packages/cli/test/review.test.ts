// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { main } from "../src/main.js";

describe("rung review", () => {
  it("renders working tree changes as Markdown or JSON and accepts a revision range", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-review-cli-"));
    mkdirSync(join(root, "blocks"));
    const file = join(root, "blocks", "FB_Batch.scl");
    writeFileSync(file, 'FUNCTION_BLOCK "FB_Batch"\nBEGIN\n ;\nEND_FUNCTION_BLOCK\n');
    const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", ...args], { windowsHide: true, encoding: "utf8" });
    git("init", "-q"); git("add", "."); git("commit", "-qm", "fixture");
    writeFileSync(file, 'FUNCTION_BLOCK "FB_Batch"\nBEGIN\n #Done := TRUE;\nEND_FUNCTION_BLOCK\n');
    const out: string[] = []; const err: string[] = [];
    const io = { cwd: root, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s), env: {} };
    expect(await main(["review", "--md"], io), err.join("")).toBe(0);
    expect(out.join("")).toContain("rung change review");
    out.length = 0;
    expect(await main(["review", "--json"], io), err.join("")).toBe(0);
    expect(JSON.parse(out.join("")).blocks[0]).toMatchObject({ name: "FB_Batch", change: "modified" });
    out.length = 0;
    expect(await main(["review", "HEAD..HEAD", "--json"], io), err.join("")).toBe(0);
    expect(JSON.parse(out.join("")).blocks).toEqual([]);
  });
});
