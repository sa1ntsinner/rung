// SPDX-License-Identifier: BUSL-1.1
// rung who <name>: who writes and who reads a tag, a DB member or a variable, with the block, the line, and where a
// writing block is called from. The commissioning question "what sets this?", from a terminal or an editor task.
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkspaceError } from "@rung/core";
import { LineIndex, WorkspaceIndex, usagesAt, type UsageSite } from "@rung/lsp";
import { findWorkspace, type Io } from "./common.js";

/** Where `name` (as written: Speed, #Speed, "Line_DB".Speed, Line_DB.Speed) occurs: its last part, in `file` first. */
function occurrence(index: WorkspaceIndex, name: string, file?: string): { uri: string; offset: number } | undefined {
  const plain = name.trim().replace(/^"([^"]+)"/, "$1");
  const parts = plain.split(".").map((p) => p.replace(/^#/, "").replace(/^"|"$/g, ""));
  const last = parts.at(-1)!;
  const uris = [...index.docs.keys()].sort((a, b) => (a === file ? -1 : b === file ? 1 : 0));
  for (const uri of uris) {
    const doc = index.docs.get(uri)!;
    for (const block of doc.parsed?.blocks ?? []) {
      for (const ref of block.refs) {
        const chain = [ref.name, ...ref.members.map((m) => m.name)];
        // the reference must spell the whole name (its last part may be followed by more members)
        const at = chain.findIndex((_, i) => parts.every((p, j) => chain[i - parts.length + 1 + j]?.toUpperCase() === p.toUpperCase()));
        if (at < 0 || chain[at]?.toUpperCase() !== last.toUpperCase()) continue;
        return { uri, offset: at === 0 ? ref.start : ref.members[at - 1]!.start };
      }
    }
  }
  return undefined;
}

export async function cmdWho(dir: string, name: string | undefined, v: Record<string, unknown>, io: Io): Promise<number> {
  if (!name?.trim()) throw new WorkspaceError("BAD_ARGUMENT", 'rung who needs a name: a tag, a DB member or a variable (rung who "Line_DB".Speed)');
  const ws = await findWorkspace(dir).catch(() => dir);
  const index = new WorkspaceIndex();
  await index.load(ws);
  const file = v.file ? pathToFileURL(resolve(io.cwd, String(v.file))).href : undefined;
  const at = occurrence(index, name, file);
  if (!at) {
    io.stderr(`rung: ${name} is not used anywhere rung reads in ${ws}\n`);
    return 1;
  }
  const r = usagesAt(index, at.uri, at.offset);
  const where = (uri: string, start: number) => {
    const text = index.docs.get(uri)?.text ?? "";
    const pos = new LineIndex(text).position(start);
    return { path: relative(ws, fileURLToPath(uri)).split(sep).join("/"), line: pos.line + 1, text: text.split("\n")[pos.line]?.trim() ?? "" };
  };
  if (v.json) {
    const site = (s: UsageSite) => ({ ...where(s.uri, s.start), kind: s.kind, block: s.block, ...(s.calledFrom ? { calledFrom: s.calledFrom.map((c) => ({ block: c.block, ...where(c.uri, c.start) })) } : {}) });
    io.stdout(JSON.stringify({ name, writes: r.writes.map(site), reads: r.reads.map(site) }, null, 2) + "\n");
    return 0;
  }
  io.stdout(`${name}: ${r.writes.length} write${r.writes.length === 1 ? "" : "s"}, ${r.reads.length} read${r.reads.length === 1 ? "" : "s"}\n`);
  io.stdout("writes\n");
  if (!r.writes.length) io.stdout("  nothing in the workspace writes it (an HMI, a communication block or indirect access may)\n");
  for (const s of r.writes) {
    const w = where(s.uri, s.start);
    io.stdout(`  ${(s.block ?? "").padEnd(20)} ${w.path}:${w.line}  ${w.text}\n`);
    for (const c of s.calledFrom ?? []) {
      const f = where(c.uri, c.start);
      io.stdout(`  ${"".padEnd(20)}   called from ${c.block} (${f.path}:${f.line})\n`);
    }
  }
  if (r.reads.length) io.stdout("reads\n");
  for (const s of r.reads) {
    const w = where(s.uri, s.start);
    io.stdout(`  ${(s.block ?? "").padEnd(20)} ${w.path}:${w.line}  ${w.text}\n`);
  }
  io.stdout("not seen: HMI, communication blocks, indirect access (pointers, VARIANT, PEEK/POKE)\n");
  return 0;
}
