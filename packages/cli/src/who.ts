// SPDX-License-Identifier: BUSL-1.1
// rung who <name>: who writes and who reads a tag, a DB member or a variable, with the block, the line, and where a
// writing block is called from. The commissioning question "what sets this?", from a terminal or an editor task.
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkspaceError } from "@rung/core";
import { LineIndex, WorkspaceIndex, nearest, scopedTo, usagesAt, usagesOfPath, type UsageSite } from "@rung/lsp";
import { findWorkspace, type Io } from "./common.js";

/** `"Line_DB".Pump.Running`, `Line_DB.Speed`, `#Speed`, `Levels[2]`: the names without quotes, # or index (any element counts). */
function partsOf(name: string): string[] {
  return name.trim().split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => p.trim().replace(/^#/, "").replace(/\[[^\]]*\]$/, "").replace(/^"|"$/g, ""));
}

/** Where the name (as `partsOf` splits it) occurs: its last part, in `file` first. */
function occurrence(index: WorkspaceIndex, parts: string[], file?: string): { uri: string; offset: number } | undefined {
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
  const where = (uri: string, start: number) => {
    const text = index.docs.get(uri)?.text ?? "";
    const pos = new LineIndex(text).position(start);
    return { path: relative(ws, fileURLToPath(uri)).split(sep).join("/"), line: pos.line + 1, text: text.split("\n")[pos.line]?.trim() ?? "" };
  };
  const parts = partsOf(name);
  const scoped = file ? scopedTo(index, file) : index;
  const head = scoped.global(parts[0]!);
  let r: { writes: UsageSite[]; reads: UsageSite[] };
  let declared: { uri?: string; start?: number } | undefined;
  if (parts.length > 1 && head?.block?.kind === "DB") {
    // a DB member: this DB's, not every member of that name in the data type
    const members = scoped.resolveChain(scoped.membersOfType(head.name), parts.slice(1).map((n) => ({ name: n })));
    const miss = members.findIndex((m) => !m);
    if (miss >= 0) {
      const scope = miss ? scoped.membersOf(members[miss - 1]!) : scoped.membersOfType(head.name);
      const hint = nearest(parts[miss + 1]!, scope.map((m) => m.name));
      io.stderr(`rung: ${head.name} has no ${parts.slice(1, miss + 2).join(".")}${hint ? ` (did you mean ${[...parts.slice(1, miss + 1), hint].join(".")}?)` : ""}\n`);
      return 1;
    }
    declared = members.at(-1);
    // an instance DB is written by its FB's code (#Jam := …): its member's declaration in the FB finds those writes too
    const instance = head.block.dbOf && scoped.global(head.block.dbOf)?.block?.kind === "FB";
    r = instance && declared?.uri !== undefined && declared.start !== undefined ? usagesAt(index, declared.uri, declared.start) : usagesOfPath(index, head, parts.slice(1));
  } else {
    const at = occurrence(index, parts, file);
    if (!at) {
      // declared but used nowhere, or a name that is not there at all (a typo)
      const tag = parts.length === 1 ? head : undefined;
      const local = [...index.docs.values()].flatMap((d) => (d.parsed?.blocks ?? []).flatMap((b) => b.vars.filter((x) => x.name.toUpperCase() === parts.at(-1)!.toUpperCase()).map((x) => ({ uri: d.uri, block: b.name, start: x.start }))))[0];
      if (tag) {
        const w = where(tag.uri, tag.start);
        io.stdout(`${name}: ${tag.tag ? `a PLC tag${tag.tag.address ? ` at ${tag.tag.address}` : ""}` : `a ${tag.kind}`} (${w.path}:${w.line}) that nothing in the workspace uses\n`);
        return 0;
      }
      if (local) {
        const w = where(local.uri, local.start);
        io.stdout(`${name}: declared in ${local.block} (${w.path}:${w.line}), used nowhere\n`);
        return 0;
      }
      const names = [...index.allGlobals().map((g) => g.name), ...[...index.docs.values()].flatMap((d) => (d.parsed?.blocks ?? []).flatMap((b) => b.vars.map((x) => x.name)))];
      const hint = nearest(parts.at(-1)!, new Set(names));
      io.stderr(`rung: no tag, DB member or variable named ${name} in ${ws}${hint ? ` (did you mean ${hint}?)` : ""}\n`);
      return 1;
    }
    r = usagesAt(index, at.uri, at.offset);
  }
  // an input tag is written by its input module, through the process image, before every cycle
  const input = parts.length === 1 && head?.tag?.address && /^%I/i.test(head.tag.address) ? head.tag.address : undefined;
  if (v.json) {
    const site = (s: UsageSite) => ({
      ...where(s.uri, s.start),
      kind: s.kind,
      block: s.block,
      ...(s.whole ? { whole: true } : {}),
      ...(s.through ? { through: { block: s.through.block, param: s.through.param, ...where(s.through.uri, s.through.start) } } : {}),
      ...(s.calledFrom ? { calledFrom: s.calledFrom.map((c) => ({ block: c.block, ...where(c.uri, c.start) })) } : {}),
    });
    io.stdout(JSON.stringify({ name, ...(input ? { input } : {}), writes: r.writes.map(site), reads: r.reads.map(site) }, null, 2) + "\n");
    return 0;
  }
  if (!r.writes.length && !r.reads.length && declared?.uri !== undefined) {
    const w = where(declared.uri, declared.start!);
    io.stdout(`${name}: declared (${w.path}:${w.line}), used nowhere\n`);
    return 0;
  }
  const line = (s: UsageSite) => {
    const w = where(s.uri, s.start);
    io.stdout(`  ${(s.block ?? "").padEnd(20)} ${w.path}:${w.line}  ${w.text}${s.whole ? "   (the whole structure)" : ""}\n`);
    if (s.through) {
      const f = where(s.through.uri, s.through.start);
      io.stdout(`  ${"".padEnd(20)}   as ${s.through.param}, from ${s.through.block} (${f.path}:${f.line})  ${f.text}\n`);
    }
  };
  io.stdout(`${name}: ${r.writes.length} write${r.writes.length === 1 ? "" : "s"}, ${r.reads.length} read${r.reads.length === 1 ? "" : "s"}\n`);
  io.stdout("writes\n");
  if (input) io.stdout(`  the input module at ${input}, into the process image before each cycle\n`);
  else if (!r.writes.length) io.stdout("  nothing in the workspace writes it (an HMI, a communication block or indirect access may)\n");
  for (const s of r.writes) {
    line(s);
    for (const c of s.calledFrom ?? []) {
      const f = where(c.uri, c.start);
      io.stdout(`  ${"".padEnd(20)}   called from ${c.block} (${f.path}:${f.line})\n`);
    }
  }
  if (r.reads.length) io.stdout("reads\n");
  for (const s of r.reads) line(s);
  io.stdout("not seen: HMI, communication blocks, indirect access (pointers, VARIANT, PEEK/POKE)\n");
  return 0;
}
