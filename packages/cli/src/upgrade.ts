// SPDX-License-Identifier: BUSL-1.1
// rung upgrade <project.ap18> [--tia V20]: a project of an older TIA Portal as an upgraded project next to it
// (<folder>_V20, as TIA Portal names it). TIA Portal (without window) upgrades a copy: the original stays as it was.
import { execFileSync, spawn } from "node:child_process";
import { cp, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { WorkspaceError } from "@rung/core";
import { BridgeError } from "@rung/bridge-client";
import { bridgeExecutable, tiaOf, type TiaVersion } from "./paths.js";
import { defaultBridge, type Io } from "./common.js";
import { whitelistStatus, WHITELIST_HINT } from "./setup.js";

export function upgradePlan(file: string, to: TiaVersion, nonce: number) {
  if (/\.zap\d+$/i.test(file)) throw new WorkspaceError("BAD_ARGUMENT", "A .zap archive must be retrieved in TIA Portal first (Project → Retrieve); then rung upgrade the retrieved .ap file");
  const m = /\.ap(\d+)$/i.exec(file);
  if (!m) throw new WorkspaceError("BAD_ARGUMENT", "rung upgrade needs a TIA Portal project file (.ap17, .ap18, …)");
  const from = Number(m[1]);
  if (from >= Number(to.slice(1))) throw new WorkspaceError("BAD_ARGUMENT", `${basename(file)} is a TIA Portal V${from} project already: rung init --project ${file}`);
  const folder = dirname(file);
  // TIA Portal writes <folder>_V20 next to the project it upgrades and touches that project's folder (logs, .info):
  // so a copy in a staging folder is upgraded, and only the result moves next to the original
  const staging = join(dirname(folder), `.rung-upgrade-${nonce}`);
  return { from, to, folder, staging, file: join(staging, basename(folder), basename(file)), target: join(dirname(folder), `${basename(folder)}_${to}`) };
}

/** rung init on a project rung cannot open: what to run instead. */
export function olderProjectHint(file: string): string | undefined {
  const m = /\.ap(\d+)$/i.exec(file);
  if (!m || Number(m[1]) >= 19) return undefined;
  return `${basename(file)} is a TIA Portal V${m[1]} project; rung works with V19, V20 and V21. rung upgrade ${file} makes an upgraded project next to it (the original stays as it is), then rung init --project <that project>`;
}

export async function cmdUpgrade(target: string | undefined, v: Record<string, unknown>, io: Io): Promise<number> {
  if (!target) {
    io.stderr("rung: usage: rung upgrade <project.ap18> [--tia V20] [--timeout <minutes>]\n");
    return 1;
  }
  const plan = upgradePlan(resolve(io.cwd, target), tiaOf(v.tia ?? "V20"), process.pid);
  if (existsSync(plan.target)) throw new WorkspaceError("BAD_ARGUMENT", `${plan.target} exists already: it may be an earlier upgrade; move it away to upgrade again`);
  const minutes = Number(v.timeout ?? 30);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new WorkspaceError("BAD_ARGUMENT", `--timeout is minutes (--timeout 60); got ${String(v.timeout)}`);
  const own = defaultBridge(io.env);
  const exe = io.env.RUNG_BRIDGE ? own.command : bridgeExecutable(io.env, plan.to);
  // a TIA Portal without window that waits for the "Openness access" answer never comes back
  if (!io.env.RUNG_BRIDGE && (await whitelistStatus(exe, `${plan.to.slice(1)}.0`)) !== "ok") throw new BridgeError("ACCESS_DENIED", WHITELIST_HINT);
  // seen on V20: a project carrying device description files (GSD) has TIA Portal install them, which it refuses with a
  // dialog while another TIA Portal runs
  if (process.platform === "win32" && runningPortals() > 0)
    io.stderr("rung: another TIA Portal is running: TIA Portal installs a project's device description files (GSD) only when it is the only one; close it if the upgrade waits\n");
  await cp(plan.folder, dirname(plan.file), { recursive: true, errorOnExist: true, force: false });
  io.stderr(`rung: TIA Portal ${plan.to} upgrades a copy of ${plan.folder} (minutes for a large project)\n`);
  let tiaPid = 0, timedOut = false;
  const out = await new Promise<string>((done, fail) => {
    const child = spawn(exe, [...own.args, "--upgrade", "--project", plan.file], { windowsHide: true, env: io.env as NodeJS.ProcessEnv });
    let text = "";
    child.stdout.on("data", (d) => {
      text += d;
      tiaPid ||= Number(/"tiaPid":(\d+)/.exec(text)?.[1] ?? 0);
    });
    // a TIA Portal without window that waits on a dialog never answers: stop the bridge and exactly its TIA Portal
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      if (tiaPid) try { process.kill(tiaPid); } catch { /* gone already */ }
    }, minutes * 60_000);
    child.on("error", (e) => { clearTimeout(timer); fail(e); });
    child.on("exit", () => { clearTimeout(timer); done(text); });
  });
  const line = out.trim().split(/\r?\n/).filter((l) => !/"tiaPid"/.test(l)).at(-1) ?? "";
  let r: { path?: string; error?: string } = {};
  try { r = JSON.parse(line); } catch { r = { error: line || "the bridge ended without an answer" }; }
  if (timedOut) r = { error: `no answer within ${minutes} min (TIA Portal waits on a decision it cannot show without window: another TIA Portal running while it installs device description files, or an Openness access question. Close other TIA Portals and run again, or open the project in TIA Portal once)` };
  if (!r.path) {
    await rm(plan.staging, { recursive: true, force: true }).catch(() => {});
    throw new BridgeError("TARGET_REFUSED", `TIA Portal ${plan.to} did not upgrade the project: ${r.error}. The original is unchanged.`);
  }
  await rename(dirname(r.path), plan.target);
  await rm(plan.staging, { recursive: true, force: true }).catch(() => {});
  const upgraded = join(plan.target, basename(r.path));
  if (v.json) io.stdout(JSON.stringify({ upgraded, from: `V${plan.from}`, to: plan.to, original: join(plan.folder, basename(plan.file)) }) + "\n");
  else io.stdout(`upgraded: ${upgraded} (TIA Portal's log of the upgrade is in its Logs folder)\nnext: rung init --project "${upgraded}"\n`);
  return 0;
}

/** TIA Portals running now (their main process: background helpers carry -Name=). */
function runningPortals(): number {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name='Siemens.Automation.Portal.exe'\" | ? { $_.CommandLine -notmatch '-Name=' }).Count"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    return Number(out.trim()) || 0;
  } catch { return 0; }
}
