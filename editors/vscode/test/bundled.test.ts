// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchPath, installBundledRung, onPath, shimPath, shimText, versionDir } from "../src/bundled";

describe("the rung that comes with the extension", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\Əli\\AppData\\Local", APPDATA: "C:\\Users\\Əli\\AppData\\Roaming", ProgramFiles: "C:\\Program Files" };

  it("a shim runs the current copy with VS Code's executable as Node.js; paths under known folders stay ASCII", () => {
    const win = shimText("C:\\Users\\Əli\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe", "1.0.0+abc", "win32", env);
    expect(win).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(win).toContain('set "RUNG_HOME=%~dp0rung-1.0.0+abc"');
    expect(win).toContain('"%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe" "%~dp0rung-1.0.0+abc\\rung.cjs" %*');
    expect(win).not.toContain("chcp");
    expect(/[^\x00-\x7f]/.test(win)).toBe(false);
    expect(win).toContain("\r\n");
    const sh = shimText("/usr/share/code/code", "1.0.0+abc", "linux");
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain('ELECTRON_RUN_AS_NODE=1 RUNG_HOME="$here/rung-1.0.0+abc" exec "/usr/share/code/code" "$here/rung-1.0.0+abc/rung.cjs" "$@"');
    expect(shimPath("C:\\x", "win32")).toMatch(/rung\.cmd$/);
  });

  it("a path outside every known folder and outside ASCII switches the console to UTF-8 and back", () => {
    const win = shimText("D:\\Programmə\\Code\\Code.exe", "1", "win32", env);
    expect(win).toContain("chcp 65001 >nul");
    expect(win).toContain("chcp %RUNG_CP% >nul");
    expect(win).toContain("exit /b %RUNG_RC%");
    expect(batchPath("C:\\Program Files\\Microsoft VS Code\\Code.exe", env)).toBe("%ProgramFiles%\\Microsoft VS Code\\Code.exe");
  });

  it("copies each version once into a folder of its own, points the shim at it and removes older ones", async () => {
    const ext = mkdtempSync(join(tmpdir(), "rung-ext-"));
    mkdirSync(join(ext, "rung", "bridge"), { recursive: true });
    writeFileSync(join(ext, "rung", "rung.cjs"), "console.log('hi')\n");
    writeFileSync(join(ext, "rung", "VERSION"), "1.0.0+abc\n");
    const base = join(mkdtempSync(join(tmpdir(), "rung-storage-")), "globalStorage");
    const log: string[] = [];
    const shim = await installBundledRung(ext, base, (s) => log.push(s));
    expect(shim).toBe(shimPath(base));
    expect(existsSync(join(base, versionDir("1.0.0+abc"), "rung.cjs"))).toBe(true);
    expect(readFileSync(shim!, "utf8")).toContain(versionDir("1.0.0+abc"));
    expect(log).toHaveLength(1);
    await installBundledRung(ext, base, (s) => log.push(s)); // the same version: nothing copied
    expect(log).toHaveLength(1);
    writeFileSync(join(ext, "rung", "VERSION"), "1.0.1+def\n");
    await installBundledRung(ext, base, (s) => log.push(s));
    expect(readFileSync(shim!, "utf8")).toContain(versionDir("1.0.1+def"));
    expect(readdirSync(base).filter((d) => d.startsWith("rung-"))).toEqual([versionDir("1.0.1+def")]);
    // a development build carries no rung: nothing happens
    expect(await installBundledRung(mkdtempSync(join(tmpdir(), "rung-ext-")), base, () => {})).toBeUndefined();
  });

  it("knows whether a folder is on PATH: on Windows whatever the letter case, slashes or trailing slash", () => {
    expect(onPath("C:\\Users\\a\\rung", { Path: "C:\\Windows;c:/users/a/rung\\" }, "win32")).toBe(true);
    expect(onPath("C:\\x", { PATH: "C:\\Windows" }, "win32")).toBe(false);
    expect(onPath("/home/a/.local/bin", { PATH: "/usr/bin:/home/a/.local/bin/" }, "linux")).toBe(true);
    expect(onPath("/home/a/.local/bin", { PATH: "/usr/bin:/home/A/.local/bin" }, "linux")).toBe(false);
    expect(onPath("/Users/a/bin", { PATH: "/usr/bin:/users/a/bin" }, "darwin")).toBe(true);
  });
});
