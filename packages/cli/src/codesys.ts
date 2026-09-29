// SPDX-License-Identifier: BUSL-1.1
// The bridge of a CODESYS workspace. rung starts itself as `rung codesys-bridge` (the bridge command of the
// workspace): that starts CODESYS without a window with rung's bridge script (bridge/codesys), which answers the
// same protocol as the TIA Portal bridge on a local TCP port, and relays rung's stdio lines to it and back.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { WorkspaceError } from "@rung/core";
import { devPath, installRoot } from "./paths.js";
import type { Io } from "./common.js";

export interface CodesysInstall {
  exe: string;
  profile: string;
  version: string;
}

const versionKey = (v: string) => v.split(".").map((n) => n.padStart(5, "0")).join(".");

/** The newest CODESYS on this PC (or RUNG_CODESYS / RUNG_CODESYS_PROFILE), with its newest profile. */
export function findCodesys(env: Record<string, string | undefined> = process.env): CodesysInstall | undefined {
  const roots: string[] = [];
  if (env.RUNG_CODESYS) roots.push(join(env.RUNG_CODESYS, "..", "..", ".."));
  for (const base of ["C:\\Program Files", "C:\\Program Files (x86)"]) {
    try {
      for (const d of readdirSync(base)) if (/^CODESYS \d/.test(d)) roots.push(join(base, d));
    } catch {
      /* no such folder */
    }
  }
  const found = roots
    .map((root) => {
      const exe = env.RUNG_CODESYS && roots[0] === root ? env.RUNG_CODESYS : join(root, "CODESYS", "Common", "CODESYS.exe");
      const version = /CODESYS ([\d.]+)/.exec(root)?.[1] ?? "0";
      let profiles: string[] = [];
      try {
        profiles = readdirSync(join(root, "CODESYS", "Profiles")).filter((f) => f.endsWith(".profile.xml")).map((f) => f.slice(0, -".profile.xml".length));
      } catch {
        /* none */
      }
      const profile = env.RUNG_CODESYS_PROFILE ?? profiles.sort().at(-1);
      return existsSync(exe) && profile ? { exe, profile, version } : undefined;
    })
    .filter((x): x is CodesysInstall => !!x)
    .sort((a, b) => (versionKey(a.version) < versionKey(b.version) ? 1 : -1));
  return found[0];
}

export function codesysScript(env: Record<string, string | undefined> = process.env): string | undefined {
  const root = installRoot(env);
  return [root && join(root, "bridge", "codesys", "rung_bridge_codesys.py"), devPath("../../../bridge/codesys/rung_bridge_codesys.py")].find((p): p is string => !!p && existsSync(p));
}

/** How rung starts itself as the bridge of a CODESYS project (in the source tree, node with this CLI). */
export function codesysBridgeCommand(project: string): { command: string; args: string[] } {
  // rung.exe runs itself; rung.cjs and the source tree run their entry point with node (not process.argv[1],
  // which is some other program when rung runs inside one, e.g. the tests)
  const sea = !/node(\.exe)?$/i.test(process.execPath);
  const root = installRoot();
  const entry = sea ? undefined : root && existsSync(join(root, "rung.cjs")) ? join(root, "rung.cjs") : devPath("../dist/index.js");
  return { command: process.execPath, args: [...(entry ? [entry] : []), "codesys-bridge", "--project", project] };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** rung codesys-bridge --project <file.project>: CODESYS without a window, and stdio relayed to its bridge script. */
export async function cmdCodesysBridge(v: Record<string, unknown>, io: Io): Promise<number> {
  const project = v.project ? String(v.project) : "";
  const reply = (code: string, message: string) => io.stdout(JSON.stringify({ event: "bridge-error", params: { code, message } }) + "\n");
  const cds = findCodesys(io.env);
  const script = codesysScript(io.env);
  if (!cds) throw new WorkspaceError("CONFIG_INVALID", "CODESYS is not installed on this PC (rung check says what is needed)");
  if (!script) throw new WorkspaceError("CONFIG_INVALID", "rung's CODESYS bridge script is missing from this installation");
  if (!project || !existsSync(project)) throw new WorkspaceError("CONFIG_INVALID", `CODESYS project not found: ${project}`);
  const port = await freePort();
  const token = randomBytes(16).toString("hex");
  // CODESYS parses its own command line: the quotes must reach it as written
  const child = spawn(cds.exe, [`--profile="${cds.profile}"`, "--noUI", `--runscript="${script}"`], {
    env: { ...process.env, RUNG_CODESYS_PORT: String(port), RUNG_CODESYS_PROJECT: project, RUNG_CODESYS_TOKEN: token },
    windowsVerbatimArguments: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  child.on("exit", () => (exited = true));
  // CODESYS never outlives the relay (an error, Ctrl+C); only a hard kill of the relay escapes this, so the
  // client waits long enough for the orderly way (BridgeClient closeTimeoutMs)
  process.on("exit", () => {
    if (!exited) child.kill();
  });
  process.on("SIGINT", () => process.exit(130));
  child.stdout.on("data", (d: Buffer) => io.stderr(d.toString()));
  child.stderr.on("data", (d: Buffer) => io.stderr(d.toString()));
  // stdin arrives before CODESYS listens (it takes ~12 s to start): keep it until the socket is up
  const pending: string[] = [];
  let sock: Socket | undefined;
  let stdinEnded = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d: string) => (sock ? sock.write(d) : pending.push(d)));
  process.stdin.on("end", () => {
    stdinEnded = true;
    if (sock) sock.write(JSON.stringify({ id: 0, method: "bridge.shutdown", params: {} }) + "\n");
  });
  for (let i = 0; i < 240 && !sock && !exited; i++) {
    sock = await new Promise<Socket | undefined>((res) => {
      const c = createConnection({ host: "127.0.0.1", port }, () => res(c));
      c.on("error", () => res(undefined));
    });
    if (!sock) await new Promise((r) => setTimeout(r, 500));
  }
  if (!sock) {
    reply("BRIDGE_EXITED", exited ? "CODESYS ended before rung's bridge script listened" : "CODESYS did not start rung's bridge script within 2 minutes");
    if (!exited) child.kill();
    return 1;
  }
  sock.write(JSON.stringify({ token }) + "\n");
  for (const d of pending.splice(0)) sock.write(d);
  if (stdinEnded) sock.write(JSON.stringify({ id: 0, method: "bridge.shutdown", params: {} }) + "\n");
  sock.setEncoding("utf8");
  sock.on("data", (d: string) => io.stdout(d)); // the shutdown reply (id 0) is ignored by the client
  await new Promise<void>((resolve) => {
    sock!.on("close", () => resolve());
    child.on("exit", () => resolve());
  });
  // the script closes the project when the connection ends; give CODESYS time to exit, then make sure
  for (let i = 0; i < 40 && !exited; i++) await new Promise((r) => setTimeout(r, 250));
  if (!exited) child.kill();
  return 0;
}
