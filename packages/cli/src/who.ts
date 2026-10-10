// SPDX-License-Identifier: BUSL-1.1
// rung who <name>: who writes and who reads a tag, a DB member or a variable, with the block, the line, and where a
// writing block is called from. The commissioning question "what sets this?", from a terminal or an editor task.
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkspaceError } from "@rung/core";
import { LineIndex, WorkspaceIndex, nearest, parseAbsolute, scopedTo, usagesAt, usagesOfPath, type UsageSite, type Usages } from "@rung/lsp";
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

/**
 * An instance DB's uses: its FB's own code (#Jam, run for every instance), `"Belt1_DB".Jam` and the calls through it,
 * not another instance's (`"Belt2_DB".Jam`, a multi-instance `#Belt.Jam` elsewhere). A use reached through a call
 * counts by where it came from.
 */
function ofInstance(index: WorkspaceIndex, db: string, fb: string, u: Usages): Usages {
  const is = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
  const mine = (uri: string, start: number, block?: string): boolean => {
    const doc = index.docs.get(uri);
    for (const b of doc?.parsed?.blocks ?? [])
      for (const r of b.refs) {
        if (r.start !== start && !r.members.some((m) => m.start === start)) continue;
        return r.kind === "global" ? is(r.name, db) : is(b.name, fb);
      }
    // a named argument: the instance the call is made through ("Belt1_DB"(Start := …), #Belt(Start := …))
    const text = doc?.text ?? "";
    for (let i = start - 1, depth = 0; i >= 0 && text[i] !== ";"; i--) {
      if (text[i] === ")") depth++;
      else if (text[i] === "(" && depth-- === 0) {
        const callee = /("[^"]+"|#?[A-Za-z_]\w*)\s*$/.exec(text.slice(0, i))?.[1] ?? "";
        return callee.startsWith('"') && is(callee.slice(1, -1), db);
      }
    }
    return !!block && is(block, fb);
  };
  const keep = (s: UsageSite) => (s.through ? mine(s.through.uri, s.through.start) : mine(s.uri, s.start, s.block));
  return { writes: u.writes.filter(keep), reads: u.reads.filter(keep), ...(u.handedOn ? { handedOn: u.handedOn.filter(keep) } : {}) };
}

/** The first place the code uses an address (`%M10.0` as TIA Portal writes it), in `file` first; `x AT %M10.0` declares. */
function addressUse(index: WorkspaceIndex, key: string, file?: string): { uri: string; start: number } | undefined {
  const uris = [...index.docs.keys()].sort((a, b) => (a === file ? -1 : b === file ? 1 : 0));
  for (const uri of uris) {
    const code = (index.docs.get(uri)?.parsed?.tokens ?? []).filter((t) => t.kind !== "comment");
    const i = code.findIndex((t, j) => t.kind === "absolute" && code[j - 1]?.text.toUpperCase() !== "AT" && parseAbsolute(t.text)?.address === key);
    if (i >= 0) return { uri, start: code[i]!.start };
  }
  return undefined;
}

