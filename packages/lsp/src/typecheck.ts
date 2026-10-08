// SPDX-License-Identifier: BUSL-1.1
// Assignments between elementary types as TIA Portal V20 compiles them (IEC check off, its default): which it
// refuses ("cannot be converted implicitly") and which it warns about ("the sign or the accuracy of the value may
// be lost"). The table is TIA Portal's own answer for all 552 pairs of 24 types (compiled 2026-10-06), so this
// says what TIA Portal will say, before a sync. A block's parameters follow the same table (576 of 576 pairs
// passed as inputs, compiled the same day). Only a variable on each side is judged (`a := b;`, `Param := #b`,
// `Param => #b`); an expression's type is not inferred here, and IN_OUT parameters are left out.
import type { Token } from "./lexer.js";
import type { BlockModel, Ref } from "./parser.js";
import { scopeDecl, type FeatureDiagnostic } from "./features.js";
import { callSites } from "./calls.js";
import { scopedTo, type Member, type WorkspaceIndex } from "./workspace.js";

const TYPES = ["BOOL", "BYTE", "WORD", "DWORD", "LWORD", "SINT", "INT", "DINT", "LINT", "USINT", "UINT", "UDINT", "ULINT", "REAL", "LREAL", "TIME", "LTIME", "CHAR", "WCHAR", "STRING", "WSTRING", "DATE", "TIME_OF_DAY", "S5TIME"];
/** Row: the target type; column: the source type. '.' converts, 'w' converts with a warning, 'X' is refused. */
const MATRIX: Record<string, string> = {
  BOOL: "=XXXXXXXXXXXXXXXXXXXXXXX",
  BYTE: "X=wwwwwww.wwwXXXX.wXXXXX",
  WORD: "X.=wwwwww..wwXXXX..XX.X.",
  DWORD: "X..=wwwww...wwXwX..XXX.X",
  LWORD: "X...=wwww....XwXw..XXXXX",
  SINT: "Xwwww=wwwwwwwwwXXwwXXXXX",
  INT: "X.www.=ww.wwwwwXX.wXXwXX",
  DINT: "X..ww..=w..wwww.X..XXXwX",
  LINT: "X...w...=...wwwX...XXXXX",
  USINT: "X.wwwwwww=wwwwwXX.wXXXXX",
  UINT: "X..wwwwww.=wwwwXX..XX.XX",
  UDINT: "X...wwwww..=wwwwX..XXX.X",
  ULINT: "X....wwww...=wwXw..XXXXX",
  REAL: "XXX.X...w...w=wXXXXXXXXX",
  LREAL: "XXXX..........=XXXXXXXXX",
  TIME: "XXXwXXX.XXXwXXX=wXXXXX.X",
  LTIME: "XXXXwXXX.XXXwXX.=XXXXXXX",
  CHAR: "X.wwwwwww.wwwXXXX=XwXXXX",
  WCHAR: "X..wwwwww..wwXXXXX=XwXXX",
  STRING: "XXXXXXXXXXXXXXXXX.X=XXXX",
  WSTRING: "XXXXXXXXXXXXXXXXXX.X=XXX",
  DATE: "XX.XXXwXXX.XXXXXXXXXX=XX",
  TIME_OF_DAY: "XXX.XXXwXXX.XXXwXXXXXX=X",
  S5TIME: "XX.XXXXXXXXXXXXXXXXXXXX=",
};
const ALIAS: Record<string, string> = { TOD: "TIME_OF_DAY" };

/** The elementary type a declaration names, as the table writes it (String[20] is STRING), or none. */
function elementary(type: string | undefined): string | undefined {
  if (!type) return undefined;
  const t = type.trim().toUpperCase().replace(/\s*\[\s*\d+\s*\]$/, "");
  const name = ALIAS[t] ?? t;
  return TYPES.includes(name) ? name : undefined;
}

/** What TIA Portal does with `target := source` between two elementary types. */
export function conversion(target: string, source: string): "same" | "ok" | "warning" | "error" | undefined {
  const a = elementary(target);
  const b = elementary(source);
  if (!a || !b) return undefined;
  const c = MATRIX[a]![TYPES.indexOf(b)];
  return c === "=" ? "same" : c === "." ? "ok" : c === "w" ? "warning" : "error";
}

/** The declaration a name path (#a.b, "DB".x) means, when it is known all the way. */
function declOf(index: WorkspaceIndex, uri: string, block: BlockModel, r: Ref): Member | { type: string } | undefined {
  let decl: Member | { type: string; members?: Member[]; typeRef?: string } | undefined;
  if (r.kind === "local") decl = scopeDecl(index, uri, block, r.name, r.start);
  else if (r.kind === "global") {
    const g = scopedTo(index, uri).global(r.name);
    if (g?.tag) decl = { type: g.tag.dataType };
    else if (g?.kind === "DB" && g.block) decl = g.block.dbOf ? { type: `"${g.block.dbOf}"`, typeRef: g.block.dbOf } : { type: "DB", members: g.block.vars.map((v) => ({ ...v, uri: g.uri })) };
  }
  for (const m of r.members) {
    if (!decl) return undefined;
    const members: Member[] = "members" in decl && decl.members?.length ? decl.members : "typeRef" in decl && decl.typeRef ? index.membersOfType(decl.typeRef) : [];
    decl = members.find((x) => x.name.toUpperCase() === m.name.toUpperCase());
  }
  return decl && !("isArray" in decl && decl.isArray) ? decl : undefined;
}

