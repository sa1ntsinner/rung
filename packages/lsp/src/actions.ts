// SPDX-License-Identifier: BUSL-1.1
// Quick fixes like TIA Portal's: declare a local that is used but not declared, give a function block that is
// called without an instance a single instance (a new instance DB) or a multi-instance, and define a PLC tag.
import { escapeSegment } from "@rung/core";
import { lex } from "./lexer.js";
import type { BlockModel, Ref } from "./parser.js";
import { deviceOfUri, scopedTo, tagTableFor, type WorkspaceIndex } from "./workspace.js";
import { TYPE_BITS, assignmentList } from "./assignments.js";
import { calledWithoutInstance, scopeDecl } from "./features.js";
import { callSites, defaultArgument, missingParams, unknownArgs } from "./calls.js";

export interface EditAt {
  uri: string;
  start: number;
  end: number;
  newText: string;
}

export interface QuickFix {
  title: string;
  /** Diagnostic code the fix answers. */
  code: "UNDECLARED" | "NO_INSTANCE" | "UNKNOWN_PARAMETER" | "MISSING_PARAMETER" | "UNKNOWN_GLOBAL";
  edits: EditAt[];
  /** A new file (an instance DB); rung sync creates it in TIA Portal. */
  create?: { uri: string; text: string };
  preferred?: boolean;
}

export function codeActions(index: WorkspaceIndex, uri: string, start: number, end: number): QuickFix[] {
  index = scopedTo(index, uri); // names mean the objects of this file's PLC
  const doc = index.docs.get(uri);
  if (!doc?.parsed || !/\.scl$/i.test(uri)) return [];
  const out: QuickFix[] = [];
  for (const block of doc.parsed.blocks) {
    if (end < block.start || start > block.end) continue;
    for (const ref of block.refs) {
      if (ref.end < start || ref.start > end) continue;
      if (ref.kind === "local" && !scopeDecl(index, uri, block, ref.name) && ref.name.toUpperCase() !== block.name.toUpperCase()) out.push(...declareFixes(index, doc.text, uri, block, ref));
      if (calledWithoutInstance(index, ref)) out.push(...instanceFixes(index, doc.text, uri, block, ref));
      if (canBeATag(index, ref)) out.push(...tagFixes(index, doc.text, uri, block, ref));
    }
  }
  // TIA Portal's "Update block call": arguments the callee no longer has, parameters an FC call leaves out
  for (const site of callSites(index, uri, (b, n) => scopeDecl(index, uri, b, n))) {
    site.args.forEach((a, i) => {
      if (!unknownArgs(site).includes(a) || a.nameEnd! < start || a.nameStart! > end) return;
      // with its comma: the one after it, or for the last argument the one before
      const next = site.args[i + 1];
      const prev = site.args[i - 1];
      const range = next ? { start: a.start, end: next.start } : prev ? { start: prev.end, end: a.end } : { start: a.start, end: a.end };
      out.push({ title: `Remove the argument ${a.name} (${site.callee.name} has no such parameter)`, code: "UNKNOWN_PARAMETER", edits: [{ uri, ...range, newText: "" }], preferred: true });
    });
    const missing = missingParams(site);
    if (missing.length && site.ref.end >= start && site.ref.start <= end) {
      const text = (site.args.length ? ", " : "") + missing.map((p) => `${p.name} := ${defaultArgument(p)}`).join(", ");
      out.push({ title: `Add the missing parameters of ${site.callee.name}: ${missing.map((p) => p.name).join(", ")}`, code: "MISSING_PARAMETER", edits: [{ uri, start: site.close, end: site.close, newText: text }], preferred: true });
    }
  }
  return out.filter((f, i) => out.findIndex((g) => g.title === f.title) === i);
}

function declareFixes(index: WorkspaceIndex, text: string, uri: string, block: BlockModel, ref: Ref): QuickFix[] {
  const type = guessType(index, text, uri, block, ref);
  const decl = `${ref.name} : ${type};`;
  // a temporary changes no interface and reinitialises nothing on download: the first choice
  const fixes: QuickFix[] = [{ title: `Declare #${ref.name} : ${type} as a temporary (VAR_TEMP)`, code: "UNDECLARED", edits: [declare(text, uri, block, "VAR_TEMP", decl)], preferred: true }];
  if (block.kind === "FB") fixes.push({ title: `Declare #${ref.name} : ${type} as a static (VAR, kept between calls)`, code: "UNDECLARED", edits: [declare(text, uri, block, "VAR", decl)] });
  return fixes;
}

