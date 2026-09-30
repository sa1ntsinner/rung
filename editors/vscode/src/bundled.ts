// SPDX-License-Identifier: MIT
// The rung that comes with the extension (rung/ in the .vsix: rung.cjs, the bridges, the agent skills), so installing
// the extension is all it takes. It is copied into the extension's own storage folder (VS Code's globalStorage, which
// survives extension updates), one folder per version, next to a small `rung` command that runs it with VS Code's own
// Node.js; terminals and agents can use that command too once the person puts it on PATH.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The command file in `base` that starts the current copy. */
export function shimPath(base: string, platform: NodeJS.Platform = process.platform): string {
  return join(base, platform === "win32" ? "rung.cmd" : "rung");
}

/** Folder of one version of the copy, inside `base`: plain ASCII, so the shim can name it relative to itself. */
export const versionDir = (version: string) => "rung-" + version.replace(/[^A-Za-z0-9.+-]/g, "_");

/**
 * A Windows path as the shim writes it: under a known folder as %LOCALAPPDATA%\…, so a user name with letters
 * outside the console's code page (C:\Users\Əli) reaches cmd.exe intact.
 */
export function batchPath(path: string, env: Record<string, string | undefined> = process.env): string {
  for (const v of ["LOCALAPPDATA", "APPDATA", "USERPROFILE", "ProgramFiles", "ProgramFiles(x86)"]) {
    const dir = env[v];
    if (dir && path.toLowerCase().startsWith(dir.toLowerCase().replace(/[\\/]+$/, "") + "\\")) return `%${v}%${path.slice(dir.replace(/[\\/]+$/, "").length)}`;
  }
  return path;
}

/** The shim's text: VS Code's executable runs as plain Node.js (ELECTRON_RUN_AS_NODE) with the copy's rung.cjs. */
export function shimText(node: string, version: string, platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): string {
  const dir = versionDir(version);
  if (platform === "win32") {
    const exe = batchPath(node, env);
    const call = `"${exe}" "%~dp0${dir}\\rung.cjs" %*`;
    // a path still outside ASCII: read the rest of this file as UTF-8, and give the console its code page back
    const utf8 = /[^\x20-\x7e]/.test(exe);
    return [
      "@echo off",
      "rem rung, installed by the rung VS Code extension: VS Code's own Node.js runs it",
      "setlocal",
      'set "ELECTRON_RUN_AS_NODE=1"',
      `set "RUNG_HOME=%~dp0${dir}"`,
      ...(utf8 ? ['for /f "tokens=2 delims=:" %%c in (\'chcp\') do set "RUNG_CP=%%c"', "chcp 65001 >nul", call, 'set "RUNG_RC=%ERRORLEVEL%"', "chcp %RUNG_CP% >nul", "exit /b %RUNG_RC%"] : [call]),
      "",
    ].join("\r\n");
  }
  return ["#!/bin/sh", "# rung, installed by the rung VS Code extension: VS Code's own Node.js runs it", 'here="$(cd "$(dirname "$0")" && pwd)"', `ELECTRON_RUN_AS_NODE=1 RUNG_HOME="$here/${dir}" exec "${node}" "$here/${dir}/rung.cjs" "$@"`, ""].join("\n");
}

const nodeMajor = () => Number(process.versions.node.split(".")[0]);

/**
 * Copies the extension's rung into `base` (a folder of its own per version) when that version is not there yet,
 * then points the shim at it. Returns the shim, or undefined when the extension carries no rung (a development
 * build) or this VS Code's Node.js is older than rung needs. Old versions are removed when nothing uses them; one
 * a bridge still runs from stays until next time.
 */
export async function installBundledRung(extensionRoot: string, base: string, log: (s: string) => void): Promise<string | undefined> {
  const src = join(extensionRoot, "rung");
  if (!existsSync(join(src, "rung.cjs"))) return undefined;
  if (nodeMajor() < 22) {
    log(`the rung that comes with the extension needs Node.js 22 (this VS Code has ${process.versions.node}); update VS Code, or install rung and put it on PATH`);
    return undefined;
  }
  const version = (await readFile(join(src, "VERSION"), "utf8").catch(() => "")).trim() || "0";
  const dir = join(base, versionDir(version));
  if (!existsSync(join(dir, "rung.cjs"))) {
    await mkdir(base, { recursive: true });
    const fresh = dir + ".new";
    await rm(fresh, { recursive: true, force: true });
    await cp(src, fresh, { recursive: true });
    await rename(fresh, dir); // complete, or not there: the shim points at it only afterwards
    log(`rung ${version} copied to ${dir}`);
  }
  const shim = shimPath(base);
  const text = shimText(process.execPath, version);
  if ((await readFile(shim, "utf8").catch(() => "")) !== text) {
    await writeFile(shim, text);
    if (process.platform !== "win32") await chmod(shim, 0o755);
  }
  for (const other of await readdir(base).catch(() => [] as string[]))
    if (other.startsWith("rung-") && other !== versionDir(version)) await rm(join(base, other), { recursive: true, force: true }).catch(() => {}); // in use: next time
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