/** `a := b;` assignments TIA Portal would refuse or warn about. */
export function typeMismatches(index: WorkspaceIndex, uri: string, block: BlockModel, tokens: Token[], text: string): FeatureDiagnostic[] {
  if (block.bodyStart === undefined) return [];
  const out: FeatureDiagnostic[] = [];
  const end = (r: Ref) => (r.members.length ? r.members[r.members.length - 1]!.end : r.end);
  const at = new Map(block.refs.map((r) => [r.start, r]));
  const tokenAt = new Map(tokens.map((t, i) => [t.start, i]));
  for (const lhs of block.refs) {
    if (lhs.access !== "write" || lhs.start < block.bodyStart) continue;
    if (text[end(lhs)] === "[") continue; // an element: its type is the array's element type (not judged)
    let i = tokens.findIndex((t) => t.start >= end(lhs));
    if (i < 0 || tokens[i]!.text !== ":=") continue;
    // the statement starts with the target
    const before = tokens[(tokenAt.get(lhs.start) ?? 0) - 1];
    if (before && !(before.kind === "comment" || (before.kind === "op" && (before.text === ";" || before.text === ":")) || (before.kind === "ident" && ["THEN", "ELSE", "DO", "BEGIN", "REPEAT"].includes(before.upper)))) continue;
    const rhsTok = tokens[i + 1];
    const rhs = rhsTok && at.get(rhsTok.start);
    if (!rhs || rhs.access === "call") continue;
    i = tokens.findIndex((t) => t.start >= end(rhs));
    if (i < 0 || tokens[i]!.text !== ";") continue; // more than one name on the right: an expression
    const a = declOf(index, uri, block, lhs);
    const b = declOf(index, uri, block, rhs);
    if (!a || !b) continue;
    const c = conversion(a.type, b.type);
    if (c === "error") out.push({ start: rhs.start, end: end(rhs), severity: "error", code: "TYPE_MISMATCH", message: `Data type '${b.type}' cannot be converted implicitly into data type '${a.type}' (TIA Portal refuses it; convert explicitly, e.g. ${elementary(b.type)}_TO_${elementary(a.type)})` });
    else if (c === "warning") out.push({ start: rhs.start, end: end(rhs), severity: "warning", code: "TYPE_NARROWING", message: `${a.type} := ${b.type}: the sign or the accuracy of the value may be lost (TIA Portal warns when compiling)` });
  }
  return out;
}

/** Arguments of block calls passed between elementary types TIA Portal refuses or warns about. */
export function argumentMismatches(index: WorkspaceIndex, uri: string): FeatureDiagnostic[] {
  const doc = index.docs.get(uri);
  if (!doc?.parsed) return [];
  const out: FeatureDiagnostic[] = [];
  const end = (r: Ref) => (r.members.length ? r.members[r.members.length - 1]!.end : r.end);
  for (const site of callSites(index, uri, (b, n) => scopeDecl(index, uri, b, n))) {
    if (site.callee.kind === "std") continue;
    const block = index.blockAt(uri, site.ref.start);
    if (!block) continue;
    for (const a of site.args) {
      if (!a.name || a.nameEnd === undefined) continue;
      const param = site.callee.params.find((p) => p.name.toUpperCase() === a.name!.toUpperCase());
      if (!param || param.section === "InOut") continue;
      // the value is one name, nothing else: `Param := #x` / `Param => #x`
      const value = block.refs.find((r) => r.start > a.nameEnd! && r.start < a.end);
      if (!value || value.access === "call" || doc.text.slice(end(value), a.end).trim() || doc.text.slice(a.nameEnd, value.start).replace(/:=|=>/, "").trim()) continue;
      const v = declOf(index, uri, block, value);
      if (!v) continue;
      const [target, source] = a.out ? [v.type, param.type] : [param.type, v.type];
      const c = conversion(target, source);
      const what = a.out ? `${param.name} => ${doc.text.slice(value.start, end(value))}` : `${param.name} := ${doc.text.slice(value.start, end(value))}`;
      if (c === "error") out.push({ start: value.start, end: end(value), severity: "error", code: "TYPE_MISMATCH", message: `Data type '${source}' cannot be converted implicitly into data type '${target}' (${what}; TIA Portal refuses it)` });
      else if (c === "warning") out.push({ start: value.start, end: end(value), severity: "warning", code: "TYPE_NARROWING", message: `${what}: ${target} from ${source}, the sign or the accuracy of the value may be lost (TIA Portal warns when compiling)` });
    }
  }
  return out;
}
