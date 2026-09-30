// SPDX-License-Identifier: MIT
// The rung that comes with the extension (rung/ in the .vsix: rung.cjs, the bridges, the agent skills), so installing
// the extension is all it takes. It is copied to a folder that survives extension updates, next to a small `rung`
// command that runs it with VS Code's own Node.js; terminals and agents can use that command too once it is on PATH.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where the copy lives: %LOCALAPPDATA%\rung on Windows, ~/.local/share/rung elsewhere. */
export function bundleBase(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "rung") : join(homedir(), ".local", "share", "rung");
}

/** The command file in `base` that starts the copied rung. */
export function shimPath(base: string, platform: NodeJS.Platform = process.platform): string {
  return join(base, platform === "win32" ? "rung.cmd" : "rung");
}

/** The shim's text: VS Code's executable runs as plain Node.js (ELECTRON_RUN_AS_NODE) with the copied rung.cjs. */
export function shimText(node: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32")
    return ['@echo off', "rem rung, installed by the rung VS Code extension: VS Code's own Node.js runs it", "setlocal", 'set "ELECTRON_RUN_AS_NODE=1"', 'set "RUNG_HOME=%~dp0bundle"', `"${node}" "%~dp0bundle\\rung.cjs" %*`, ""].join("\r\n");
  return ["#!/bin/sh", "# rung, installed by the rung VS Code extension: VS Code's own Node.js runs it", 'here="$(cd "$(dirname "$0")" && pwd)"', `ELECTRON_RUN_AS_NODE=1 RUNG_HOME="$here/bundle" exec "${node}" "$here/bundle/rung.cjs" "$@"`, ""].join("\n");
}

const nodeMajor = () => Number(process.versions.node.split(".")[0]);

/**
 * Copies the extension's rung to the stable folder when its version changed and (re)writes the shim for this
 * VS Code. Returns the shim, or undefined when the extension carries no rung (a development build) or this
 * VS Code's Node.js is older than rung needs. A copy in use (a bridge running from it) is replaced next time.
 */
export async function installBundledRung(extensionRoot: string, log: (s: string) => void): Promise<string | undefined> {
  const src = join(extensionRoot, "rung");
  if (!existsSync(join(src, "rung.cjs"))) return undefined;
  if (nodeMajor() < 22) {
    log(`the rung that comes with the extension needs Node.js 22 (this VS Code has ${process.versions.node}); update VS Code, or install rung and put it on PATH`);
    return undefined;
  }
  const base = bundleBase();
  const dir = join(base, "bundle");
  const version = (await readFile(join(src, "VERSION"), "utf8").catch(() => "")).trim();
  const installed = (await readFile(join(dir, "VERSION"), "utf8").catch(() => "")).trim();
  if (!version || version !== installed) {
    await mkdir(base, { recursive: true });
    const fresh = dir + ".new";
    await rm(fresh, { recursive: true, force: true });
    await cp(src, fresh, { recursive: true });
    try {
      await rm(dir, { recursive: true, force: true });
      await rename(fresh, dir);
      log(`rung ${version} copied to ${dir}`);
    } catch (e) {
      // a bridge still runs from the old copy (Windows keeps its files): the old one stays until next time
      log(`rung ${version} is not copied yet (${(e as Error).message}); the copy in ${dir} is used until VS Code starts again`);
      if (!existsSync(join(dir, "rung.cjs"))) return undefined;
    }
  }
  const shim = shimPath(base);
  const text = shimText(process.execPath);
  if ((await readFile(shim, "utf8").catch(() => "")) !== text) {
    await writeFile(shim, text);
    if (process.platform !== "win32") await chmod(shim, 0o755);
  }
  return shim;
}

/** Whether `dir` is on the user's PATH as this process sees it. */
export function onPath(dir: string, env: Record<string, string | undefined> = process.env): boolean {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return (env[key] ?? "").split(delimiter).some((p) => p && norm(p) === norm(dir));
}

/**
 * Puts `dir` on the user's PATH for new terminals and agents: the user environment on Windows (not setx, which
 * cuts long values), a line in ~/.profile elsewhere. Only on the person's request.
 */
export async function addToUserPath(dir: string): Promise<void> {
  if (process.platform === "win32") {
    const ps = `$d = '${dir.replace(/'/g, "''")}'; $p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not (($p -split ';') -contains $d)) { [Environment]::SetEnvironmentVariable('Path', ($(if ($p) { $p.TrimEnd(';') + ';' } else { '' }) + $d), 'User') }`;
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 30_000 });
    return;
  }
  const profile = join(homedir(), ".profile");
  const line = `export PATH="${dir}:$PATH"  # rung`;
  const cur = await readFile(profile, "utf8").catch(() => "");
  if (!cur.includes(line)) await writeFile(profile, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n");
}
