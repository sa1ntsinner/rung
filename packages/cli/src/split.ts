// SPDX-License-Identifier: BUSL-1.1
// rung split [file]...: a source with several objects (TIA Portal's "Generate source from blocks", a library from
// GitHub) becomes one file per object, at the path rung keeps that object; a file under plc/ holds exactly one. A file
// named otherwise than its one object is renamed. Without files: every such file under plc/.
import { readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { addressToPath, pathToAddress, WorkspaceError } from "@rung/core";
import { parse } from "@rung/lsp";
import { findWorkspace, type Io } from "./common.js";

const SOURCE = /\.(scl|db|udt)$/i;

export async function cmdSplit(files: string[], io: Io): Promise<number> {
  const ws = await findWorkspace(io.cwd);
  const rel = (p: string) => relative(ws, p).split(sep).join("/");
  const all = files.length
    ? files.map((f) => resolve(io.cwd, f))
    : ((await readdir(join(ws, "plc"), { recursive: true }).catch(() => [])) as string[]).filter((f) => SOURCE.test(f)).map((f) => join(ws, "plc", f));
  let split = 0;
  for (const file of all) {
    const path = rel(file);
    const at = pathToAddress(path);
    if (!at) throw new WorkspaceError("BAD_ARGUMENT", `${path} is not a source file under plc/<PLC>/`);
    const text = await readFile(file, "utf8");
    const parsed = parse(text);
    const blocks = parsed.blocks;
    if (!blocks.length) continue;
    if (blocks.length === 1 && blocks[0]!.name === at.address.name) continue;
    if (parsed.diagnostics.some((d) => d.severity === "error")) {
      io.stderr(`${path}: not split, it has syntax errors (rung lint ${path} shows them)\n`);
      continue;
    }
    // each object with the comments before it; the file's own first lines go with the first
    const pieces = blocks.map((b, i) => {
      const kind = b.kind === "UDT" ? "type" : "block";
      const form = b.kind === "UDT" ? "udt" : b.kind === "DB" ? "db" : "scl";
      const to = addressToPath({ ...at.address, kind, name: b.name }, form);
      const from = i === 0 ? 0 : blocks[i - 1]!.end;
      return { to, text: text.slice(from, b.end).replace(/^\s*\n/, "").trimEnd() + "\n" };
    });
    // the source's own name (in any letter case: Windows keeps one file for backup.scl and Backup.scl) is no clash
    const same = (p: { to: string }) => p.to.toLowerCase() === path.toLowerCase();
    const taken = pieces.find((p) => !same(p) && existsSync(join(ws, p.to)));
    if (taken) {
      io.stderr(`${path}: not split, ${taken.to} is already there\n`);
      continue;
    }
    for (const p of pieces.filter((p) => !same(p))) {
      await mkdir(dirname(join(ws, p.to)), { recursive: true });
      await writeFile(join(ws, p.to), p.text);
    }
    // the source goes only now, its text in hand: then the piece that has its name, in that name's letter case
    await rm(file);
    for (const p of pieces.filter(same)) await writeFile(join(ws, p.to), p.text);
    io.stdout(`${path} → ${pieces.map((p) => p.to).join(", ")}\n`);
    split++;
  }
  if (!split) io.stdout("nothing to split: every source holds one object, named as its file\n");
  return 0;
}
