// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.js";

function folder(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "rung-lint-"));
  mkdirSync(join(dir, "plc", "PLC_1", "blocks"), { recursive: true });
  writeFileSync(join(dir, "plc", "PLC_1", "blocks", "Fx.scl"), `FUNCTION "Fx" : Void\nVAR_TEMP\n  x : Int;\n  r : Real;\nEND_VAR\nBEGIN\n${body}\nEND_FUNCTION\n`);
  let out = "", err = "";
  const io = { cwd: dir, env: {}, stdout: (s: string) => { out += s; }, stderr: (s: string) => { err += s; } };
  return { run: (...args: string[]) => main(["lint", ...args], io), out: () => out, err: () => err };
}

describe("rung lint", () => {
  it("exits 1 on errors, prints a summary, and fails on more warnings than --max-warnings", async () => {
    const bad = folder("  #y := 1;");
    expect(await bad.run()).toBe(1);
    expect(bad.out()).toMatch(/Fx\.scl:7: error UNDECLARED[^\n]*\n(?:[^\n]*\n)*1 error, 0 warnings, \d+ notes? in 1 file\n$/);

    // Int := Real is a warning (TIA Portal warns when compiling)
    const warned = folder("  #r := 1.5;\n  #x := #r;");
    expect(await warned.run()).toBe(0);
    expect(warned.out().trim().split("\n").at(-1)).toBe("0 errors, 1 warning in 1 file");
    expect(await warned.run("--max-warnings", "0")).toBe(1);
    expect(warned.out()).toContain("0 errors, 1 warning in 1 file (more than --max-warnings 0)");
    expect(await warned.run("--max-warnings", "1")).toBe(0);
    expect(await warned.run("--max-warnings", "many")).toBe(1);
    expect(warned.err()).toContain("--max-warnings is a number of warnings");
  });
});
