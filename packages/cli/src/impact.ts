// SPDX-License-Identifier: BUSL-1.1
// rung impact <file>: what the interface change of a block affects, against the version TIA Portal has (the last
// synced one): calls that break, instance DBs TIA Portal reinitialises on download, unit tests that name what went.
// From the files alone, read only; exit 2 when something breaks (for a check before rung sync, or CI).
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkspaceIndex, baseText, interfaceImpact, workspaceTests, type Impact } from "@rung/lsp";
import { findWorkspace, type Io } from "./common.js";

const SECTION: Record<string, string> = { Input: "input", Output: "output", InOut: "in/out", Static: "static", Member: "member", Return: "return value" };

function report(r: Impact, where: (uri: string) => string): string {
  const out = [`${r.block} (${r.kind}): the interface changed against the version TIA Portal has`];
  for (const c of r.changes)
    out.push(
      `  ${c.kind === "removed" ? "-" : c.kind === "added" ? "+" : "~"} ${SECTION[c.section] ?? c.section} ${c.kind === "reordered" ? `order now ${c.name}` : c.kind === "renamed" ? `${c.name} → ${c.to} : ${c.after}` : c.section === "Return" ? `${c.before} → ${c.after}` : `${c.name} : ${c.kind === "retyped" ? `${c.before} → ${c.after}` : (c.after ?? c.before)}`}${c.kind === "removed" || c.kind === "added" ? `  ${c.kind}` : ""}`,
    );
  if (r.calls.length) {
    out.push(`calls (${r.calls.length}):`);
    for (const c of r.calls) out.push(`  ${where(c.uri)}:${c.line}  ${c.block}: ${c.problems.length ? c.problems.join("; ") : "compiles again, unchanged"}`);
  }
  if (r.instances.length) {
    out.push("instance data that starts over from start values on download (TIA Portal reinitialises it, unless the block has memory reserve for a download without reinitialisation):");
    for (const i of r.instances) out.push(`  ${i.name}${i.via && !i.name.startsWith(`${i.via}.`) ? `  (through ${i.via})` : ""}  ${where(i.uri)}`);
  } else if (r.reinit) out.push("no instance DB in the workspace holds it");
  for (const t of r.tests) out.push(`  ${where(t.uri)}: ${t.problems.length ? t.problems.join("; ") : "names none of what went"}`);
  if (r.tests.length) out.splice(out.length - r.tests.length, 0, "tests:");
  return out.join("\n") + "\n";
}

export async function cmdImpact(target: string | undefined, json: boolean, io: Io): Promise<number> {
  if (!target) {
    io.stderr("rung: usage: rung impact <block file> [--json]   e.g. rung impact plc/PLC_1/blocks/FB_Motor.scl\n");
    return 1;
  }
  const file = resolve(io.cwd, target);
  const ws = await findWorkspace(io.cwd);
  const rel = relative(ws, file).replace(/\\/g, "/");
  const uri = pathToFileURL(file).href;
  const before = await baseText(ws, uri);
  if (before === undefined) {
    io.stderr(`rung: ${rel} is not in TIA Portal yet (never synced): nothing uses it there\n`);
    return 1;
  }
  const index = new WorkspaceIndex();
  await index.load(ws);
  if (!index.docs.get(uri)) index.set(uri, await readFile(file, "utf8"), 0);
  const r = interfaceImpact(index, uri, before, await workspaceTests(ws));
  if (!r) {
    io.stderr(`rung: ${rel} holds no FB, FC or PLC data type\n`);
    return 1;
  }
  const breaks = r.calls.some((c) => c.problems.length) || r.tests.some((t) => t.problems.length);
  if (json) io.stdout(JSON.stringify(r, null, 2) + "\n");
  else if (!r.changes.length) io.stdout(`${r.block}: the interface is the one TIA Portal has; nothing outside the block is affected\n`);
  else io.stdout(report(r, (u) => relative(io.cwd, fileURLToPath(u)).replace(/\\/g, "/")));
  return breaks ? 2 : 0;
}
