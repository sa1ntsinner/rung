// SPDX-License-Identifier: BUSL-1.1
// rung format: SCL files formatted as TIA Portal writes them (packages/lsp format.ts), so a sync and a pull bring
// them back unchanged. --check only lists the files that would change (CI, pre-commit).
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { formatSclOrWhy } from "@rung/lsp";
import { writeFileAtomic } from "@rung/core";
import type { Io } from "./common.js";

async function sclFiles(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return /\.scl$/i.test(path) ? [path] : [];
  const out: string[] = [];
  for (const e of await readdir(path, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(path, e.name);
    if (e.isDirectory()) out.push(...(await sclFiles(p)));
    else if (/\.scl$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

export async function cmdFormat(path: string, check: boolean, io: Io): Promise<number> {
  const files = await sclFiles(path).catch(() => undefined);
  if (!files) {
    io.stderr(`rung: no file or folder at ${path}\n`);
    return 1;
  }
  let changed = 0;
  let skipped = 0;
  for (const f of files) {
    const text = await readFile(f, "utf8");
    const r = formatSclOrWhy(text);
    const shown = relative(io.cwd, f) || f;
    if ("reason" in r) {
      skipped++;
      io.stderr(`rung: ${shown}: left as it is: ${r.reason}\n`);
      continue;
    }
    const formatted = r.text;
    if (formatted === text) continue;
    changed++;
    if (check) io.stdout(`${shown}\n`);
    else await writeFileAtomic(f, formatted);
  }
  if (check) {
    const n = (k: number) => `${k} SCL file${k === 1 ? "" : "s"}`;
    io.stdout(changed ? `${changed} of ${n(files.length)} not formatted as TIA Portal writes them (rung format fixes them)${skipped ? `; ${skipped} left as they are` : ""}\n` : `${n(files.length)} formatted as TIA Portal writes them${skipped ? `, ${skipped} left as they are (above)` : ""}\n`);
    return changed || skipped ? 1 : 0;
  }
  io.stdout(`formatted ${changed} of ${files.length} SCL file${files.length === 1 ? "" : "s"}${skipped ? `, ${skipped} left as they are` : ""}\n`);
  return 0;
}
