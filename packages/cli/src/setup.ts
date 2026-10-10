// SPDX-License-Identifier: BUSL-1.1
// rung setup openness: registers the bridge in the TIA Portal Openness whitelist.
// TIA remembers an allowed Openness client by file name + SHA-256 + write time under
// HKLM\SOFTWARE\Siemens\Automation\Openness\<version>\Whitelist up to V20 and under ...\Openness\AllowList from V21
// on (whitelistKey). A bridge that is
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

/**
 * The registry key TIA Portal reads for this client. V21 keeps one AllowList for all versions and does not read
 * 21.0\Whitelist (seen on V21: a client listed only there still gets the "Openness access" prompt, which a TIA Portal
 * without window cannot show, so it hangs).
 */
export function whitelistKey(version: string, exe: string): string {
  const major = Number(version.split(".")[0]);
  const root = major >= 21 ? "AllowList" : `${version}\\Whitelist`;
  return `HKLM\\SOFTWARE\\Siemens\\Automation\\Openness\\${root}\\${basename(exe)}\\Entry`;
}

/** `version` is the whitelist's (20.0); by default the one of the bridge's own TIA Portal (rung-bridge-v21.exe: 21.0). */
export async function whitelistStatus(exe: string, version = `${/rung-bridge-v(\d\d)\.exe$/i.exec(basename(exe))?.[1] ?? "20"}.0`): Promise<WhitelistStatus> {
  if (process.platform !== "win32" || !existsSync(exe)) return "unknown";
  const key = whitelistKey(version, exe);
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

/**
 * The bridges to register: the one RUNG_BRIDGE names (the bridge sync and watch start then), else one per TIA Portal
 * installed here whose bridge came with rung (V20 when none is found).
 */
export function bridgesHere(env: Record<string, string | undefined>): { exe: string; version: string }[] {
  if (env.RUNG_BRIDGE) return [{ exe: env.RUNG_BRIDGE, version: `${/rung-bridge-v(\d\d)\.exe$/i.exec(basename(env.RUNG_BRIDGE))?.[1] ?? "20"}.0` }];
  const programs = env.ProgramFiles ?? "C:\\Program Files";
  const found = (["V19", "V20", "V21"] as const)
    .map((tia) => ({ tia, exe: bridgeExecutable(env, tia) }))
    .filter((b) => existsSync(b.exe) && existsSync(join(programs, "Siemens", "Automation", `Portal ${b.tia}`)));
  return (found.length ? found : [{ tia: "V20" as const, exe: bridgeExecutable(env) }]).map((b) => ({ exe: b.exe, version: `${b.tia.slice(1)}.0` }));
}

/** The whitelist state of every bridge for a TIA Portal installed here, as one: the worst of them. */
export async function whitelistHere(env: Record<string, string | undefined>): Promise<WhitelistStatus> {
  const all = await Promise.all(bridgesHere(env).map((b) => whitelistStatus(b.exe, b.version)));
  return (["missing", "stale", "unknown"] as const).find((s) => all.includes(s)) ?? "ok";
}

export async function cmdSetup(what: string | undefined, v: Record<string, unknown>, io: Io): Promise<number> {
  if (what !== "openness") {
    io.stderr("rung: usage: rung setup openness [--grant]\n");
    return 1;
  }
  const bridges = bridgesHere(io.env);
  const status = async () => Promise.all(bridges.map((b) => whitelistStatus(b.exe, b.version)));
  const before = await status();
  if (before.every((s) => s === "ok")) {
    for (const b of bridges) io.stdout(`${b.exe} is already in the Openness whitelist\n`);
    return 0;
  }
  if (before.every((s) => s === "unknown")) {
    io.stderr(`rung: cannot check the Openness whitelist here (${process.platform === "win32" ? `no bridge at ${bridges[0]!.exe}` : "not Windows"})\n`);
    return 1;
  }
  const script = scriptPath(io.env);
  if (!script) {
    io.stderr("rung: Register-OpennessWhitelist.ps1 is missing from this installation\n");
    return 1;
  }
  const pending = bridges.filter((_, i) => before[i] === "missing" || before[i] === "stale");
  // first without elevation: works when the user may already write the whitelist (setup with --grant earlier)
  for (const b of pending) await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", b.exe, "-Version", b.version, "-Quiet"], { windowsHide: true }).catch(() => undefined);
  const still = (await status()).map((s, i) => ({ s, b: bridges[i]! })).filter((x) => x.s === "missing" || x.s === "stale").map((x) => x.b);
  if (still.length) {
    io.stdout("Registering the bridge needs administrator rights once; Windows will ask (UAC).\n");
    // one elevated PowerShell for all versions (one UAC prompt); its script goes encoded, so no quoting reaches a shell
    const lit = (x: string) => "'" + x.replace(/'/g, "''") + "'";
    const user = (io.env.USERDOMAIN ? io.env.USERDOMAIN + "\\" : "") + (io.env.USERNAME ?? "");
    const inner = still.map((b) => `& ${lit(script)} -Path ${lit(b.exe)} -Version ${lit(b.version)}${v.grant ? ` -GrantUser ${lit(user)}` : ""}`).join("; ");
    const encoded = Buffer.from(inner, "utf16le").toString("base64");
    const command = `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}')`;
    await run("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true }).catch(() => undefined);
  }
  const after = await status();
  const missing = bridges.filter((_, i) => after[i] === "missing" || after[i] === "stale");
  if (missing.length) {
    io.stderr(`rung: ${missing.map((b) => b.exe).join(", ")} still not in the whitelist (UAC declined?). You can also start it once against a TIA Portal with window and answer "Yes to all".\n`);
    return 1;
  }
  for (const b of bridges.filter((_, i) => after[i] === "ok")) io.stdout(`registered ${b.exe} in the Openness whitelist (TIA Portal V${b.version.split(".")[0]})${v.grant ? "; you can now update it without administrator rights" : ""}\n`);
  return 0;
}
