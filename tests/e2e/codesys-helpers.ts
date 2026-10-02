// SPDX-License-Identifier: BUSL-1.1
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../packages/cli/src/main.js";
import { findCodesys } from "../../packages/cli/src/codesys.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));

export function createCodesysFixture(project: string): void {
  const cds = findCodesys();
  if (!cds) throw new Error("CODESYS is not installed");
  const r = spawnSync(cds.exe, [`--profile="${cds.profile}"`, "--noUI", `--runscript="${join(repo, "tools", "fixtures", "codesys", "new_fixture.py")}"`], {
    env: { ...process.env, RUNG_CODESYS_FIXTURE: project },
    windowsVerbatimArguments: true,
    windowsHide: true,
    timeout: 300_000,
  });
  const log = existsSync(project + ".log") ? readFileSync(project + ".log", "utf8") : `(no log; exit ${r.status})`;
  if (!/^ok/.test(log)) throw new Error(`fixture generation failed:\n${log}`);
}

export function codesysWorkspace(dir: string) {
  const out: string[] = [];
  const io = { cwd: dir, stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), env: process.env };
  const run = async (...args: string[]) => {
    out.length = 0;
    const code = await main(args, io);
    return { code, text: out.join("") };
  };
  const file = (rel: string) => join(dir, ...rel.split("/"));
  return { io, run, file };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
