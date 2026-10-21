// SPDX-License-Identifier: BUSL-1.1
// rung lint [dir] [--file <f>]... [--max-warnings <n>]: the language server's checks of the files, without an editor
// or TIA Portal. Exit 1 when any error is found (for a check before rung sync, or CI), or more warnings than n.
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkspaceError } from "@rung/core";
import { WorkspaceIndex, diagnostics } from "@rung/lsp";
import { findWorkspace, type Io } from "./common.js";

export async function cmdLint(dir: string | undefined, files: string[], json: boolean, io: Io, maxWarnings?: string): Promise<number> {
  const most = maxWarnings === undefined ? Infinity : Number(maxWarnings);
  if (maxWarnings !== undefined && (!/^\d+$/.test(maxWarnings) || !Number.isSafeInteger(most))) throw new WorkspaceError("BAD_ARGUMENT", `--max-warnings is a number of warnings, such as 0; got ${maxWarnings}`);
  // a folder of sources without rung.toml (a library, a checkout) is checked as it is
  const root = await findWorkspace(resolve(io.cwd, dir ?? ".")).catch(() => resolve(io.cwd, dir ?? "."));
  const index = new WorkspaceIndex();
  await index.load(root);
  const wanted = files.map((f) => pathToFileURL(resolve(io.cwd, f)).href);
  const missing = wanted.filter((u) => !index.docs.has(u));
  if (missing.length) {
    io.stderr(`rung: not a source file of ${root}: ${missing.map((u) => fileURLToPath(u)).join(", ")}\n`);
    return 1;
  }
  const where = (uri: string) => relative(io.cwd, fileURLToPath(uri)).replace(/\\/g, "/");
  const items = (wanted.length ? wanted : [...index.docs.keys()].sort()).flatMap((uri) => {
    const doc = index.docs.get(uri)!;
    return diagnostics(index, uri).map((d) => ({ path: where(uri), line: doc.lines.position(d.start).line + 1, severity: d.severity, code: d.code, message: d.message }));
  });
  const errors = items.filter((d) => d.severity === "error").length;
  const warnings = items.filter((d) => d.severity === "warning").length;
  const notes = items.length - errors - warnings;
  const count = wanted.length || index.docs.size;
  const many = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  if (json) io.stdout(JSON.stringify({ files: count, errors, warnings, notes, items }, null, 2) + "\n");
  else {
    for (const d of items) io.stdout(`${d.path}:${d.line}: ${d.severity}${d.code ? ` ${d.code}` : ""}: ${d.message}\n`);
    io.stdout(`${many(errors, "error")}, ${many(warnings, "warning")}${notes ? `, ${many(notes, "note")}` : ""} in ${many(count, "file")}${warnings > most ? ` (more than --max-warnings ${most})` : ""}\n`);
  }
  return errors || warnings > most ? 1 : 0;
}