function instanceFixes(index: WorkspaceIndex, text: string, uri: string, block: BlockModel, ref: Ref): QuickFix[] {
  const fb = ref.name;
  const fixes: QuickFix[] = [];
  let db = `${fb}_DB`;
  for (let i = 1; index.global(db); i++) db = `${fb}_DB_${i}`;
  const fbDoc = index.docs.get(index.global(fb)!.uri)?.text ?? "";
  const optimized = /S7_Optimized_Access\s*:=\s*'FALSE'/i.test(fbDoc) ? "FALSE" : "TRUE";
  fixes.push({
    title: `Create the instance DB "${db}" and call "${fb}" through it`,
    code: "NO_INSTANCE",
    preferred: true,
    create: {
      uri: uri.slice(0, uri.lastIndexOf("/") + 1) + encodeURIComponent(escapeSegment(db)) + ".db",
      text: `DATA_BLOCK "${db}"\n{ S7_Optimized_Access := '${optimized}' }\nVERSION : 0.1\nNON_RETAIN\n"${fb}"\n\nBEGIN\n\nEND_DATA_BLOCK\n`,
    },
    edits: [{ uri, start: ref.start, end: ref.end, newText: `"${db}"` }],
  });
  if (block.kind === "FB") {
    let inst = `${fb}_Instance`;
    for (let i = 1; block.vars.some((v) => v.name.toUpperCase() === inst.toUpperCase()); i++) inst = `${fb}_Instance_${i}`;
    fixes.push({
      title: `Call "${fb}" as the multi-instance #${inst} of ${block.name}`,
      code: "NO_INSTANCE",
      edits: [declare(text, uri, block, "VAR", `${inst} : "${fb}";`), { uri, start: ref.start, end: ref.end, newText: `#${inst}` }],
    });
  }
  return fixes;
}

/** A "name" the workspace does not know, used as a value: TIA Portal's "Define tag" makes it a PLC tag. */
export function canBeATag(index: WorkspaceIndex, ref: Ref): boolean {
  return ref.kind === "global" && ref.access !== "call" && !ref.members.length && !ref.name.includes("~") && !index.global(ref.name) && !index.enumTypesWith(ref.name).length;
}

/** A new line in the PLC's tag table (.tags.st) at the next free bit memory address. */
function tagFixes(index: WorkspaceIndex, text: string, uri: string, block: BlockModel, ref: Ref): QuickFix[] {
  const table = tagTableFor(index, uri);
  const tableText = table && index.docs.get(table.uri)?.text;
  if (!table || tableText === undefined) return [];
  const type = guessType(index, text, uri, block, ref);
  const bits = TYPE_BITS[type.toUpperCase()];
  if (!bits) return []; // a String or a PLC data type needs its size chosen in TIA Portal
  const address = freeMemory(index, bits, table.uri);
  if (!address) return []; // bit memory holds a tag whose size rung cannot tell: TIA Portal's Define tag chooses
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.name) ? ref.name : `"${ref.name}"`;
  // before the END_VAR of the tags (VAR_GLOBAL, not the constants)
  const section = /^[ \t]*VAR_GLOBAL[ \t]*(\r?\n|$)/m.exec(tableText);
  const close = section ? /^[ \t]*END_VAR\b/m.exec(tableText.slice(section.index + section[0].length)) : null;
  const edit: EditAt = close
    ? { uri: table.uri, start: section!.index + section![0].length + close.index, end: section!.index + section![0].length + close.index, newText: `    ${name} AT ${address} : ${type};\n` }
    : { uri: table.uri, start: tableText.length, end: tableText.length, newText: `${tableText.endsWith("\n") || !tableText ? "" : "\n"}VAR_GLOBAL\n    ${name} AT ${address} : ${type};\nEND_VAR\n` };
  return [{ title: `Create the PLC tag "${ref.name}" : ${type} at ${address} in ${table.name}`, code: "UNKNOWN_GLOBAL", edits: [edit], preferred: true }];
}

/**
 * Bit memory of the table's PLC after the highest byte in use (never one a tag or the code uses); bits share the
 * last byte of bits. None when a bit memory tag has a type of unknown size (a PLC data type, a String): its end
 * cannot be known.
 */
