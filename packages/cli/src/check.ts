// SPDX-License-Identifier: BUSL-1.1
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatChecks, realProbes, runChecks, WorkspaceError, type CheckItem } from "@rung/core";
import { cleanEnv, sshCommand, type Io } from "./common.js";

const run = promisify(execFile);

export async function cmdCheck(v: Record<string, unknown>, io: Io): Promise<number> {
  if (v.host !== undefined) {
    const host = String(v.host);
    const ssh = sshCommand(host, "rung check --json", io.env);
    let answer: string;
    try {
      const result = await run(ssh.command, ssh.args, { env: { ...process.env, ...cleanEnv(io.env) }, encoding: "utf8", timeout: 120_000, windowsHide: true });
      if (result.stderr) io.stderr(result.stderr);
      answer = v.json ? result.stdout : formatChecks(JSON.parse(result.stdout) as CheckItem[], !!process.stdout.isTTY && !io.env.NO_COLOR);
    } catch (e) {
      throw new WorkspaceError("CHECK_UNREACHABLE", `no check answered on ${host} (${(e as Error).message}). Check that \`ssh ${host}\` logs in without a password and that rung is installed there (\`rung check --json\` on that PC).`);
    }
    io.stdout(answer);
    return 0;
  }
  const { whitelistHere } = await import("./setup.js");
  const items = await runChecks(realProbes(io.env, () => whitelistHere(io.env)));
  if (v.json) io.stdout(JSON.stringify(items, null, 2) + "\n");
  else {
    io.stdout(formatChecks(items, !!process.stdout.isTTY && !io.env.NO_COLOR));
    io.stdout("rung setup wires rung into your editors and AI agents.\n");
  }
  return 0;
}
