// SPDX-License-Identifier: BUSL-1.1
// Editor features as pure functions over the workspace index (the LSP server only adapts them).
import { CONVERSION, ELEMENTARY_TYPES, KEYWORDS, STANDARD, STANDARD_BY_NAME, SYSTEM_TYPES, TYPE_INFO, type CatalogEntry } from "./catalog.js";
import { varsAt, type BlockModel, type Ref, type VarDecl } from "./parser.js";
import type { Token } from "./lexer.js";
import { nearest } from "./nearest.js";
import { TAG_TEXT, deviceOfUri, scopedTo, tagTableFor, type GlobalSymbol, type Member, type WorkspaceIndex } from "./workspace.js";
import { callSites, missingParams, orderedParams, paramsOf, unknownArgs, type CallSite } from "./calls.js";
import { TYPE_BITS, parseAbsolute } from "./assignments.js";

export interface Location {
  uri: string;
  start: number;
  end: number;
}

export interface FeatureDiagnostic {
  start: number;
  end: number;
  severity: "error" | "warning" | "information";
  message: string;
  code: string;
}

export type CompletionKind = "variable" | "field" | "function" | "class" | "keyword" | "type" | "constant" | "module";

export interface Completion {
  label: string;
  kind: CompletionKind;
  detail?: string;
  insertText?: string;
  documentation?: string;
  snippet?: boolean;
  replaceStart?: number;
}

export interface OutlineSymbol {
  name: string;
  detail?: string;
  kind: "block" | "section" | "variable" | "region";
  start: number;
  end: number;
  children: OutlineSymbol[];
}

const SECTION_LABEL: Record<string, string> = { Input: "VAR_INPUT", Output: "VAR_OUTPUT", InOut: "VAR_IN_OUT", Static: "VAR", Temp: "VAR_TEMP", Constant: "VAR CONSTANT", Return: "Return value" };

/** A variable of `block` by name; with `at`, as the code at that offset sees it (a PROPERTY accessor's own locals). */
function localDecl(block: BlockModel, name: string, at?: number): VarDecl | undefined {
  const u = name.toUpperCase();
  return varsAt(block, at).find((v) => v.name.toUpperCase() === u);
}

/**
 * A variable visible without qualification in `block`: its own declarations, the FB's variables for an IEC
 * METHOD, and for an instance/typed DB (`DATA_BLOCK "X" "Fb"`) the interface of that FB or UDT.
 */
/** `"FB"(...)`: TIA Portal needs an instance for every FB call (an instance DB or a multi-instance). */
export function calledWithoutInstance(index: WorkspaceIndex, ref: Ref): boolean {
  return ref.kind === "global" && ref.access === "call" && !ref.members.length && index.global(ref.name)?.block?.kind === "FB";
}

export function scopeDecl(index: WorkspaceIndex, uri: string, block: BlockModel, name: string, at?: number): Member | undefined {
  index = scopedTo(index, uri); // names mean the objects of this file's PLC
  const own = localDecl(block, name, at);
  if (own) return { ...own, uri };
  const u = name.toUpperCase();
  // an FC (IEC: a METHOD, a PROPERTY accessor) sets its return value through its own name: #Fx_Scale := 1.0;
  if (u === block.name.toUpperCase() && block.returnType && !/^void$/i.test(block.returnType))
    return { name: block.name, type: block.returnType, typeRef: block.returnType.replace(/^"|"$/g, ""), isArray: false, section: "Return", uri, start: block.nameStart, end: block.nameEnd };
  if (block.owner) {
    const g = index.global(block.owner);
    const v = g?.block?.vars.find((x) => x.name.toUpperCase() === u);
    if (v) return { ...v, uri: g!.uri };
  }
  if (block.kind === "DB" && block.dbOf) return index.membersOfType(block.dbOf).find((m) => m.name.toUpperCase() === u);
  // an IEC FB, its METHODs and PROPERTYs see the FB's properties and methods by their bare names
  if (/\.st$/i.test(uri) || index.docs.get(uri)?.code !== undefined) {
    const fb = block.owner ?? (block.kind === "FB" || block.kind === "PRG" ? block.name : undefined);
    const m = fb ? index.membersOfType(fb).find((x) => (x.section === "Property" || x.section === "Method") && x.name.toUpperCase() === u) : undefined;
    if (m) return m;
  }
  return undefined;
}

/** Reference (or member of one) under the cursor. */
function refAt(index: WorkspaceIndex, uri: string, offset: number): { block: BlockModel; ref: Ref; member: number } | undefined {
  const block = index.blockAt(uri, offset);
  if (!block) return undefined;
  for (const ref of block.refs) {
    if (offset >= ref.start && offset <= ref.end) return { block, ref, member: -1 };
    const i = ref.members.findIndex((m) => offset >= m.start && offset <= m.end);
    if (i >= 0) return { block, ref, member: i };
  }
  return undefined;
}

/** The named argument under the cursor (`Start` in `#Pump(Start := #x)`) and the parameter it names in the callee. */
function argAt(index: WorkspaceIndex, uri: string, offset: number): { site: CallSite; name: string; start: number; end: number; param?: Member } | undefined {
  for (const site of callSites(index, uri, (b, n) => scopeDecl(index, uri, b, n), true)) {
    if (offset < site.open || offset > site.close) continue;
    const a = site.args.find((x) => x.name && offset >= x.nameStart! && offset <= x.nameEnd!);
    if (!a) continue;
    const g = site.callee.kind === "std" ? undefined : index.global(site.callee.name);
    const v = g?.block?.vars.find((x) => x.name.toUpperCase() === a.name!.toUpperCase());
    return { site, name: a.name!, start: a.nameStart!, end: a.nameEnd!, ...(v ? { param: { ...v, uri: g!.uri } } : {}) };
  }
  return undefined;
}