function freeMemory(index: WorkspaceIndex, bits: number, tableUri: string): string | undefined {
  const device = deviceOfUri(tableUri);
  for (const g of index.allGlobals())
    if (deviceOfUri(g.uri) === device && g.tag?.address && /^%M/i.test(g.tag.address) && !TYPE_BITS[g.tag.dataType.toUpperCase()]) return undefined;
  const used = assignmentList(index, device).items.filter((a) => a.area === "M");
  let top = -1;
  for (const a of used) top = Math.max(top, a.byte + Math.max(1, a.bits / 8) - 1);
  if (bits === 1) {
    const last = used.filter((a) => a.byte <= top && a.byte + Math.max(1, a.bits / 8) - 1 >= top);
    if (top >= 0 && last.every((a) => a.bits === 1)) {
      const taken = new Set(last.map((a) => a.bit));
      for (let b = 0; b < 8; b++) if (!taken.has(b)) return `%M${top}.${b}`;
    }
    return `%M${top + 1}.0`;
  }
  let at = top + 1;
  if (bits >= 16 && at % 2) at++; // words on even bytes, as S7 programs keep them
  return bits === 64 ? `%M${at}.0` : `%M${({ 8: "B", 16: "W", 32: "D" } as Record<number, string>)[bits]}${at}`;
}

/** Declaration sections in the order TIA Portal writes them. */
const ORDER = ["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR", "VAR_TEMP", "VAR CONSTANT"];

/** Inserts a declaration into the block's section, adding the section where TIA Portal would put it. */
function declare(text: string, uri: string, block: BlockModel, section: "VAR" | "VAR_TEMP", decl: string): EditAt {
  const tokens = lex(text.slice(0, block.end)).tokens.filter((t) => t.start >= block.start && t.kind !== "comment");
  const begin = tokens.findIndex((t) => t.kind === "ident" && t.upper === "BEGIN");
  const header = begin < 0 ? tokens : tokens.slice(0, begin);
  const sections: { name: string; at: number; end?: number }[] = [];
  header.forEach((t, i) => {
    if (t.kind !== "ident") return;
    if (/^VAR(_INPUT|_OUTPUT|_IN_OUT|_TEMP)?$/.test(t.upper)) sections.push({ name: t.upper === "VAR" && header[i + 1]?.upper === "CONSTANT" ? "VAR CONSTANT" : t.upper, at: t.start });
    else if (t.upper === "END_VAR" && sections.length) sections[sections.length - 1]!.end = t.start;
  });
  const lineStart = (at: number) => text.lastIndexOf("\n", at - 1) + 1;
  const own = sections.find((s) => s.name === section && s.end !== undefined);
  if (own) {
    const at = lineStart(own.end!);
    const prev = text.slice(lineStart(at - 1), at - 1);
    const indent = /^\s+\S/.test(prev) && !/^\s*VAR/i.test(prev.trim()) ? /^\s*/.exec(prev)![0] : "      ";
    return { uri, start: at, end: at, newText: `${indent}${decl}\n` };
  }
  const after = ORDER.slice(ORDER.indexOf(section) + 1);
  const next = sections.find((s) => after.includes(s.name));
  const at = next ? lineStart(next.at) : begin >= 0 ? lineStart(tokens[begin]!.start) : block.end;
  return { uri, start: at, end: at, newText: `   ${section} \n      ${decl}\n   END_VAR\n${next ? "" : "\n"}` };
}

/** A type from how the variable is used; Bool when nothing tells. */
function guessType(index: WorkspaceIndex, text: string, uri: string, block: BlockModel, ref: Ref): string {
  const localType = (name: string) => scopeDecl(index, uri, block, name)?.type;
  if (ref.access === "write") {
    const rhs = /^\s*:=\s*([^;]*);/.exec(text.slice(ref.end))?.[1]?.trim() ?? "";
    if (/^(TRUE|FALSE)$/i.test(rhs) || /(<|>|=|\bAND\b|\bOR\b|\bNOT\b|\bXOR\b)/i.test(rhs)) return "Bool";
    if (/^-?\d+$/.test(rhs)) return "Int";
    if (/^-?\d+\.\d*(e[+-]?\d+)?$/i.test(rhs)) return "Real";
    if (/^(T|TIME)#/i.test(rhs)) return "Time";
    if (/^(LT|LTIME)#/i.test(rhs)) return "LTime";
    if (/^'/.test(rhs)) return "String";
    const other = /^#(\w+)$/.exec(rhs);
    if (other) return localType(other[1]!) ?? "Bool";
  }
  const target = /#(\w+)\s*:=\s*$/.exec(text.slice(Math.max(0, ref.start - 80), ref.start));
  if (target && /^\s*;/.test(text.slice(ref.end))) return localType(target[1]!) ?? "Bool";
  return "Bool";
}
