// SPDX-License-Identifier: BUSL-1.1
// Semantic tokens: names coloured by what they are, not by how they look. An input, an output, a static, a
// temporary and a constant read differently; a DB, an FB, an FC, a tag and a data type too; a standard
// instruction is marked as the library's. Standard LSP types only, so every editor's theme colours them.
import { STANDARD_BY_NAME } from "./catalog.js";
import type { BlockModel, VarDecl } from "./parser.js";
import { scopedTo, type GlobalSymbol, type WorkspaceIndex } from "./workspace.js";

export const TOKEN_TYPES = ["parameter", "variable", "property", "function", "class", "namespace", "type"] as const;
export const TOKEN_MODIFIERS = ["declaration", "readonly", "static", "defaultLibrary", "modification"] as const;

type TokenType = (typeof TOKEN_TYPES)[number];
type Modifier = (typeof TOKEN_MODIFIERS)[number];

export interface SemanticToken {
  start: number;
  end: number;
  type: TokenType;
  modifiers: Modifier[];
}

/** A block-local by its section: inputs read only, outputs written, statics are the instance's memory. */
function ofLocal(v: VarDecl | undefined): Pick<SemanticToken, "type" | "modifiers"> {
  switch (v?.section) {
    case "Input":
      return { type: "parameter", modifiers: ["readonly"] };
    case "Output":
      return { type: "parameter", modifiers: ["modification"] };
    case "InOut":
      return { type: "parameter", modifiers: [] };
    case "Static":
      return { type: "property", modifiers: [] };
    case "Constant":
      return { type: "variable", modifiers: ["readonly"] };
    default:
      return { type: "variable", modifiers: [] };
  }
}

function ofGlobal(g: GlobalSymbol | undefined): Pick<SemanticToken, "type" | "modifiers"> | undefined {
  switch (g?.kind) {
    case "DB":
    case "GVL":
      return { type: "namespace", modifiers: ["static"] };
    case "FB":
    case "PRG":
      return { type: "class", modifiers: [] };
    case "FC":
    case "OB":
      return { type: "function", modifiers: [] };
    case "UDT":
      return { type: "type", modifiers: [] };
    case "TAG":
      return { type: "variable", modifiers: g.tag?.value !== undefined ? ["static", "readonly"] : ["static"] };
    case "GVAR":
      return { type: "variable", modifiers: ["static"] };
    default:
      return undefined;
  }
}

/** The tokens of a file, in order and without overlaps. */
export function semanticTokens(index: WorkspaceIndex, uri: string): SemanticToken[] {
  const doc = index.docs.get(uri);
  if (!doc?.parsed) return [];
  const seen = scopedTo(index, uri);
  const out: SemanticToken[] = [];
  const add = (start: number, end: number, t: Pick<SemanticToken, "type" | "modifiers"> | undefined, extra: Modifier[] = []) => {
    if (t && end > start) out.push({ start, end, type: t.type, modifiers: [...t.modifiers, ...extra] });
  };
  for (const b of doc.parsed.blocks) {
    const owner: BlockModel | undefined = b.owner ? seen.global(b.owner)?.block : undefined;
    const locals = new Map<string, VarDecl>();
    for (const v of [...(owner?.vars ?? []), ...b.vars]) locals.set(v.name.toUpperCase(), v);
    add(b.nameStart, b.nameEnd, ofGlobal(seen.global(b.name)) ?? { type: "function", modifiers: [] }, ["declaration"]);
    const decl = (vars: VarDecl[], member: boolean) => {
      for (const v of vars) {
        const at = doc.text.indexOf(v.name, v.start);
        if (at >= 0 && at < v.end) add(at, at + v.name.length, member ? { type: "property", modifiers: [] } : ofLocal(v), ["declaration"]);
        if (v.members) decl(v.members, true);
      }
    };
    decl(b.vars, false);
    for (const r of b.refs) {
      if (r.kind === "local") add(r.start, r.end, ofLocal(locals.get(r.name.toUpperCase())));
      else if (r.kind === "global") add(r.start, r.end, ofGlobal(seen.global(r.name)));
      else {
        // a plain name called: a standard instruction, or a block written without quotes
        const g = seen.global(r.name);
        add(r.start, r.end, g ? ofGlobal(g) : STANDARD_BY_NAME.has(r.name.toUpperCase()) ? { type: "function", modifiers: ["defaultLibrary"] } : undefined);
      }
      for (const m of r.members) add(m.start, m.end, { type: "property", modifiers: [] });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out.filter((t, i) => i === 0 || t.start >= out[i - 1]!.end);
}
