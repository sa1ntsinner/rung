// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleBase, installBundledRung, onPath, shimPath, shimText } from "../src/bundled";

describe("the rung that comes with the extension", () => {
  it("a shim runs the copy with VS Code's executable as Node.js, on Windows and elsewhere", () => {
    const win = shimText("C:\\Program Files\\Microsoft VS Code\\Code.exe", "win32");
    expect(win).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(win).toContain('set "RUNG_HOME=%~dp0bundle"');
    expect(win).toContain('"C:\\Program Files\\Microsoft VS Code\\Code.exe" "%~dp0bundle\\rung.cjs" %*');
    expect(win).toContain("\r\n");
    const sh = shimText("/usr/share/code/code", "linux");
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain('ELECTRON_RUN_AS_NODE=1 RUNG_HOME="$here/bundle" exec "/usr/share/code/code" "$here/bundle/rung.cjs" "$@"');
    expect(shimPath("C:\\x", "win32")).toMatch(/rung\.cmd$/);
    expect(bundleBase({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32")).toBe(join("C:\\Users\\a\\AppData\\Local", "rung"));
  });

  it("copies the bundle once per version into a folder that survives updates, and writes the shim", async () => {
    const ext = mkdtempSync(join(tmpdir(), "rung-ext-"));
    mkdirSync(join(ext, "rung", "bridge"), { recursive: true });
    writeFileSync(join(ext, "rung", "rung.cjs"), "console.log('hi')\n");
    writeFileSync(join(ext, "rung", "VERSION"), "1.0.0+abc\n");
    const home = mkdtempSync(join(tmpdir(), "rung-home-"));
    const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    Object.assign(process.env, { LOCALAPPDATA: home, HOME: home, USERPROFILE: home });
    try {
      const log: string[] = [];
      const shim = await installBundledRung(ext, (s) => log.push(s));
      expect(shim).toBeDefined();
      const base = bundleBase();
      expect(readFileSync(join(base, "bundle", "VERSION"), "utf8").trim()).toBe("1.0.0+abc");
      expect(readFileSync(shim!, "utf8")).toContain(process.execPath);
      expect(log).toHaveLength(1);
      await installBundledRung(ext, (s) => log.push(s)); // same version: nothing copied
      expect(log).toHaveLength(1);
      writeFileSync(join(ext, "rung", "VERSION"), "1.0.1+def\n");
      await installBundledRung(ext, (s) => log.push(s));
      expect(readFileSync(join(base, "bundle", "VERSION"), "utf8").trim()).toBe("1.0.1+def");
      // a development build carries no rung: nothing happens
      expect(await installBundledRung(mkdtempSync(join(tmpdir(), "rung-ext-")), () => {})).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("knows whether a folder is on PATH, whatever the letter case or trailing slash", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    expect(onPath(join("C:", "Users", "a", "rung"), { Path: ["C:\\Windows", join("c:", "users", "a", "rung") + "\\"].join(sep) })).toBe(true);
    expect(onPath(join("C:", "x"), { PATH: "C:\\Windows" })).toBe(false);
  });
});
