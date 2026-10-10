// SPDX-License-Identifier: BUSL-1.1
import { lex, parseAbsolute, type Member, type VarDecl, type WorkspaceIndex } from "@rung/lsp";
import { SimError, Simulator, splitArrayType } from "./runtime.js";

export interface NativeScalarBinding { name: string; bitOffset: number; bits: number; type: string }
/** A local constant as the PLC compiled it (the debug info's immediate value). */
export interface NativeConstant { name: string; type: string; value: string }
/** A user FC as the PLC holds it: its body text and the constants it was compiled with. */
export interface NativeFunction { name: string; bodies: string[]; constants: NativeConstant[] }

/** Initial native producer supports complete scalar instance state only. */
export function verifyNativeScalars(index: WorkspaceIndex, uri: string, bindings: NativeScalarBinding[], constants?: NativeConstant[], functions?: NativeFunction[]): void {
  const doc = index.docs.get(uri), block = doc?.parsed?.blocks[0];
  if (!doc || !block || block.kind !== "FB" || !Array.isArray(bindings) || bindings.length > 100_000)
    throw new SimError("Invalid native scalar declarations");
  const widths: Record<string, number> = { BOOL: 1, SINT: 8, USINT: 8, BYTE: 8, INT: 16, UINT: 16, WORD: 16,
    DINT: 32, UDINT: 32, DWORD: 32, REAL: 32, LINT: 64, ULINT: 64, LWORD: 64, LREAL: 64, TIME: 32 };
  const expected = new Map(block.vars.filter(v => v.section !== "Temp" && v.section !== "Constant").map(v => [v.name.toUpperCase(), v]));
  verifyNativeCode(index, uri, constants);
  // a user FC runs inside the replay only when its source is the code the PLC holds
  for (const fc of nativeFunctions(index, uri)) {
    const name = index.docs.get(fc)!.parsed!.blocks[0]!.name;
    const native = functions?.find(f => f?.name?.toUpperCase() === name.toUpperCase());
    if (!native || !Array.isArray(native.bodies) || native.bodies.some(b => typeof b !== "string"))
      throw new SimError(`"${name}": the PLC code of this FC is unavailable`);
    sameBody(index, fc, "FC", native.bodies.join("\n"));
    verifyNativeCode(index, fc, native.constants);
  }
  // DB members and tags read by name are captured next to the sample; anything else a global does refuses there
  nativeGlobalReads(index, uri);
  // TEMP needs no capture: the replay refuses a temporary read before the cycle wrote it (Simulator.guardTemps)
  const names = new Set<string>();
  for (const binding of bindings) {
    if (!binding || typeof binding.name !== "string" || names.has(binding.name.toUpperCase())) throw new SimError("Duplicate or invalid native scalar binding");
    const name = binding.name.toUpperCase(); names.add(name);
    const declared = leafType(index, expected, name), type = /^\{Scalar"[0-9]+"([A-Za-z0-9_]+)\}$/.exec(binding.type)?.[1]?.toUpperCase();
    if (!type || type !== declared || widths[type] === undefined || widths[type] !== binding.bits) throw new SimError(`${name}: native scalar type differs or is unsupported`);
    if (!Number.isSafeInteger(binding.bitOffset) || binding.bitOffset < 0 || binding.bitOffset > 0xffffffff - binding.bits)
      throw new SimError("Invalid native scalar offset");
  }
  // a member without a binding is not captured: the replay marks it so and refuses only if the cycle reads it
  const intervals = [...bindings].sort((a, b) => a.bitOffset - b.bitOffset);
  if (intervals.some((binding, i) => i > 0 && binding.bitOffset < intervals[i - 1]!.bitOffset + intervals[i - 1]!.bits))
    throw new SimError("Native scalar addresses overlap");
}

