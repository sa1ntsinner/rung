// SPDX-License-Identifier: BUSL-1.1
// rung setup openness: registers the bridge in the TIA Portal Openness whitelist.
// TIA remembers an allowed Openness client by file name + SHA-256 + write time under
// HKLM\SOFTWARE\Siemens\Automation\Openness\<version>\Whitelist. A bridge that is
// not in the list makes TIA ask "Openness access"; a TIA Portal without user interface cannot ask and hangs.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { bridgeExecutable, installRoot, devPath } from "./paths.js";
import type { Io } from "./common.js";

const run = promisify(execFile);

export type WhitelistStatus = "ok" | "missing" | "stale" | "unknown";

export async function whitelistStatus(exe: string, version = "20.0"): Promise<WhitelistStatus> {
  if (process.platform !== "win32" || !existsSync(exe)) return "unknown";
  const key = `HKLM\\SOFTWARE\\Siemens\\Automation\\Openness\\${version}\\Whitelist\\${basename(exe)}\\Entry`;
  // reg export writes UTF-16: a path outside ASCII (C:\Users\Jörg\…) survives, unlike reg query's console code page
  const tmp = join(tmpdir(), `rung-whitelist-${process.pid}-${Date.now()}.reg`);
  let out: string;
  try {
    await run("reg", ["export", key, tmp, "/y"], { windowsHide: true });
    out = (await readFile(tmp)).toString("utf16le");
  } catch {
    return "missing";
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
  return entryStatus(out, exe, createHash("sha256").update(await readFile(exe)).digest("base64"));
}

/**
 * What a whitelist entry (reg query output) says about this bridge. TIA Portal checks the path as well as the hash:
 * the same file at another path (the VS Code extension runs a copy in its storage folder, a new one per version)
 * still makes it ask, so an entry for another path is stale.
 */
export function entryStatus(regOutput: string, exe: string, sha256: string): WhitelistStatus {
  // reg query: `FileHash    REG_SZ    …`; reg export: `"FileHash"="…"` with doubled backslashes
  const value = (name: string) => new RegExp(`\\b${name}\\s+REG_SZ\\s+(.+?)\\s*$`, "m").exec(regOutput)?.[1] ?? /^"(.*)"$/.exec(new RegExp(`^"${name}"=(".*")\\s*$`, "m").exec(regOutput)?.[1] ?? "")?.[1]?.replace(/\\\\/g, "\\");
  const registered = value("FileHash");
  if (!registered) return "missing";
  const path = value("Path");
  const same = (a: string) => a.replace(/[\\/]+$/, "").toLowerCase() === dirname(exe).replace(/[\\/]+$/, "").toLowerCase() || a.toLowerCase() === exe.toLowerCase();
  return registered === sha256 && (!path || same(path)) ? "ok" : "stale";
}

function scriptPath(env: Record<string, string | undefined>): string | undefined {
  const root = installRoot(env);
  return [root && join(root, "tools", "Register-OpennessWhitelist.ps1"), devPath("../../../tools/openness/Register-OpennessWhitelist.ps1")].find((p): p is string => !!p && existsSync(p));
}

export const WHITELIST_HINT =
  "TIA Portal does not know this rung bridge yet, so it will ask \"Openness access\" (and a TIA Portal without window hangs). Run: rung setup openness";

export async function cmdSetup(what: string | undefined, v: Record<string, unknown>, io: Io): Promise<number> {
  if (what !== "openness") {
    io.stderr("rung: usage: rung setup openness [--grant]\n");
    return 1;
  }
  const exe = bridgeExecutable(io.env);
  const before = await whitelistStatus(exe);
  if (before === "ok") {
    io.stdout(`${exe} is already in the Openness whitelist\n`);
    return 0;
  }
  if (before === "unknown") {
    io.stderr(`rung: cannot check the Openness whitelist here (${process.platform === "win32" ? `no bridge at ${exe}` : "not Windows"})\n`);
    return 1;
  }
  const script = scriptPath(io.env);
  if (!script) {
    io.stderr("rung: Register-OpennessWhitelist.ps1 is missing from this installation\n");
    return 1;
  }
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", exe, "-Quiet"];
  // first without elevation: works when the user may already write the whitelist (setup with --grant earlier)
  await run("powershell.exe", args, { windowsHide: true }).catch(() => undefined);
  if ((await whitelistStatus(exe)) !== "ok") {
    io.stdout("Registering the bridge needs administrator rights once; Windows will ask (UAC).\n");
    // PowerShell literal strings; paths are wrapped in double quotes because Start-Process joins the list with spaces
    const lit = (x: string) => "'" + x.replace(/'/g, "''") + "'";
    const user = (io.env.USERDOMAIN ? io.env.USERDOMAIN + "\\" : "") + (io.env.USERNAME ?? "");
    const list = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `"${script}"`, "-Path", `"${exe}"`, ...(v.grant ? ["-GrantUser", `"${user}"`] : [])];
    const command = `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @(${list.map(lit).join(",")})`;
    await run("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true }).catch(() => undefined);
  }
  const after = await whitelistStatus(exe);
  if (after !== "ok") {
    io.stderr("rung: the bridge is still not in the whitelist (UAC declined?). You can also start it once against a TIA Portal with window and answer \"Yes to all\".\n");
    return 1;
  }
  io.stdout(`registered ${exe} in the Openness whitelist${v.grant ? "; you can now update it without administrator rights" : ""}\n`);
  return 0;
}
