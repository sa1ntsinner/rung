// SPDX-License-Identifier: BUSL-1.1
import { lex, parseAbsolute, type Member, type WorkspaceIndex } from "@rung/lsp";
import { SimError } from "./runtime.js";

export interface NativeScalarBinding { name: string; bitOffset: number; bits: number; type: string }

/** Initial native producer supports complete scalar instance state only. */
export function verifyNativeScalars(index: WorkspaceIndex, uri: string, bindings: NativeScalarBinding[]): void {
  const doc = index.docs.get(uri), block = doc?.parsed?.blocks[0];
  if (!doc || !block || block.kind !== "FB" || !Array.isArray(bindings) || bindings.length > 100_000)
    throw new SimError("Invalid native scalar declarations");
  const widths: Record<string, number> = { BOOL: 1, SINT: 8, USINT: 8, BYTE: 8, INT: 16, UINT: 16, WORD: 16,
    DINT: 32, UDINT: 32, DWORD: 32, REAL: 32, LINT: 64, ULINT: 64, LWORD: 64, LREAL: 64 };
  // ponytail: local constants need native initializer matching before they can enter replay.
  if (block.vars.some(v => v.section === "Constant")) throw new SimError("Native local constant source is unavailable");
  const expected = new Map(block.vars.filter(v => v.section !== "Temp" && v.section !== "Constant").map(v => [v.name.toUpperCase(), v]));
  const tokens = lex(doc.text.slice(block.bodyStart, block.end)).tokens.filter(t => t.kind !== "comment");
  if (tokens.some((t, i) => t.kind === "ident" && ["RD_SYS_T", "RD_LOC_T", "RUNTIME"].includes(t.upper) && tokens[i + 1]?.text === "("))
    throw new SimError("Native CPU clock state is unavailable");
  // ponytail: instance scalars only; external memory and user calls need native dependency matching.
  if (tokens.some(t => t.kind === "absolute" && parseAbsolute(t.text) || t.kind === "ident" && index.global(t.text, uri)))
    throw new SimError("Native external state or dependency source is unavailable");
  // DB members and tags read by name are captured next to the sample; anything else a global does refuses there
  nativeGlobalReads(index, uri);
  // TEMP needs no capture: the replay refuses a temporary read before the cycle wrote it (Simulator.guardTemps)
  const names = new Set<string>();
  for (const binding of bindings) {
    if (!binding || typeof binding.name !== "string" || names.has(binding.name.toUpperCase())) throw new SimError("Duplicate or invalid native scalar binding");
    const name = binding.name.toUpperCase(); names.add(name);
    const declaration = expected.get(name), type = /^\{Scalar"[0-9]+"([A-Za-z0-9_]+)\}$/.exec(binding.type)?.[1]?.toUpperCase();
    if (!declaration || declaration.members?.length || declaration.isArray || !type || type !== declaration.type.trim().toUpperCase()
      || widths[type] === undefined || widths[type] !== binding.bits) throw new SimError(`${name}: native scalar type differs or is unsupported`);
    if (!Number.isSafeInteger(binding.bitOffset) || binding.bitOffset < 0 || binding.bitOffset > 0xffffffff - binding.bits)
      throw new SimError("Invalid native scalar offset");
  }
  if ([...expected.keys()].some(name => !names.has(name))) throw new SimError("Missing native scalar state");
  const intervals = [...bindings].sort((a, b) => a.bitOffset - b.bitOffset);
  if (intervals.some((binding, i) => i > 0 && binding.bitOffset < intervals[i - 1]!.bitOffset + intervals[i - 1]!.bits))
    throw new SimError("Native scalar addresses overlap");
}

/** Body gate only; native interface/state and session provenance must also be verified. */
export function verifyNativeBody(index: WorkspaceIndex, uri: string, nativeBody: string): void {
  const doc = index.docs.get(uri), block = doc?.parsed?.blocks[0];
  if (!doc || !block || block.kind !== "FB" || block.lad || block.stl || block.bodyStart === undefined)
    throw new SimError("Native source requires an SCL FB");
  if (typeof nativeBody !== "string" || nativeBody.length > 1_048_576 || doc.text.length > 1_048_576)
    throw new SimError("Native source size limit exceeded");
  const tokens = (text: string) => {
    const result = lex(text);
    if (result.errors.length) throw new SimError("Invalid native source tokens");
    return result.tokens.filter(t => t.kind !== "comment" && t.kind !== "eof");
  };
  const mirror = tokens(doc.text.slice(block.bodyStart, block.end));
  if (mirror.at(-1)?.upper !== "END_FUNCTION_BLOCK") throw new SimError("Incomplete mirrored source");
  mirror.pop();
  const native = tokens(nativeBody);
  if (native.length !== mirror.length || native.some((t, i) => t.kind !== mirror[i]!.kind || t.upper !== mirror[i]!.upper))
    throw new SimError("Native body differs from mirrored source");
}

/**
 * The DB members and tags an FB body reads by name, in reading order: what a sample reads next to the native capture.
 * Writes to globals, calls, indexed and whole-structure reads refuse: a sample cannot capture those by name yet.
 */
export function nativeGlobalReads(index: WorkspaceIndex, uri: string): string[] {
  const doc = index.docs.get(uri), block = doc?.parsed?.blocks[0];
  if (!doc || !block || block.kind !== "FB" || block.bodyStart === undefined) throw new SimError("Native source requires an SCL FB");
  const out: string[] = [];
  for (const r of [...block.refs].filter(r => r.start >= block.bodyStart! && r.kind !== "local").sort((a, b) => a.start - b.start)) {
    const g = index.global(r.name, uri);
    // INT_TO_DINT(…), TON on #inst: instructions the replay runs itself; a user block called is a dependency
    if (r.kind === "call" && !g) continue;
    if (r.kind === "call" || r.access === "call" || !g || (g.block && g.block.kind !== "DB") || (!g.block && !g.tag))
      throw new SimError(`"${r.name}": native external state or dependency source is unavailable`);
    if (r.access === "write") throw new SimError(`"${r.name}": program status does not replay writes to globals yet`);
    if (r.members.some(m => !/^[A-Za-z_]\w*$/.test(m.name))) throw new SimError(`"${r.name}": quoted member names are not captured yet`);
    const path = `"${g.name}"` + r.members.map(m => `.${m.name}`).join("");
    if (doc.text[r.members.at(-1)?.end ?? r.end] === "[") throw new SimError(`${path}: indexed global reads are not captured by name yet`);
    let list: Member[] = g.tag ? index.membersOfType(g.tag.dataType.replace(/^"|"$/g, "")) : index.membersOfType(g.name);
    let leaf: Member | undefined;
    for (const m of r.members) {
      leaf = list.find(x => x.name.toUpperCase() === m.name.toUpperCase());
      if (!leaf) throw new SimError(`${path}: unknown member`);
      list = leaf.isArray ? [] : index.membersOf(leaf);
    }
    if (list.length || leaf?.isArray || (g.block && !r.members.length))
      throw new SimError(`${path}: a whole structure or array is read; program status captures single values`);
    if (!out.includes(path)) out.push(path);
  }
  if (out.length > 256) throw new SimError("Capture state limit exceeded");
  return out;
}