/** What a body may use in a native replay: constants compiled with their declared values, no CPU clocks, no absolute or unquoted globals. */
function verifyNativeCode(index: WorkspaceIndex, uri: string, constants?: NativeConstant[]): void {
  const doc = index.docs.get(uri)!, block = doc.parsed!.blocks[0]!;
  const tokens = lex(doc.text.slice(block.bodyStart, block.end)).tokens.filter(t => t.kind !== "comment");
  // a constant the body uses replays with its declared value only when the PLC compiled that same value
  const used = new Set(tokens.filter(t => t.kind === "local").map(t => t.text.slice(1).toUpperCase()));
  for (const c of block.vars.filter(v => v.section === "Constant" && used.has(v.name.toUpperCase()))) {
    if (!constants) throw new SimError("Native local constant source is unavailable");
    const native = constants.find(n => n?.name === c.name.toUpperCase());
    const type = /^\{Scalar"[0-9]+"([A-Za-z0-9_]+)\}$/.exec(native?.type ?? "")?.[1]?.toUpperCase();
    // ponytail: integer constants only; REAL/TIME/STRING immediates need their own native encodings
    if (!native || type !== c.type.toUpperCase() || !/^(S|US|U|D|UD|L|UL)?INT$/.test(type) || !/^-?\d+$/.test(native.value))
      throw new SimError(`#${c.name}: the PLC does not show which value this constant was compiled with`);
    const declared = new Simulator(index).defaultValue(c, block);
    if (BigInt(native.value) !== BigInt(declared as number))
      throw new SimError(`#${c.name} is ${native.value} in the PLC but ${String(declared)} in the source: download the block first`);
  }
  if (tokens.some((t, i) => t.kind === "ident" && ["RD_SYS_T", "RD_LOC_T", "RUNTIME"].includes(t.upper) && tokens[i + 1]?.text === "("))
    throw new SimError("Native CPU clock state is unavailable");
  if (tokens.some(t => t.kind === "absolute" && parseAbsolute(t.text) || t.kind === "ident" && index.global(t.text, uri)))
    throw new SimError("Native external state or dependency source is unavailable");
}

/** The user FCs an FB calls, directly or through other FCs, in calling order: the replay runs their bodies too. */
export function nativeFunctions(index: WorkspaceIndex, uri: string): string[] {
  const out: string[] = [];
  const visit = (from: string, path: string[]) => {
    const block = index.docs.get(from)?.parsed?.blocks[0];
    if (!block || block.bodyStart === undefined) throw new SimError("Native source requires SCL blocks");
    for (const r of [...block.refs].filter(r => r.start >= block.bodyStart! && r.kind !== "local").sort((a, b) => a.start - b.start)) {
      const g = index.global(r.name, from);
      if (g?.block?.kind !== "FC" || (r.kind !== "call" && r.access !== "call")) continue;
      if (path.includes(g.uri)) throw new SimError(`"${g.name}" calls itself back (recursion): program status cannot replay it`);
      if (out.includes(g.uri)) continue;
      if (out.push(g.uri) > 64) throw new SimError("Too many FCs called for program status");
      visit(g.uri, [...path, g.uri]);
    }
  };
  visit(uri, [uri]);
  return out;
}

/** The declared type of a member path (S.A, ARR[1]) of the block's instance; refuses what is no single value there. */
function leafType(index: WorkspaceIndex, declared: Map<string, VarDecl>, path: string): string {
  const tokens = [...path.matchAll(/([A-Z_]\w*)|\[(-?\d+)\]/g)];
  type Decl = { type: string; typeRef?: string; members?: VarDecl[] };
  const top = declared.get(tokens[0]?.[1] ?? "");
  if (!top || tokens[0]![2] !== undefined) throw new SimError(`${path}: not a member of the block`);
  let decl: Decl = top;
  for (const t of tokens.slice(1)) {
    if (t[2] !== undefined) {
      const array = splitArrayType(decl.type);
      const bounds = array?.dims.length === 1 ? /^\s*([+-]?\d+)\s*\.\.\s*([+-]?\d+)\s*$/.exec(array.dims[0]!) : null;
      const n = Number(t[2]);
      if (!array || !bounds || n < Number(bounds[1]) || n > Number(bounds[2])) throw new SimError(`${path}: index outside the array`);
      decl = { type: array.element, typeRef: array.element.replace(/^"|"$/g, "") };
    } else {
      const member: Decl | undefined = index.membersOf(decl as VarDecl).find((m) => m.name.toUpperCase() === t[1]);
      if (!member) throw new SimError(`${path}: no such member`);
      decl = member;
    }
  }
  if (decl.members?.length || splitArrayType(decl.type) || index.membersOf(decl as VarDecl).length) throw new SimError(`${path}: not a single value`);
  return decl.type.trim().toUpperCase();
}