/** The word under the cursor where no reference is, quotes included in `raw`: a type name in a declaration. */
function wordAt(text: string, offset: number): { raw: string; word: string; start: number; end: number } | undefined {
  let start = offset;
  let end = offset;
  while (start > 0 && /[\p{L}\p{N}_"]/u.test(text[start - 1]!)) start--;
  while (end < text.length && /[\p{L}\p{N}_"]/u.test(text[end]!)) end++;
  const raw = text.slice(start, end);
  const word = raw.replace(/^"|"$/g, "");
  return word ? { raw, word, start, end } : undefined;
}

/** The first member of `ref` its type does not have, with the name it most likely meant (only when the type is known completely). */
export function unknownMember(index: WorkspaceIndex, uri: string, block: BlockModel, ref: Ref): { start: number; end: number; name: string; parent: string; suggestion?: string } | undefined {
  const root = rootMembers(index, block, ref, uri);
  if (!root.length) return undefined;
  const chain = index.resolveChain(root, ref.members);
  for (let i = 0; i < chain.length; i++) {
    if (chain[i]) continue;
    // the parent's type is not known (system type, unmirrored UDT, elementary bit access): no verdict
    const scope = i > 0 ? index.membersOf(chain[i - 1]!) : root;
    if (!scope.length) return undefined;
    const m = ref.members[i]!;
    const suggestion = nearest(m.name, scope.map((s) => s.name));
    return { start: m.start, end: m.end, name: m.name, parent: i === 0 ? ref.name : ref.members[i - 1]!.name, ...(suggestion ? { suggestion } : {}) };
  }
  return undefined;
}

const TEXT_TYPE = /^(W?STRING(\[.*\])?|W?CHAR)$/i;
const NUMERIC_TYPE = /^(U?S?INT|U?D?INT|U?L?INT|L?REAL|BYTE|L?D?WORD|BOOL|L?TIME|S5TIME|DATE|L?TOD|TIME_OF_DAY|L?DT|DTL|DATE_AND_TIME)$/i;

/** `#x := <one literal>;` where the literal cannot become the declared type: text into a number, a number into text. */
function literalMismatches(index: WorkspaceIndex, uri: string, tokens: Token[], block: BlockModel): FeatureDiagnostic[] {
  const out: FeatureDiagnostic[] = [];
  const code = tokens.filter((t) => t.kind !== "comment" && t.kind !== "pragma");
  const at = new Map(code.map((t, i) => [t.start, i]));
  for (const ref of block.refs) {
    if (ref.kind !== "local" || ref.access !== "write" || ref.members.length) continue;
    const i = at.get(ref.start) ?? -9;
    const [op, value, end] = [code[i + 1], code[i + 2], code[i + 3]];
    if (op?.text !== ":=" || !value || end?.text !== ";") continue;
    const d = scopeDecl(index, uri, block, ref.name, ref.start);
    if (!d || d.isArray) continue;
    const type = d.type.replace(/\s+/g, "");
    const text = value.kind === "string";
    const number = value.kind === "number" && /^[+-]?\d[\d_]*(\.\d+)?(e[+-]?\d+)?$/i.test(value.text);
    // one character ('A', '$02') is a Char, which TIA Portal converts into bit strings and integers: #stx := '$02';
    const char = text && /^'(?:[^'$]|\$[0-9A-Fa-f]{2}|\$.)'$/.test(value.text);
    if (char && !/^(BOOL|L?REAL|L?TIME|S5TIME|DATE|L?TOD|TIME_OF_DAY|L?DT|DTL|DATE_AND_TIME)$/i.test(type)) continue;
    if (text && NUMERIC_TYPE.test(type)) out.push({ start: value.start, end: value.end, severity: "error", message: `#${d.name} is ${d.type}: ${value.text} is text, TIA Portal does not convert it`, code: "TYPE_MISMATCH" });
    else if (number && TEXT_TYPE.test(type)) out.push({ start: value.start, end: value.end, severity: "error", message: `#${d.name} is ${d.type}: write the text in quotes, '${value.text}'`, code: "TYPE_MISMATCH" });
  }
  return out;
}

function rootMembers(index: WorkspaceIndex, block: BlockModel, ref: Ref, uri: string): Member[] {
  if (ref.kind === "local") {
    const d = scopeDecl(index, uri, block, ref.name, ref.start);
    return d ? index.membersOf(d) : [];
  }
  if (ref.kind === "global") {
    const g = index.global(ref.name);
    if (g?.block) return index.membersOfType(g.name);
  }
  return [];
}

/** The same place with the size the type needs: %IW40 for a Bool → %I40.0, %I0.0 for an Int → %IW0. */
function suggestAddress(a: { area: string; byte: number }, bits: number): string {
  return bits === 1 || bits === 64 ? `%${a.area}${a.byte}.0` : `%${a.area}${({ 8: "B", 16: "W", 32: "D" } as Record<number, string>)[bits]}${a.byte}`;
}

export function diagnostics(index: WorkspaceIndex, uri: string): FeatureDiagnostic[] {
  index = scopedTo(index, uri); // names mean the objects of this file's PLC
  const doc = index.docs.get(uri);
  if (!doc?.parsed) return [];
  const out: FeatureDiagnostic[] = doc.parsed.diagnostics.map((d) => ({ start: d.start, end: d.end, severity: d.severity, message: d.message, code: "SYNTAX" }));
  // a TIA tag table as text: TIA Portal keeps every PLC tag at an address; what the import refuses shows here first
  if (TAG_TEXT.test(uri)) {
    const table: FeatureDiagnostic[] = [];
    const flag = (at: { start: number; end: number }, code: string, message: string) => table.push({ start: at.start, end: at.end, severity: "error", message, code });
    const lineOf = (offset: number) => doc.lines.position(offset).line;
    const seen = new Map<string, number>();
    let lastLine = -1;
    for (const c of doc.parsed.tokens) if (c.kind === "comment" && !c.text.startsWith("//")) flag(c, "TAG_COMMENT", "use // for a comment, it belongs to the tag on its line");
    for (const b of doc.parsed.blocks)
      for (const v of b.vars) {
        const line = lineOf(v.start);
        if (line === lastLine) flag(v, "TAG_LINE", `one tag per line: ${v.name} goes on a line of its own`);
        lastLine = line;
        const first = seen.get(v.name.toUpperCase());
        if (first !== undefined) flag(v, "DUPLICATE_TAG", `${v.name} is declared twice in the table (line ${first + 1})`);
        else seen.set(v.name.toUpperCase(), line);
        if (v.section === "Constant") {
          if (v.init === undefined) flag(v, "NO_VALUE", `a constant needs a value: ${v.name} : ${v.type} := 10;`);
          continue;
        }
        if (v.init !== undefined) flag(v, "START_VALUE", "a PLC tag has no start value in TIA Portal; constants go in VAR_GLOBAL CONSTANT");
        if (!v.at) flag(v, "NO_ADDRESS", `${v.name} has no address: a PLC tag is at an address (${v.name} AT %M10.0 : ${v.type};)`);
        else if (!/^%[A-Za-z]{1,3}\d+(\.\d+)?$/.test(v.at)) flag(v, "BAD_ADDRESS", `${v.at} is not an address such as %I0.0, %QW4 or %MD10`);
        else {
          // TIA Portal keeps a tag whose type does not fit its address, and shows it red
          const a = parseAbsolute(v.at);
          const bits = TYPE_BITS[v.type.toUpperCase()];
          // 64-bit tags: TIA Portal has no L size and writes them at a bit address, %I1000.0
          const fits = !a || !bits || a.bits === bits || (bits === 64 && a.bit === 0) || a.area === "T" || a.area === "C";
          if (a && bits && !fits) flag(v, "ADDRESS_SIZE", `${v.name} is ${/^[aeiou]/i.test(v.type) ? "an" : "a"} ${v.type} (${bits === 1 ? "one bit" : bits + " bits"}) but ${v.at} is ${a.bits === 1 ? "a bit" : a.bits + " bits"}: use ${suggestAddress(a, bits)}`);
        }
      }
    out.push(...table.sort((a, b) => a.start - b.start));
  }
  // calls against the interface they call (TIA Portal's "Update block call")
  for (const site of callSites(index, uri, (b, n) => scopeDecl(index, uri, b, n))) {
    for (const a of unknownArgs(site))
      out.push({ start: a.nameStart!, end: a.nameEnd!, severity: "error", message: `${a.name} is not a parameter of ${site.callee.name} (quick fix: remove it)`, code: "UNKNOWN_PARAMETER" });
    const missing = missingParams(site);
    if (missing.length)
      out.push({ start: site.ref.start, end: site.ref.end, severity: "error", message: `This call of ${site.callee.name} leaves out ${missing.map((p) => p.name).join(", ")}: an FC gets every input, in/out and output${missing.some((p) => p.section !== "Output") ? " (quick fix: add the inputs)" : ""}`, code: "MISSING_PARAMETER" });
  }
  for (const block of doc.parsed.blocks) {
    for (const ref of block.refs) {
      if (ref.kind === "local") {
        const known = scopeDecl(index, uri, block, ref.name, ref.start) || ref.name.toUpperCase() === block.name.toUpperCase();
        // the start values of a DB of an FB or UDT the workspace does not have (a library or system FB): no verdict
        if (!known && block.kind === "DB" && block.dbOf && !index.membersOfType(block.dbOf).length) continue;
        if (!known) {
          out.push({ start: ref.start, end: ref.end, severity: "warning", message: `#${ref.name} is not declared in ${block.name}`, code: "UNDECLARED" });
          continue;
        }
      }
      if (/\.scl$/i.test(uri) && calledWithoutInstance(index, ref)) {
        out.push({ start: ref.start, end: ref.end, severity: "error", message: `"${ref.name}" is a function block: call it through an instance, a new instance DB or a multi-instance (quick fix)`, code: "NO_INSTANCE" });
        continue;
      }
      // "Device~Module" names are hardware identifiers (system constants): exports never contain them
      if (ref.kind === "global" && !index.global(ref.name) && !ref.name.includes("~") && !index.enumTypesWith(ref.name).length && !scopeDecl(index, uri, block, ref.name, ref.start)) {
        const definable = ref.access !== "call" && !ref.members.length && /\.scl$/i.test(uri) && tagTableFor(index, uri);
        out.push({ start: ref.start, end: ref.end, severity: "information", message: `"${ref.name}" is not in the workspace (system object or not mirrored${definable ? "; quick fix: create it as a PLC tag" : ""})`, code: "UNKNOWN_GLOBAL" });
        continue;
      }
      // Member names: only report when the type is known completely.
      const m = unknownMember(index, uri, block, ref);
      if (m) out.push({ start: m.start, end: m.end, severity: "warning", message: `${m.name} is not a member of ${m.parent}${m.suggestion ? ` (did you mean ${m.suggestion}?)` : ""}`, code: "UNKNOWN_MEMBER" });
    }
    if (/\.scl$/i.test(uri)) out.push(...literalMismatches(index, uri, doc.parsed.tokens, block));
  }
  return out;
}

export function outline(index: WorkspaceIndex, uri: string): OutlineSymbol[] {
  const doc = index.docs.get(uri);
  if (!doc?.parsed) return [];
  return doc.parsed.blocks.map((b) => {
    const sections = new Map<string, OutlineSymbol>();
    for (const v of b.vars) {
      const label = SECTION_LABEL[v.section] ?? v.section;
      let s = sections.get(label);
      if (!s) {
        s = { name: label, kind: "section", start: v.start, end: v.end, children: [] };
        sections.set(label, s);
      }
      s.end = Math.max(s.end, v.end);
      s.children.push({ name: v.name, detail: v.type, kind: "variable", start: v.start, end: v.end, children: [] });
    }
    const regions = b.regions.map((r) => ({ name: r.name || "REGION", kind: "region" as const, start: r.start, end: r.end, children: [] }));
    return { name: b.name, detail: b.kind, kind: "block" as const, start: b.start, end: b.end, children: [...sections.values(), ...regions] };
  });
}

export function definition(index: WorkspaceIndex, uri: string, offset: number): Location | undefined {
  index = scopedTo(index, uri); // names mean the objects of this file's PLC
  const hit = refAt(index, uri, offset);
  if (!hit) {
    // a named argument: the parameter in the block it calls
    const a = argAt(index, uri, offset);
    if (a) return a.param?.start !== undefined ? { uri: a.param.uri!, start: a.param.start, end: a.param.end! } : undefined;
    // a type in a declaration (`Data : "UDT_Motor";`, `Pump : "FB_Motor";`) or the FB of an instance DB's header
    const w = wordAt(index.docs.get(uri)?.text ?? "", offset);
    const g = w?.raw.startsWith('"') ? index.global(w.word) : undefined;
    return g?.block ? { uri: g.uri, start: g.start, end: g.end } : undefined;
  }
  const { block, ref, member } = hit;
  if (member < 0) {
    if (ref.kind === "local") {
      const d = scopeDecl(index, uri, block, ref.name, ref.start);
      return d?.uri !== undefined && d.start !== undefined ? { uri: d.uri, start: d.start, end: d.end! } : undefined;
    }
    const g = index.global(ref.name);
    return g ? { uri: g.uri, start: g.start, end: g.end } : undefined;
  }
  const chain = index.resolveChain(rootMembers(index, block, ref, uri), ref.members.slice(0, member + 1));
  const m = chain[member];
  return m?.uri !== undefined && m.start !== undefined ? { uri: m.uri, start: m.start, end: m.end! } : undefined;
}

/** A variable other blocks can name: an FB's or FC's parameter, an FB's static (through its instances), a DB's or a data type's member. */
function visibleOutside(block: BlockModel, v: VarDecl): boolean {
  if (block.kind === "DB" || block.kind === "UDT") return true;
  if (block.kind === "FB") return v.section === "Input" || v.section === "Output" || v.section === "InOut" || v.section === "Static";
  return block.kind === "FC" && (v.section === "Input" || v.section === "Output" || v.section === "InOut");
}

/** Whether `inner` is declared somewhere inside the STRUCT `v`. */
function contains(v: VarDecl, inner: VarDecl): boolean {
  return !!v.members?.some((m) => m === inner || contains(m, inner));
}

/** Declaration (possibly nested in a STRUCT) whose name is under the cursor. */
function declAt(vars: VarDecl[], offset: number): VarDecl | undefined {
  for (const v of vars) {
    if (offset >= v.start && offset <= v.end) return v;
    const inner = v.members ? declAt(v.members, offset) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** Every place in the workspace whose resolved declaration is `target` (members of DBs, UDTs, FB interfaces). */
function memberReferences(index: WorkspaceIndex, target: Location, includeDeclaration: boolean): (Location & { arg?: string })[] {
  const out: (Location & { arg?: string })[] = includeDeclaration ? [target] : [];
  const same = (m: Member | undefined) => m?.uri === target.uri && m.start === target.start;
  // a parameter of an FB or FC is also named by the calls' arguments: #Pump(Start := ...)
  const owner = index.blockAt(target.uri, target.start);
  const param = owner && (owner.kind === "FB" || owner.kind === "FC") ? owner.vars.find((v) => v.start === target.start && (v.section === "Input" || v.section === "Output" || v.section === "InOut")) : undefined;
  for (const d of index.docs.values()) {
    const seen = scopedTo(index, d.uri); // each file's names mean its own PLC's objects
    if (param)
      for (const site of callSites(seen, d.uri, (b, n) => scopeDecl(seen, d.uri, b, n)))
        if (site.callee.kind !== "std" && seen.global(site.callee.name)?.uri === target.uri)
          for (const a of site.args) if (a.name?.toUpperCase() === param.name.toUpperCase()) out.push({ uri: d.uri, start: a.nameStart!, end: a.nameEnd!, arg: param.section });
    for (const b of d.parsed?.blocks ?? [])
      for (const r of b.refs) {
        if (!r.members.length && r.kind !== "local") continue;
        const root = rootMembers(seen, b, r, d.uri);
        if (r.kind === "local" && same(scopeDecl(seen, d.uri, b, r.name, r.start))) out.push({ uri: d.uri, start: r.start, end: r.end });
        if (!r.members.length || !root.length) continue;
        seen.resolveChain(root, r.members).forEach((m, i) => {
          if (same(m)) out.push({ uri: d.uri, start: r.members[i]!.start, end: r.members[i]!.end });
        });
      }
  }
  return out;
}

/** `fileOnly`: the uses in this file are enough (highlights), a block's parameter is not looked up in its callers. */
export function references(index: WorkspaceIndex, uri: string, offset: number, includeDeclaration = true, fileOnly = false): Location[] {
  index = scopedTo(index, uri); // names mean the objects of this file's PLC
  const hit = refAt(index, uri, offset);
  const out: Location[] = [];
  // a member (`"Db".x.y`, `#inst.x`), a DB start value (`x := 1;` in a DB), a named argument, or a declaration (in an FC: its own uses)
  const onDecl = !hit ? declAt(index.blockAt(uri, offset)?.vars ?? [], offset) : undefined;
  const arg = !hit && !onDecl ? argAt(index, uri, offset)?.param : undefined;
  const memberTarget =
    hit && (hit.member >= 0 || (hit.ref.kind === "local" && hit.block.kind === "DB")) ? definition(index, uri, offset)
    : onDecl ? { uri, start: onDecl.start, end: onDecl.end }
    : arg?.start !== undefined ? { uri: arg.uri!, start: arg.start, end: arg.end! }
    : undefined;
  if (memberTarget) return memberReferences(index, memberTarget, includeDeclaration);
  if (hit && hit.member < 0 && hit.ref.kind === "local") {
    const u = hit.ref.name.toUpperCase();
    const d = localDecl(hit.block, hit.ref.name, hit.ref.start);
    // the interface and statics of a block are used from outside too: by the calls and through instances
    if (d && !fileOnly && visibleOutside(hit.block, d)) return memberReferences(index, { uri, start: d.start, end: d.end }, includeDeclaration);
    // the same variable: in a PROPERTY, GET's local and SET's local of one name are two
    for (const r of hit.block.refs) if (r.kind === "local" && r.name.toUpperCase() === u && localDecl(hit.block, r.name, r.start) === d) out.push({ uri, start: r.start, end: r.end });
    if (d && includeDeclaration) out.unshift({ uri, start: d.start, end: d.end });
    return out;
  }
  // a global (under the cursor as a reference or as a block header name)
  let name = hit && hit.member < 0 ? hit.ref.name : undefined;
  if (!name) {
    const b = index.blockAt(uri, offset);
    if (b && offset >= b.nameStart && offset <= b.nameEnd) name = b.name;
  }
  if (!name) return out;
  const u = name.toUpperCase();
  const g = index.global(name);
  if (g && includeDeclaration) out.push({ uri: g.uri, start: g.start, end: g.end });
  for (const d of index.docs.values()) {
    // another PLC's file that uses the name means that PLC's object
    if (g && scopedTo(index, d.uri).global(name) !== g) continue;
    for (const b of d.parsed?.blocks ?? []) {
      for (const r of b.refs) if (r.kind === "global" && r.name.toUpperCase() === u) out.push({ uri: d.uri, start: r.start, end: r.end });
      for (const v of b.vars) if (v.typeRef?.toUpperCase() === u && v.type.startsWith('"')) out.push({ uri: d.uri, start: v.start, end: v.end });
      if (b.dbOf?.toUpperCase() === u) out.push({ uri: d.uri, start: b.nameStart, end: b.nameEnd });
    }
  }
  return out;
}

export interface SignatureHelp {
  signatures: { label: string; documentation?: string; parameters: { label: string; documentation: string }[] }[];
  activeSignature: number;
  activeParameter: number;
}

export function signatureHelp(index: WorkspaceIndex, uri: string, offset: number): SignatureHelp | undefined {
  const doc = index.docs.get(uri);
  if (!doc?.parsed) return undefined;
  const parsed = doc.parsed;
  if (parsed.tokens.some((t) => {
    if (t.kind !== "string" && t.kind !== "comment" && t.kind !== "pragma") return false;
    const open = (t.kind === "comment" && t.text.startsWith("//")) || parsed.diagnostics.some((d) => d.start === t.start && d.message.startsWith("Unterminated"));
    return offset >= t.start && (offset < t.end || (open && offset === t.end));
  })) return undefined;
  const site = callSites(index, uri, (b, n) => scopeDecl(index, uri, b, n), true)
    .filter((s) => offset > s.open && offset <= s.close).sort((a, b) => b.open - a.open)[0];
  if (!site) return undefined;
  let depth = 0;
  let argument = 0;
  for (const t of doc.parsed.tokens) {
    if (t.start <= site.open || t.start >= offset || t.kind !== "op") continue;
    if (t.text === "(" || t.text === "[") depth++;
    else if (t.text === ")" || t.text === "]") depth--;
    else if (t.text === "," && depth === 0) argument++;
  }
  const params = orderedParams(site.callee);
  const name = site.args[argument]?.name;
  const named = name ? params.findIndex((p) => p.name.toUpperCase() === name.toUpperCase()) : -1;
  const parameters = params.map((p) => ({
    label: `${p.name} ${p.section === "Output" ? "=>" : ":"} ${p.type}`,
    documentation: `${p.section} : ${p.type}${p.documentation ? ` — ${p.documentation}` : ""}`,
  }));
  const returns = site.callee.returnType;
  return {
    signatures: [{ label: `${doc.text.slice(site.ref.start, site.ref.end)}(${parameters.map((p) => p.label).join(", ")})${returns && !/^void$/i.test(returns) ? ` : ${returns}` : ""}`, documentation: site.callee.documentation, parameters }],
    activeSignature: 0,
    activeParameter: Math.max(0, Math.min(named >= 0 ? named : argument, params.length - 1)),
  };
}

/** Whether a use in this file reads or writes: the left of `:=`, and output and InOut arguments of calls, write. */
function accessIn(index: WorkspaceIndex, uri: string): (start: number) => "read" | "write" {
  const doc = index.docs.get(uri);
  if (!doc?.parsed) return () => "read";
  const writes = new Set<Ref>();
  const refs = doc.parsed.blocks.flatMap((b) => b.refs);
  for (const site of callSites(index, uri, (b, n) => scopeDecl(index, uri, b, n), true)) {
    site.args.forEach((a, i) => {
      const param = a.name ? site.callee.params.find((p) => p.name.toUpperCase() === a.name!.toUpperCase()) : orderedParams(site.callee)[i];
      if (!a.out && param?.section !== "Output" && param?.section !== "InOut") return;
      // Only the destination is written; an index used to select it is read.
      const target = refs.filter((r) => r.start >= (a.nameEnd ?? a.start) && r.end <= a.end).sort((x, y) => x.start - y.start)[0];
      if (target) writes.add(target);
    });
  }
  return (start) => {
    const ref = refs.find((x) => x.start === start || x.members.some((m) => m.start === start));
    return ref?.access === "write" || (ref && writes.has(ref)) ? "write" : "read";
  };
}

export function documentHighlights(index: WorkspaceIndex, uri: string, offset: number): (Location & { kind: "read" | "write" })[] {
  if (!index.docs.get(uri)?.parsed) return [];
  const kind = accessIn(index, uri);
  return references(index, uri, offset, false, true)
    .filter((r) => r.uri === uri)
    .map((r) => ({ ...r, kind: kind(r.start) }));
}

export interface UsageSite extends Location {
  kind: "read" | "write";
  /** The block the use is in. */
  block?: string;
  /** Where that block is called from (one level up): the caller and the call's file position. */
  calledFrom?: { block: string; uri: string; start: number }[];
  /** Reached through a parameter: the call that hands the structure holding it to this block (`Data := "Plant_DB".Pump`). */
  through?: { block: string; uri: string; start: number; param: string };
  /** A use of the whole structure that holds it (`"Plant_DB".Pump := #Spare;`). */
  whole?: boolean;
}

type Call = { block: string; uri: string; start: number };

/** Where `block` is called: `"FC"(...)`, an instance DB `"Motor_DB"(...)`, a multi-instance `#Pump(...)`. OBs run by themselves, DBs are not called. */
export function callsOf(index: WorkspaceIndex, block: BlockModel, uri: string): Call[] {
  if (block.kind !== "FB" && block.kind !== "FC") return [];
  const own = scopedTo(index, uri).global(block.name);
  const u = block.name.toUpperCase();
  const out: Call[] = [];
  for (const d of index.docs.values()) {
    const seen = scopedTo(index, d.uri);
    if (own && seen.global(block.name) !== own) continue; // another PLC's block of that name
    for (const b of d.parsed?.blocks ?? []) {
      const instances = new Set(block.kind === "FB" ? b.vars.filter((v) => v.typeRef?.toUpperCase() === u).map((v) => v.name.toUpperCase()) : []);
      for (const r of b.refs) {
        if (r.access !== "call" || r.members.length) continue;
        const n = r.name.toUpperCase();
        if (r.kind === "local" ? instances.has(n) : r.kind === "global" && (n === u || seen.global(r.name)?.block?.dbOf?.toUpperCase() === u)) out.push({ block: b.name, uri: d.uri, start: r.start });
      }
    }
  }
  return out;
}

/** Names of a declaration (nested in STRUCTs) under the cursor, outermost first. */
function declPath(vars: VarDecl[], offset: number): string[] | undefined {
  for (const v of vars) {
    if (offset >= v.start && offset <= v.end) return [v.name];
    const inner = v.members ? declPath(v.members, offset) : undefined;
    if (inner) return [v.name, ...inner];
  }
  return undefined;
}

/** A global or typed DB's member under the cursor (a use, a start value or its declaration): the DB and the names down to it. */
function dbPathAt(index: WorkspaceIndex, uri: string, offset: number): { db: GlobalSymbol; chain: string[] } | undefined {
  const isData = (b: BlockModel | undefined) => b?.kind === "DB" && (!b.dbOf || index.global(b.dbOf)?.block?.kind === "UDT");
  const hit = refAt(index, uri, offset);
  if (hit) {
    const { block, ref, member } = hit;
    if (ref.kind === "global" && member >= 0) {
      const g = index.global(ref.name);
      return g && isData(g.block) ? { db: g, chain: ref.members.slice(0, member + 1).map((m) => m.name) } : undefined;
    }
    const g = ref.kind === "local" && isData(block) ? index.global(block.name) : undefined;
    return g?.uri === uri ? { db: g, chain: [ref.name, ...ref.members.slice(0, member + 1).map((m) => m.name)] } : undefined;
  }
  const block = index.blockAt(uri, offset);
  const chain = block && isData(block) ? declPath(block.vars, offset) : undefined;
  const g = chain ? index.global(block!.name) : undefined;
  return chain && g?.uri === uri ? { db: g, chain } : undefined;
}

/**
 * Who writes and who reads one member of one DB (`"Plant_DB".Pump.Running`, not every Running of the data type):
 * its uses, and the uses inside the blocks the structure holding it is handed to (`Data := "Plant_DB".Pump` → `#Data.Running`
 * in FB_Motor), three calls deep. An input is a copy, so only its reads count there; an output only its writes.
 */
export function usagesOfPath(index: WorkspaceIndex, db: GlobalSymbol, chain: string[]): { writes: UsageSite[]; reads: UsageSite[] } {
  const want = chain.map((n) => n.toUpperCase());
  const kinds = new Map<string, (start: number) => "read" | "write">();
  const kindOf = (u: string) => kinds.get(u) ?? (kinds.set(u, accessIn(scopedTo(index, u), u)), kinds.get(u)!)!;
  const sites = new Map<string, CallSite[]>();
  const callsIn = (u: string) => sites.get(u) ?? (sites.set(u, callSites(scopedTo(index, u), u, (b, n) => scopeDecl(scopedTo(index, u), u, b, n))), sites.get(u)!)!;
  const callers = new Map<BlockModel, Call[]>();
  const writes: UsageSite[] = [];
  const reads: UsageSite[] = [];
  const add = (site: UsageSite, b: BlockModel) => {
    if (site.kind === "write" && !site.through) {
      const from = callers.get(b) ?? (callers.set(b, callsOf(index, b, site.uri)), callers.get(b)!);
      if (from.length) site.calledFrom = from;
    }
    (site.kind === "write" ? writes : reads).push(site);
  };
  const same = (segs: { name: string }[], names: string[]) => segs.slice(0, names.length).every((s, i) => s.name.toUpperCase() === names[i]);
  /** The block and parameter a reference is handed to as the whole value of an argument. */
  const passedTo = (u: string, r: Ref): { uri: string; callee: BlockModel; param: VarDecl } | undefined => {
    const text = index.docs.get(u)?.text ?? "";
    const end = (r.members.at(-1) ?? r).end;
    for (const site of callsIn(u)) {
      const i = site.args.findIndex((a) => r.start >= a.start && end <= a.end);
      if (i < 0) continue;
      const a = site.args[i]!;
      if (text.slice(a.nameEnd ?? a.start, a.end).replace(/^\s*(:=|=>)?\s*/, "").trim() !== text.slice(r.start, end)) return undefined;
      const g = site.callee.kind === "std" ? undefined : scopedTo(index, u).global(site.callee.name);
      const name = (a.name ?? orderedParams(site.callee)[i]?.name)?.toUpperCase();
      const param = g?.block?.vars.find((v) => v.name.toUpperCase() === name);
      return g?.block && param ? { uri: g.uri, callee: g.block, param } : undefined;
    }
    return undefined;
  };
  const follow = (u: string, callee: BlockModel, param: VarDecl, rest: string[], through: NonNullable<UsageSite["through"]>, depth: number) => {
    const counts = (k: "read" | "write") => param.section === "InOut" || (param.section === "Input" ? k === "read" : param.section === "Output" && k === "write");
    for (const r of callee.refs) {
      if (r.kind !== "local" || r.name.toUpperCase() !== param.name.toUpperCase() || !same(r.members, rest.slice(0, r.members.length))) continue;
      if (r.members.length >= rest.length) {
        const s = rest.length ? r.members[rest.length - 1]! : r;
        const k = kindOf(u)(r.start);
        if (counts(k)) add({ uri: u, start: s.start, end: s.end, kind: k, block: callee.name, through }, callee);
        // handed on whole to the next block's in/out or output ("Increment"(N := #N)): what that one does with it
        const on = r.members.length === rest.length && depth < 3 ? passedTo(u, r) : undefined;
        if (on && on.param.section !== "Input") follow(on.uri, on.callee, on.param, [], { block: callee.name, uri: u, start: r.start, param: on.param.name }, depth + 1);
        continue;
      }
      const next = depth < 3 ? passedTo(u, r) : undefined;
      if (next) follow(next.uri, next.callee, next.param, rest.slice(r.members.length), { block: callee.name, uri: u, start: r.start, param: next.param.name }, depth + 1);
    }
  };
  for (const d of index.docs.values()) {
    if (scopedTo(index, d.uri).global(db.name)?.uri !== db.uri) continue; // another PLC's DB of that name
    for (const b of d.parsed?.blocks ?? [])
      for (const r of b.refs) {
        // a start value in the DB itself, or "Db".member anywhere
        const own = d.uri === db.uri && r.kind === "local" && b.kind === "DB";
        if (!own && !(r.kind === "global" && r.name.toUpperCase() === db.name.toUpperCase())) continue;
        const segs = own ? [{ name: r.name, start: r.start, end: r.end }, ...r.members] : r.members;
        if (!same(segs, want.slice(0, segs.length))) continue;
        if (segs.length >= want.length) {
          const s = segs[want.length - 1]!;
          add({ uri: d.uri, start: s.start, end: s.end, kind: kindOf(d.uri)(r.start), block: b.name }, b);
          // handed whole to an in/out or output (Parts := "Line_DB".PartsTotal): what the block does with it, too
          const passed = segs.length === want.length ? passedTo(d.uri, r) : undefined;
          if (passed && passed.param.section !== "Input") follow(passed.uri, passed.callee, passed.param, [], { block: b.name, uri: d.uri, start: r.start, param: passed.param.name }, 0);
          continue;
        }
        // the structure that holds it, handed to a block's parameter: its uses there
        const passed = passedTo(d.uri, r);
        if (passed) {
          follow(passed.uri, passed.callee, passed.param, want.slice(segs.length), { block: b.name, uri: d.uri, start: r.start, param: passed.param.name }, 0);
          continue;
        }
        const last = segs.at(-1) ?? r;
        add({ uri: d.uri, start: last.start, end: last.end, kind: kindOf(d.uri)(r.start), block: b.name, whole: true }, b);
      }
  }
  return { writes, reads };
}

/**
 * Who writes and who reads what is under the cursor (a tag, a DB member, a local, an instance member), across the
 * workspace: the commissioning question "what sets this?". Indirect access (pointers, VARIANT, PEEK/POKE), HMI and
 * communication are not seen; the report says so where it shows.
 */
export function usagesAt(index: WorkspaceIndex, uri: string, offset: number): { writes: UsageSite[]; reads: UsageSite[] } {
  const path = dbPathAt(scopedTo(index, uri), uri, offset);
  if (path) return usagesOfPath(index, path.db, path.chain);
  const kinds = new Map<string, (start: number) => "read" | "write">();
  const kindOf = (u: string) => kinds.get(u) ?? (kinds.set(u, accessIn(index, u)), kinds.get(u)!)!;
  const callers = new Map<BlockModel, Call[]>();
  const writes: UsageSite[] = [];
  const reads: UsageSite[] = [];
  for (const r of references(index, uri, offset, false) as (Location & { arg?: string })[]) {
    const block = index.blockAt(r.uri, r.start);
    // a call's argument sets the block's input (and in/out); it reads an output
    const kind = r.arg ? (r.arg === "Output" ? "read" : "write") : kindOf(r.uri)(r.start);
    const site: UsageSite = { uri: r.uri, start: r.start, end: r.end, kind, ...(block ? { block: block.name } : {}) };
    if (kind === "write" && block) {
      const from = callers.get(block) ?? (callers.set(block, callsOf(index, block, r.uri)), callers.get(block)!);
      if (from.length) site.calledFrom = from;
    }
    (kind === "write" ? writes : reads).push(site);
  }
  return { writes, reads };
}

const describeMember = (m: Member) => `${m.section ? `${SECTION_LABEL[m.section] ?? m.section} ` : ""}**${m.name}** : \`${m.type}\`${m.comment ? ` — ${m.comment}` : ""}`;

export function hover(index: WorkspaceIndex, uri: string, offset: number): { markdown: string; start: number; end: number } | undefined {
  index = scopedTo(index, uri); // names mean the objects of this file's PLC
  const hit = refAt(index, uri, offset);
  if (!hit) {
    const a = argAt(index, uri, offset);
    const p = a && !a.param ? a.site.callee.params.find((x) => x.name.toUpperCase() === a.name.toUpperCase()) : undefined;
    if (a?.param) return { markdown: `${describeMember(a.param)}\n\nof ${a.site.callee.name}`, start: a.start, end: a.end };
    if (a && p) return { markdown: `${SECTION_LABEL[p.section]} **${p.name}** : \`${p.type}\`${p.documentation ? ` — ${p.documentation}` : ""}\n\nof ${a.site.callee.name}`, start: a.start, end: a.end };
    return typeHover(index, uri, offset);
  }
  const { block, ref, member } = hit;
  if (member >= 0) {
    const m = index.resolveChain(rootMembers(index, block, ref, uri), ref.members.slice(0, member + 1))[member];
    const seg = ref.members[member]!;
    return m ? { markdown: describeMember(m), start: seg.start, end: seg.end } : undefined;
  }
  if (ref.kind === "local") {
    const d = scopeDecl(index, uri, block, ref.name, ref.start);
    if (!d) return undefined;
    return { markdown: describeMember(d) + (d.init ? `\n\nStart value: \`${d.init}\`` : ""), start: ref.start, end: ref.end };
  }
  if (ref.kind === "call") {
    const std = STANDARD_BY_NAME.get(ref.name.toUpperCase());
    if (std) return { markdown: describeStandard(std), start: ref.start, end: ref.end };
    if (CONVERSION.test(ref.name.toUpperCase())) return { markdown: `**${ref.name}** — type conversion`, start: ref.start, end: ref.end };
    return undefined;
  }
  const g = index.global(ref.name);
  if (!g && ref.name.includes("~")) return { markdown: `Hardware identifier **${ref.name}** (a system constant of the device configuration)`, start: ref.start, end: ref.end };
  if (!g) return undefined;
  const to = g.techObject;
  if (to) return { markdown: `Technology object **${g.name}**${to.type ? ` : \`${to.type}\`` : ""}${to.number ? ` (DB ${to.number})` : ""}`, start: ref.start, end: ref.end };
  if (g.tag?.value !== undefined) return { markdown: `PLC constant **${g.name}** : \`${g.tag.dataType}\` = \`${g.tag.value}\` (table ${g.tag.table})`, start: ref.start, end: ref.end };
  if (g.tag) return { markdown: `PLC tag **${g.name}** : \`${g.tag.dataType}\`${g.tag.address ? ` at \`${g.tag.address}\`` : ""} (table ${g.tag.table})`, start: ref.start, end: ref.end };
  const b = g.block;
  if (!b) return { markdown: `**${g.name}** (graphical or protected object)`, start: ref.start, end: ref.end };
  const iface = b.vars.filter((v) => v.section === "Input" || v.section === "Output" || v.section === "InOut").map((v) => `- ${SECTION_LABEL[v.section]} ${v.name} : ${v.type}`);
  return { markdown: `**${b.kind} ${b.name}**${b.dbOf ? ` (of "${b.dbOf}")` : ""}${b.comment ? `\n\n${b.comment}` : ""}${iface.length ? `\n\n${iface.join("\n")}` : ""}`, start: ref.start, end: ref.end };
}

/** An instruction as TIA Portal's help shows it: signature, what it does, each parameter. */
export function describeStandard(std: CatalogEntry): string {
  const head =
    std.kind === "functionBlock"
      ? `**${std.name}** (function block: call it through an instance)`
      : `**${std.name}**(${std.params.map((p) => `${p.name} : ${p.type}`).join(", ")})${std.returns ? ` : ${std.returns}` : ""}`;
  const dir = { in: "Input", out: "Output", inout: "InOut" } as const;
  const rows = std.params.map((p) => `| ${p.name} | ${dir[p.dir]} | ${p.type} | ${p.note ?? ""} |`);
  const methods = std.methods?.length ? `\n\nCalled on the instance data: ${std.methods.map((m) => `\`#i.${m}(...)\``).join(", ")}` : "";
  return `${head}\n\n${std.doc}\n\n| Parameter | | Type | |\n|---|---|---|---|\n${rows.join("\n")}${methods}`;
}

/** Hover on a type name, where no reference is: `t : TON;`, `x : Int;`, `d : "UDT_Motor";`. */
function typeHover(index: WorkspaceIndex, uri: string, offset: number): { markdown: string; start: number; end: number } | undefined {
  const w = wordAt(index.docs.get(uri)?.text ?? "", offset);
  if (!w) return undefined;
  const { raw, word, start, end } = w;
  const upper = word.toUpperCase();
  const std = STANDARD_BY_NAME.get(upper);
  if (std && !raw.startsWith('"')) return { markdown: describeStandard(std), start, end };
  if (TYPE_INFO[upper] && !raw.startsWith('"')) return { markdown: `**${word}**: ${TYPE_INFO[upper]}`, start, end };
  const sys = SYSTEM_TYPES.get(upper);
  if (sys) return { markdown: `**${word}** (system data type)\n\n${sys.map((m) => `- ${m.name} : ${m.type}`).join("\n")}`, start, end };
  const b = raw.startsWith('"') ? index.global(word)?.block : undefined;
  if (b?.kind === "UDT") return { markdown: `**PLC data type ${b.name}**${b.comment ? `\n\n${b.comment}` : ""}\n\n${b.vars.map((v) => `- ${v.name} : ${v.type}`).join("\n")}`, start, end };
  if (b?.kind === "FB") return { markdown: `**FB ${b.name}**${b.comment ? `\n\n${b.comment}` : ""}`, start, end };
  return undefined;
}

/** Completions for the text before the cursor. */
export function complete(index: WorkspaceIndex, uri: string, offset: number, snippetSupport = false): Completion[] {
  index = scopedTo(index, uri); // names mean the objects of this file's PLC
  const doc = index.docs.get(uri);
  if (!doc) return [];
  const line = doc.text.slice(doc.text.lastIndexOf("\n", offset - 1) + 1, offset);
  const block = index.blockAt(uri, offset);
  // where an argument's name goes (right after "(" or ","): the parameters of the block called that the call does not name yet
  const site = callSites(index, uri, (b, n) => scopeDecl(index, uri, b, n), true).filter((s) => offset > s.open && offset <= s.close).sort((a, b) => b.open - a.open)[0];
  if (site && /(?:^|[(,])\s*[\p{L}_]?[\p{L}\p{N}_]*$/u.test(doc.text.slice(site.open, offset)) && !/:=|=>/.test(doc.text.slice(Math.max(site.open, doc.text.lastIndexOf(",", offset - 1)), offset))) {
    const given = new Set(site.args.map((a) => a.name?.toUpperCase()).filter(Boolean));
    const word = /[\p{L}\p{N}_]*$/u.exec(line)![0];
    return orderedParams(site.callee)
      .filter((p) => !given.has(p.name.toUpperCase()) || p.name.toUpperCase() === word.toUpperCase())
      .map((p) => ({ label: p.name, kind: "field" as const, detail: `${p.section} : ${p.type}`, insertText: `${p.name} ${p.section === "Output" ? "=>" : ":="} `, ...(p.documentation ? { documentation: p.documentation } : {}) }));
  }
  const templates = snippetSupport && /\.scl$/i.test(uri) && block?.bodyStart !== undefined && offset >= block.bodyStart;
  const template = (c: Completion, callee: CallSite["callee"] | undefined): Completion => {
    if (!templates || !callee) return c;
    // a name that is no plain identifier is written quoted; $ } and \ of names are text, not snippet syntax
    const text = (s: string) => s.replace(/[\\$}]/g, "\\$&");
    const param = (name: string) => (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? name : `"${name}"`);
    const args = orderedParams(callee).map((p, i) => `${text(param(p.name))} ${p.section === "Output" ? "=>" : ":="} \${${i + 1}}`).join(", ");
    return { ...c, insertText: `${text(c.insertText ?? c.label)}(${args})`, snippet: true };
  };
  // an instance is called where a statement starts, as TIA Portal inserts it; inside an expression it is read (#t.Q)
  const statementStart = /(^|;|\b(?:THEN|ELSE|DO|REPEAT)\b)\s*(#[\p{L}\p{N}_]*|"[^"]*|[\p{L}\p{N}_]*)$/iu.test(line);
  const instance = (v: VarDecl) => {
    if (!statementStart) return undefined;
    const name = (v.typeRef ?? v.type).replace(/^"|"$/g, "");
    const callee = paramsOf(index, name);
    return callee?.kind === "FB" || STANDARD_BY_NAME.get(name.toUpperCase())?.kind === "functionBlock" ? callee : undefined;
  };
  const memberCtx = /(#"[^"]+"|#[\p{L}\p{N}_]+|"[^"]+"|(?<![\p{L}\p{N}_#"])[\p{L}_][\p{L}\p{N}_]*)((?:\.[\p{L}\p{N}_"]+)*)\.([\p{L}\p{N}_]*)$/u.exec(line);
  if (memberCtx) {
    const head = memberCtx[1]!;
    const chain = memberCtx[2]!.split(".").filter(Boolean).map((n) => ({ name: n.replace(/"/g, "") }));
    let root: Member[] = [];
    const bare = !head.startsWith("#") && !head.startsWith('"');
    if (head.startsWith("#") && block) {
      const d = localDecl(block, head.slice(1).replace(/"/g, ""));
      root = d ? index.membersOf(d) : [];
    } else if (bare && block && localDecl(block, head)) {
      root = index.membersOf(localDecl(block, head)!); // IEC: locals need no '#'
    } else root = index.membersOfType(head.replace(/"/g, ""));
    let scope = root;
    for (const seg of chain) {
      const hit = scope.find((m) => m.name.toUpperCase() === seg.name.toUpperCase());
      scope = hit ? index.membersOf(hit) : [];
    }
    return scope.map((m) => ({ label: m.name, kind: "field", detail: m.type, ...(m.comment ? { documentation: m.comment } : {}) }));
  }
  if (/#[\p{L}\p{N}_]*$/u.test(line) && block) {
    const start = offset - /#[\p{L}\p{N}_]*$/u.exec(line)![0].length;
    return block.vars.map((v) => {
      const c = template({ label: v.name, kind: "variable", detail: `${SECTION_LABEL[v.section] ?? v.section} : ${v.type}` }, instance(v));
      return c.snippet ? { ...c, insertText: "#" + c.insertText, replaceStart: start } : c;
    });
  }
  const globalCtx = /"[^"]*$/.exec(line);
  if (globalCtx) {
    return index.allGlobals().map((g) => {
      const callee = g.kind === "FC" ? paramsOf(index, g.name) : g.kind === "DB" && g.block?.dbOf && statementStart ? paramsOf(index, g.block.dbOf) : undefined;
      const c = template({ label: g.name, kind: g.kind === "TAG" ? "constant" : g.kind === "UDT" ? "type" : g.kind === "DB" ? "module" : "class", detail: g.tag ? `${g.tag.dataType}${g.tag.address ? " " + g.tag.address : ""}` : g.kind, insertText: g.name + '"' }, callee);
      return c.snippet ? { ...c, insertText: '"' + c.insertText, replaceStart: offset - globalCtx[0].length } : c;
    });
  }
  const inType = /:\s*[\p{L}\p{N}_]*$/u.test(line) && block && (block.bodyStart === undefined || offset < block.bodyStart);
  if (inType) {
    return [
      ...ELEMENTARY_TYPES.map((t) => ({ label: t, kind: "type" as const })),
      ...STANDARD.filter((s) => s.kind === "functionBlock").map((s) => ({ label: s.name, kind: "class" as const, detail: "function block" })),
      ...index.allGlobals().filter((g) => g.kind === "UDT" || g.kind === "FB").map((g) => ({ label: `"${g.name}"`, kind: "type" as const, detail: g.kind })),
    ];
  }
  return [
    ...KEYWORDS.map((k) => ({ label: k, kind: "keyword" as const })),
    // an FB type such as TON is called through its instance (completed from #… or "…"), not by its type name
    ...STANDARD.map((s) => template({ label: s.name, kind: "function", detail: `${s.name}(${s.params.map((p) => p.name).join(", ")})`, documentation: s.doc }, s.kind === "function" ? paramsOf(index, s.name) : undefined)),
    ...(block?.vars ?? []).map((v) => template({ label: "#" + v.name, kind: "variable", detail: v.type }, instance(v))),
  ];
}

export interface TextEdit {
  uri: string;
  start: number;
  end: number;
  newText: string;
}

/** The block, data type or DB named at offset (its header or a use of it): TIA Portal renames those, not the editor. */
export function renameTarget(index: WorkspaceIndex, uri: string, offset: number): { uri: string; name: string } | undefined {
  index = scopedTo(index, uri); // names mean the objects of this file's PLC
  const block = index.blockAt(uri, offset);
  if (!block) return undefined;
  // a header names the object of its own file, whatever it says now (an unsaved edit may name another block)
  if (offset >= block.nameStart && offset <= block.nameEnd) return /\.(scl|db|udt)$/i.test(uri) && deviceOfUri(uri) !== undefined ? { uri, name: block.name } : undefined;
  const hit = refAt(index, uri, offset);
  if (!hit || hit.ref.kind !== "global" || hit.member >= 0) return undefined;
  const g = index.global(hit.ref.name);
  return g?.block && /\.(scl|db|udt|s7dcl|xml|awl)$/i.test(g.uri) && deviceOfUri(g.uri) !== undefined ? { uri: g.uri, name: g.name } : undefined;
}

/**
 * Renames a variable: a block's local in that block; a parameter or static of a block, a DB's or a data type's member
 * also in every file that names it (calls' arguments, instance members, DB start values). Blocks and globals are refused.
 */
export function rename(index: WorkspaceIndex, uri: string, offset: number, newName: string): TextEdit[] | { error: string } {
  index = scopedTo(index, uri); // names mean the objects of this file's PLC
  // a keyword or a name with spaces is a name TIA Portal takes quoted: "Valve 1" : Bool;, #"Valve 1"
  if (!newName.trim() || /["\u0000-\u001f]/.test(newName)) return { error: `${newName} cannot be a name in TIA Portal` };
  const name = /^[\p{L}_][\p{L}\p{N}_]*$/u.test(newName) && !KEYWORDS.includes(newName.toUpperCase()) ? newName : `"${newName}"`;
  const block = index.blockAt(uri, offset);
  if (!block) return { error: "Nothing to rename here" };
  let decl = declAt(block.vars, offset);
  if (!decl) {
    // from a use elsewhere: a named argument, an instance's or a DB's member, an instance DB's start value
    const hit = refAt(index, uri, offset);
    const target = hit ? (hit.member >= 0 || (hit.ref.kind === "local" && hit.block.kind === "DB" && hit.block.dbOf) ? definition(index, uri, offset) : undefined) : argAt(index, uri, offset)?.param;
    if (target?.uri !== undefined && target.start !== undefined && index.blockAt(target.uri, target.start)) return rename(index, target.uri, target.start, newName);
    if (!hit || hit.ref.kind !== "local" || hit.member >= 0) return { error: "Only variables can be renamed from the editor (blocks and globals are renamed in TIA Portal)" };
    decl = localDecl(block, hit.ref.name, hit.ref.start);
  }
  if (!decl) return { error: "Declaration not found" };
  const siblings = block.vars.includes(decl) ? block.vars : (function find(vars: VarDecl[]): VarDecl[] | undefined {
    for (const v of vars) if (v.members?.includes(decl!)) return v.members;
    for (const v of vars) { const f = v.members && find(v.members); if (f) return f; }
    return undefined;
  })(block.vars) ?? block.vars;
  if (siblings.some((v) => v !== decl && v.name.toUpperCase() === newName.toUpperCase())) return { error: `${newName} already exists in ${block.name}` };
  // a member of a STRUCT is seen from outside when the variable holding it is
  const top = block.vars.find((v) => v === decl || contains(v, decl)) ?? decl;
  const outside = visibleOutside(block, top);
  if (outside || top !== decl) {
    // every file that names it must be text the editor can change: a LAD/FBD block from XML or a TwinCAT POU is not
    const at = memberReferences(index, { uri, start: decl.start, end: decl.end }, true);
    const text = (l: { uri: string }) => index.docs.get(l.uri)?.code === undefined && /\.(scl|db|udt|st)$/i.test(l.uri);
    // a LAD/FBD block from XML, STL or a TwinCAT POU of this PLC that names the block (or its instance DBs) may use it unseen
    const names = [block.name, ...index.allGlobals().filter((g) => g.block?.dbOf?.toUpperCase() === block.name.toUpperCase()).map((g) => g.name)].map((n) => n.toUpperCase());
    const plc = deviceOfUri(uri);
    const unseen = (d: { uri: string; text: string }) => outside && !text(d) && d.uri !== uri && !TAG_TEXT.test(d.uri) && deviceOfUri(d.uri) === plc && names.some((n) => d.text.toUpperCase().includes(n));
    const locked = at.find((l) => !text(l)) ?? [...index.docs.values()].find(unseen);
    const where = locked && ("start" in locked ? index.blockAt(locked.uri, locked.start)?.name : locked.parsed?.blocks[0]?.name);
    if (locked) return { error: `${decl.name} may be used in ${where ?? locked.uri.split("/").at(-1)}, which the editor cannot change: rename it in TIA Portal` };
    return at.map((l) => ({ uri: l.uri, start: l.start, end: l.end, newText: index.docs.get(l.uri)!.text[l.start] === "#" ? "#" + name : name }));
  }
  const u = decl.name.toUpperCase();
  const text = index.docs.get(uri)?.code ?? index.docs.get(uri)?.text ?? "";
  const edits: TextEdit[] = [{ uri, start: decl.start, end: decl.end, newText: name }];
  // only the references to this declaration (a PROPERTY's GET and SET may each have a local of the name), written
  // as they were: #x in SCL, a bare x in IEC structured text
  for (const r of block.refs)
    if (r.kind === "local" && r.name.toUpperCase() === u && localDecl(block, r.name, r.start) === decl)
      edits.push({ uri, start: r.start, end: r.end, newText: text[r.start] === "#" ? "#" + name : name });
  return edits;
}
