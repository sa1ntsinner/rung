// SPDX-License-Identifier: BUSL-1.1
// Editor features as pure functions over the workspace index (the LSP server only adapts them).
import { CONVERSION, ELEMENTARY_TYPES, KEYWORDS, STANDARD, STANDARD_BY_NAME } from "./catalog.js";
import type { BlockModel, Ref, VarDecl } from "./parser.js";
import type { Member, WorkspaceIndex } from "./workspace.js";

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
}

export interface OutlineSymbol {
  name: string;
  detail?: string;
  kind: "block" | "section" | "variable" | "region";
  start: number;
  end: number;
  children: OutlineSymbol[];
}

const SECTION_LABEL: Record<string, string> = { Input: "VAR_INPUT", Output: "VAR_OUTPUT", InOut: "VAR_IN_OUT", Static: "VAR", Temp: "VAR_TEMP", Constant: "VAR CONSTANT" };

function localDecl(block: BlockModel, name: string): VarDecl | undefined {
  const u = name.toUpperCase();
  return block.vars.find((v) => v.name.toUpperCase() === u);
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

function rootMembers(index: WorkspaceIndex, block: BlockModel, ref: Ref): Member[] {
  if (ref.kind === "local") {
    const d = localDecl(block, ref.name);
    return d ? index.membersOf(d) : [];
  }
  if (ref.kind === "global") {
    const g = index.global(ref.name);
    if (g?.block) return index.membersOfType(g.name);
  }
  return [];
}

export function diagnostics(index: WorkspaceIndex, uri: string): FeatureDiagnostic[] {
  const doc = index.docs.get(uri);
  if (!doc?.parsed) return [];
  const out: FeatureDiagnostic[] = doc.parsed.diagnostics.map((d) => ({ start: d.start, end: d.end, severity: d.severity, message: d.message, code: "SYNTAX" }));
  for (const block of doc.parsed.blocks) {
    for (const ref of block.refs) {
      if (ref.kind === "local") {
        const known = localDecl(block, ref.name) || ref.name.toUpperCase() === block.name.toUpperCase();
        if (!known) {
          out.push({ start: ref.start, end: ref.end, severity: "warning", message: `#${ref.name} is not declared in ${block.name}`, code: "UNDECLARED" });
          continue;
        }
      }
      if (ref.kind === "global" && !index.global(ref.name)) {
        out.push({ start: ref.start, end: ref.end, severity: "information", message: `"${ref.name}" is not in the workspace (system object or not mirrored)`, code: "UNKNOWN_GLOBAL" });
        continue;
      }
      // Member names: only report when the type is known completely.
      const root = rootMembers(index, block, ref);
      if (!root.length) continue;
      const chain = index.resolveChain(root, ref.members);
      for (let i = 0; i < chain.length; i++) {
        if (chain[i]) continue;
        const m = ref.members[i]!;
        out.push({ start: m.start, end: m.end, severity: "warning", message: `${m.name} is not a member of ${i === 0 ? ref.name : ref.members[i - 1]!.name}`, code: "UNKNOWN_MEMBER" });
        break;
      }
    }
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
  const hit = refAt(index, uri, offset);
  if (!hit) return undefined;
  const { block, ref, member } = hit;
  if (member < 0) {
    if (ref.kind === "local") {
      const d = localDecl(block, ref.name);
      return d ? { uri, start: d.start, end: d.end } : undefined;
    }
    const g = index.global(ref.name);
    return g ? { uri: g.uri, start: g.start, end: g.end } : undefined;
  }
  const chain = index.resolveChain(rootMembers(index, block, ref), ref.members.slice(0, member + 1));
  const m = chain[member];
  return m?.uri !== undefined && m.start !== undefined ? { uri: m.uri, start: m.start, end: m.end! } : undefined;
}

export function references(index: WorkspaceIndex, uri: string, offset: number, includeDeclaration = true): Location[] {
  const hit = refAt(index, uri, offset);
  const out: Location[] = [];
  if (hit && hit.member < 0 && hit.ref.kind === "local") {
    const u = hit.ref.name.toUpperCase();
    for (const r of hit.block.refs) if (r.kind === "local" && r.name.toUpperCase() === u) out.push({ uri, start: r.start, end: r.end });
    const d = localDecl(hit.block, hit.ref.name);
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
  for (const d of index.docs.values())
    for (const b of d.parsed?.blocks ?? []) {
      for (const r of b.refs) if (r.kind === "global" && r.name.toUpperCase() === u) out.push({ uri: d.uri, start: r.start, end: r.end });
      for (const v of b.vars) if (v.typeRef?.toUpperCase() === u && v.type.startsWith('"')) out.push({ uri: d.uri, start: v.start, end: v.end });
      if (b.dbOf?.toUpperCase() === u) out.push({ uri: d.uri, start: b.nameStart, end: b.nameEnd });
    }
  return out;
}

const describeMember = (m: Member) => `${m.section ? `${SECTION_LABEL[m.section] ?? m.section} ` : ""}**${m.name}** : \`${m.type}\`${m.comment ? ` — ${m.comment}` : ""}`;

export function hover(index: WorkspaceIndex, uri: string, offset: number): { markdown: string; start: number; end: number } | undefined {
  const hit = refAt(index, uri, offset);
  if (!hit) return undefined;
  const { block, ref, member } = hit;
  if (member >= 0) {
    const m = index.resolveChain(rootMembers(index, block, ref), ref.members.slice(0, member + 1))[member];
    const seg = ref.members[member]!;
    return m ? { markdown: describeMember(m), start: seg.start, end: seg.end } : undefined;
  }
  if (ref.kind === "local") {
    const d = localDecl(block, ref.name);
    if (!d) return undefined;
    return { markdown: describeMember(d) + (d.init ? `\n\nStart value: \`${d.init}\`` : ""), start: ref.start, end: ref.end };
  }
  if (ref.kind === "call") {
    const std = STANDARD_BY_NAME.get(ref.name.toUpperCase());
    if (std) return { markdown: `**${std.name}**(${std.params.map((p) => `${p.name} : ${p.type}`).join(", ")})${std.returns ? ` : ${std.returns}` : ""}\n\n${std.doc}`, start: ref.start, end: ref.end };
    if (CONVERSION.test(ref.name.toUpperCase())) return { markdown: `**${ref.name}** — type conversion`, start: ref.start, end: ref.end };
    return undefined;
  }
  const g = index.global(ref.name);
  if (!g) return undefined;
  if (g.tag) return { markdown: `PLC tag **${g.name}** : \`${g.tag.dataType}\`${g.tag.address ? ` at \`${g.tag.address}\`` : ""} (table ${g.tag.table})`, start: ref.start, end: ref.end };
  const b = g.block;
  if (!b) return { markdown: `**${g.name}** (graphical or protected object)`, start: ref.start, end: ref.end };
  const iface = b.vars.filter((v) => v.section === "Input" || v.section === "Output" || v.section === "InOut").map((v) => `- ${SECTION_LABEL[v.section]} ${v.name} : ${v.type}`);
  return { markdown: `**${b.kind} ${b.name}**${b.dbOf ? ` (of "${b.dbOf}")` : ""}${b.comment ? `\n\n${b.comment}` : ""}${iface.length ? `\n\n${iface.join("\n")}` : ""}`, start: ref.start, end: ref.end };
}

/** Completions for the text before the cursor. */
export function complete(index: WorkspaceIndex, uri: string, offset: number): Completion[] {
  const doc = index.docs.get(uri);
  if (!doc) return [];
  const line = doc.text.slice(doc.text.lastIndexOf("\n", offset - 1) + 1, offset);
  const block = index.blockAt(uri, offset);
  const memberCtx = /(#"[^"]+"|#[\p{L}\p{N}_]+|"[^"]+")((?:\.[\p{L}\p{N}_"]+)*)\.([\p{L}\p{N}_]*)$/u.exec(line);
  if (memberCtx) {
    const head = memberCtx[1]!;
    const chain = memberCtx[2]!.split(".").filter(Boolean).map((n) => ({ name: n.replace(/"/g, "") }));
    let root: Member[] = [];
    if (head.startsWith("#") && block) {
      const d = localDecl(block, head.slice(1).replace(/"/g, ""));
      root = d ? index.membersOf(d) : [];
    } else root = index.membersOfType(head.replace(/"/g, ""));
    let scope = root;
    for (const seg of chain) {
      const hit = scope.find((m) => m.name.toUpperCase() === seg.name.toUpperCase());
      scope = hit ? index.membersOf(hit) : [];
    }
    return scope.map((m) => ({ label: m.name, kind: "field", detail: m.type, ...(m.comment ? { documentation: m.comment } : {}) }));
  }
  if (/#[\p{L}\p{N}_]*$/u.test(line) && block) {
    return block.vars.map((v) => ({ label: v.name, kind: "variable" as const, detail: `${SECTION_LABEL[v.section] ?? v.section} : ${v.type}` }));
  }
  if (/"[^"]*$/.test(line)) {
    return index.allGlobals().map((g) => ({ label: g.name, kind: g.kind === "TAG" ? "constant" : g.kind === "UDT" ? "type" : g.kind === "DB" ? "module" : "class", detail: g.tag ? `${g.tag.dataType}${g.tag.address ? " " + g.tag.address : ""}` : g.kind, insertText: g.name + '"' }));
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
    ...STANDARD.map((s) => ({ label: s.name, kind: "function" as const, detail: `${s.name}(${s.params.map((p) => p.name).join(", ")})`, documentation: s.doc })),
    ...(block?.vars ?? []).map((v) => ({ label: "#" + v.name, kind: "variable" as const, detail: v.type })),
  ];
}

export interface TextEdit {
  uri: string;
  start: number;
  end: number;
  newText: string;
}

/** Renames a block-local variable (declaration and every #reference). Other renames are refused. */
export function rename(index: WorkspaceIndex, uri: string, offset: number, newName: string): TextEdit[] | { error: string } {
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(newName)) return { error: `${newName} is not a valid SCL identifier` };
  const block = index.blockAt(uri, offset);
  if (!block) return { error: "Nothing to rename here" };
  let decl = block.vars.find((v) => offset >= v.start && offset <= v.end);
  if (!decl) {
    const hit = refAt(index, uri, offset);
    if (!hit || hit.ref.kind !== "local" || hit.member >= 0) return { error: "Only local variables can be renamed from the editor (blocks and globals are renamed in TIA Portal)" };
    decl = localDecl(block, hit.ref.name);
  }
  if (!decl) return { error: "Declaration not found" };
  if (localDecl(block, newName)) return { error: `${newName} already exists in ${block.name}` };
  const u = decl.name.toUpperCase();
  const edits: TextEdit[] = [{ uri, start: decl.start, end: decl.end, newText: newName }];
  for (const r of block.refs) if (r.kind === "local" && r.name.toUpperCase() === u) edits.push({ uri, start: r.start, end: r.end, newText: block.kind === "DB" ? newName : "#" + newName });
  return edits;
}