/** Body gate only; native interface/state and session provenance must also be verified. */
export function verifyNativeBody(index: WorkspaceIndex, uri: string, nativeBody: string): void {
  sameBody(index, uri, "FB", nativeBody);
}

/** The mirrored SCL body of an FB or FC is token for token the body the PLC holds. */
function sameBody(index: WorkspaceIndex, uri: string, kind: "FB" | "FC", nativeBody: string): void {
  const doc = index.docs.get(uri), block = doc?.parsed?.blocks[0];
  if (!doc || !block || block.kind !== kind || block.lad || block.stl || block.bodyStart === undefined)
    throw new SimError(`Native source requires an SCL ${kind}`);
  if (typeof nativeBody !== "string" || nativeBody.length > 1_048_576 || doc.text.length > 1_048_576)
    throw new SimError("Native source size limit exceeded");
  const tokens = (text: string) => {
    const result = lex(text);
    if (result.errors.length) throw new SimError("Invalid native source tokens");
    return result.tokens.filter(t => t.kind !== "comment" && t.kind !== "eof");
  };
  const mirror = tokens(doc.text.slice(block.bodyStart, block.end));
  if (mirror.at(-1)?.upper !== (kind === "FB" ? "END_FUNCTION_BLOCK" : "END_FUNCTION")) throw new SimError("Incomplete mirrored source");
  mirror.pop();
  const native = tokens(nativeBody);
  if (native.length !== mirror.length || native.some((t, i) => t.kind !== mirror[i]!.kind || t.upper !== mirror[i]!.upper))
    throw new SimError(kind === "FB" ? "Native body differs from mirrored source" : `Native body of "${block.name}" differs from mirrored source: download it first`);
}

/**
 * The DB members and tags an FB body reads by name, in reading order: what a sample reads next to the native capture.
 * Members it writes are captured too, so the replay can be compared with them. Calls, indexed and whole-structure
 * access refuse: a sample cannot capture those by name yet.
 */
export function nativeGlobalReads(index: WorkspaceIndex, uri: string): string[] {
  const root = index.docs.get(uri)?.parsed?.blocks[0];
  if (!root || root.kind !== "FB" || root.bodyStart === undefined) throw new SimError("Native source requires an SCL FB");
  const out: string[] = [];
  for (const from of [uri, ...nativeFunctions(index, uri)]) readsOf(index, from, out);
  if (out.length > 256) throw new SimError("Capture state limit exceeded");
  return out;
}

function readsOf(index: WorkspaceIndex, uri: string, out: string[]): void {
  const doc = index.docs.get(uri)!, block = doc.parsed!.blocks[0]!;
  for (const r of [...block.refs].filter(r => r.start >= block.bodyStart! && r.kind !== "local").sort((a, b) => a.start - b.start)) {
    const g = index.global(r.name, uri);
    // INT_TO_DINT(…), TON on #inst: instructions the replay runs itself; a user FC is checked and run like the FB
    if (r.kind === "call" && !g || g?.block?.kind === "FC" && (r.kind === "call" || r.access === "call")) continue;
    if (r.kind === "call" || r.access === "call" || !g || (g.block && g.block.kind !== "DB") || (!g.block && !g.tag))
      throw new SimError(`"${r.name}": native external state or dependency source is unavailable`);
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
}