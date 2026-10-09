// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
const fb = (statics: string) => `FUNCTION_BLOCK "FB"\nVERSION : 0.1\n   VAR \n      a : Int;\n${statics}   END_VAR\n\nBEGIN\n  #a := 1;\nEND_FUNCTION_BLOCK\n`;

describe("rung merge-driver", () => {
  it("git merges two branches that each declared a variable without a conflict", () => {
    const dir = mkdtempSync(join(tmpdir(), "rung-merge-"));
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, ".gitattributes"), "*.scl merge=rung\n");
    git(dir, "config", "merge.rung.driver", `"${process.execPath.replace(/\\/g, "/")}" "${cli.replace(/\\/g, "/")}" merge-driver %O %A %B %P`);
    writeFileSync(join(dir, "FB.scl"), fb(""));
    git(dir, "add", ".");
    expect(git(dir, "commit", "-q", "-m", "base").status).toBe(0);
    git(dir, "checkout", "-q", "-b", "mine");
    writeFileSync(join(dir, "FB.scl"), fb("      b : Bool;\n"));
    git(dir, "commit", "-q", "-am", "b");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "FB.scl"), fb("      c : Real;\n"));
    git(dir, "commit", "-q", "-am", "c");
    const m = git(dir, "merge", "-q", "mine", "-m", "merge");
    expect(m.status, m.stdout + m.stderr).toBe(0);
    expect(readFileSync(join(dir, "FB.scl"), "utf8")).toBe(fb("      c : Real;\n      b : Bool;\n"));
  });
});