export async function cmdWho(dir: string, name: string | undefined, v: Record<string, unknown>, io: Io): Promise<number> {
  if (!name?.trim()) throw new WorkspaceError("BAD_ARGUMENT", 'rung who needs a name: a tag, a DB member or a variable (rung who "Line_DB".Speed)');
  const ws = await findWorkspace(dir).catch(() => dir);
  const index = new WorkspaceIndex();
  await index.load(ws);
  const hmiMirrored = index.hmi.tags.length > 0;
  const file = v.file ? pathToFileURL(resolve(io.cwd, String(v.file))).href : undefined;
  const where = (uri: string, start: number) => {
    const text = index.docs.get(uri)?.text ?? "";
    const pos = new LineIndex(text).position(start);
    return { path: relative(ws, fileURLToPath(uri)).split(sep).join("/"), line: pos.line + 1, text: text.split("\n")[pos.line]?.trim() ?? "" };
  };
  const scoped = file ? scopedTo(index, file) : index;
  // an address (%I0.0) means the tag at it, as TIA Portal's cross-reference reads it; without a tag, its uses in the code
  const key = /^%/.test(name.trim()) ? parseAbsolute(name.trim())?.address : undefined;
  const address = key ? scoped.allGlobals().find((g) => g.tag?.address !== undefined && parseAbsolute(g.tag.address)?.address === key) : undefined;
  const untagged = key && !address ? addressUse(index, key, file) : undefined;
  if (/^%/.test(name.trim()) && !address && !untagged) {
    io.stderr(`rung: no PLC tag is at ${name.trim()}, and no code uses it (rung assignments lists every address in use)\n`);
    return 1;
  }
  // (in JSON: tag, the tag's name or null)
  if (address && !v.json) io.stdout(`${name.trim()} is the PLC tag ${address.name}\n`);
  if (untagged && !v.json) io.stdout(`no PLC tag is at ${name.trim()}; the code uses the address itself\n`);
  const parts = untagged ? [name.trim()] : partsOf(address ? address.name : name);
  const head = untagged ? undefined : scoped.global(parts[0]!);
  let r: Usages;
  let declared: { uri?: string; start?: number } | undefined;
  if (untagged) {
    r = usagesAt(index, untagged.uri, untagged.start);
  } else if (parts.length > 1 && head?.block?.kind === "DB") {
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
    r = instance && declared?.uri !== undefined && declared.start !== undefined ? ofInstance(index, head.name, head.block.dbOf!, usagesAt(index, declared.uri, declared.start)) : usagesOfPath(index, head, parts.slice(1));
  } else {
    const at = occurrence(index, parts, file);
    const tag = parts.length === 1 ? head : undefined;
    // a tag whose address is written in the code (a file TIA Portal has not rewritten to the name yet) is used there
    const byAddress = !at && tag?.tag?.address !== undefined ? usagesAt(index, tag.uri, tag.start) : undefined;
    if (!at && !(byAddress && byAddress.writes.length + byAddress.reads.length)) {
      // declared but used nowhere, or a name that is not there at all (a typo)
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
    r = at ? usagesAt(index, at.uri, at.offset) : byAddress!;
  }
  // an input is written by its input module, through the process image, before every cycle
  const input = untagged ? (/^%I/.test(key!) ? key : undefined) : parts.length === 1 && head?.tag?.address && /^%I/i.test(head.tag.address) ? head.tag.address : undefined;
  if (v.json) {
    const site = (s: UsageSite) => ({
      ...where(s.uri, s.start),
      kind: s.kind,
      block: s.block,
      ...(s.whole ? { whole: true } : {}),
      ...(s.through ? { through: { block: s.through.block, param: s.through.param, ...where(s.through.uri, s.through.start) } } : {}),
      ...(s.calledFrom ? { calledFrom: s.calledFrom.map((c) => ({ block: c.block, ...where(c.uri, c.start) })) } : {}),
      ...(s.handedTo ? { handedTo: s.handedTo } : {}),
    });
    io.stdout(JSON.stringify({ name, ...(key ? { tag: address?.name ?? null } : {}), ...(input ? { input } : {}), writes: r.writes.map(site), reads: r.reads.map(site), ...(r.handedOn ? { handedOn: r.handedOn.map(site) } : {}), ...(r.hmi ? { hmi: r.hmi } : {}) }, null, 2) + "\n");
    return 0;
  }
  if (!r.writes.length && !r.reads.length && !r.handedOn?.length && !r.hmi?.length && declared?.uri !== undefined) {
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
  // a call that only hands it on to an in/out or output: what that block does with it is listed above
  if (r.handedOn?.length) io.stdout("handed on\n");
  for (const s of r.handedOn ?? []) {
    line(s);
    io.stdout(`  ${"".padEnd(20)}   to ${s.handedTo!.block} as ${s.handedTo!.param}\n`);
  }
  // an HMI tag bound to it reads it and, from an input field or a button, writes it
  if (r.hmi?.length) io.stdout("HMI\n");
  for (const h of r.hmi ?? []) io.stdout(`  ${h.panel.padEnd(20)} tag ${h.tag} (${h.table}${h.connection ? `, ${h.connection}` : ""})${h.screens.length ? `  on ${h.screens.join(", ")}` : "  on no screen"}\n`);
  io.stdout(`not seen: ${r.hmi === undefined && !hmiMirrored ? "HMI (rung views mirrors Basic/Comfort panels), " : ""}communication blocks, indirect access (pointers, VARIANT, PEEK/POKE)\n`);
  return 0;
}
