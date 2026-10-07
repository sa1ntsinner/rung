// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.js";

const conveyor = fileURLToPath(new URL("../../../examples/conveyor", import.meta.url));
const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });

describe("rung test --against", () => {
  it("runs today's scenarios on the code then and now, and names the first value that differs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rung-against-"));
    cpSync(conveyor, dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "add", ".");
    expect(git(dir, "commit", "-q", "-m", "base").status).toBe(0);
    const scl = join(dir, "blocks", "FB_Conveyor.scl");
    writeFileSync(scl, readFileSync(scl, "utf8").replace("OR #Fault OR", "OR"));
    const out: string[] = [];
    const io = { cwd: dir, stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), env: {} };
    const code = await main(["test", "--against", "HEAD"], io);
    expect(code, out.join("")).toBe(2); // a case that passed then fails now
    const text = out.join("");
    expect(text).toMatch(/^behaviour against HEAD \(5 cases\):/);
    expect(text).toContain("a contactor that does not answer within 2 s is a fault until reset (passed then, failed now)");
    expect(text).toMatch(/step \d+: Motor FALSE → TRUE/);
    expect(text).toMatch(/1 case behaves differently, 4 the same/);
    out.length = 0;
    expect(await main(["test", "--against", "nope-rev"], io)).toBe(1);
    expect(out.join("")).toContain("nope-rev is not a revision of this repository");
    // a block renamed since: the code then still has it under its old name
    git(dir, "checkout", "-q", "--", ".");
    git(dir, "mv", "blocks/FB_Conveyor.scl", "blocks/FB_Belt.scl");
    out.length = 0;
    expect(await main(["test", "--against", "HEAD"], io)).toBe(0);
    expect(out.join("")).toMatch(/every case behaves as it did/);
    out.length = 0;
    const plain = mkdtempSync(join(tmpdir(), "rung-nogit-"));
    cpSync(conveyor, plain, { recursive: true });
    expect(await main(["test", "--against", "HEAD"], { ...io, cwd: plain })).toBe(1);
    expect(out.join("")).toContain("is not in a git repository");
  });
});
