// SPDX-License-Identifier: BUSL-1.1
// rung lint [dir] [--file <f>]...: the language server's checks of the files, without an editor or TIA Portal.
// Exit 1 when any error is found (for a check before rung sync, or CI); warnings only print.
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkspaceIndex, diagnostics } from "@rung/lsp";
import { findWorkspace, type Io } from "./common.js";

export async function cmdLint(dir: string | undefined, files: string[], json: boolean, io: Io): Promise<number> {
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
  if (json) io.stdout(JSON.stringify({ files: wanted.length || index.docs.size, errors, warnings: items.length - errors, items }, null, 2) + "\n");
  else {
    for (const d of items) io.stdout(`${d.path}:${d.line}: ${d.severity}${d.code ? ` ${d.code}` : ""}: ${d.message}\n`);
    io.stdout(`${wanted.length || index.docs.size} files, ${errors} error(s), ${items.length - errors} other\n`);
  }
  return errors ? 1 : 0;
}
