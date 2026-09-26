// SPDX-License-Identifier: BUSL-1.1
// Workspace-wide symbol index: blocks, data blocks, UDTs and PLC tags, with member resolution.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LineIndex } from "./lexer.js";
import { parse, type BlockModel, type ParsedDocument, type VarDecl } from "./parser.js";
import { STANDARD_BY_NAME } from "./catalog.js";

export type SymbolKind = "FB" | "FC" | "OB" | "DB" | "UDT" | "TAG" | "OBJECT";

export interface GlobalSymbol {
  name: string;
  kind: SymbolKind;
  uri: string;
  start: number;
  end: number;
  block?: BlockModel;
  tag?: { dataType: string; address?: string; table: string };
}

export interface Doc {
  uri: string;
  text: string;
  lines: LineIndex;
  parsed?: ParsedDocument;
  version: number;
}

/** Member view of a type: variables with their declarations (uri/offset) or catalog parameters. */
export interface Member {
  name: string;
  type: string;
  typeRef?: string;
  isArray: boolean;
  members?: VarDecl[];
  comment?: string;
  uri?: string;
  start?: number;
  end?: number;
  section?: string;
}

const SOURCE = /\.(scl|db|udt|awl)$/i;
const OTHER = /\.(s7dcl|xml|protected\.yaml)$/i;

export function uriOf(path: string): string {
  return pathToFileURL(path).href;
}

export class WorkspaceIndex {
  readonly docs = new Map<string, Doc>();
  private globals = new Map<string, GlobalSymbol[]>();
  private dirty = true;

  /** Loads every mirrored object under <root>/plc (sources parsed, other forms indexed by name). */
  async load(root: string): Promise<void> {
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (SOURCE.test(e.name) || OTHER.test(e.name) || e.name.endsWith(".tags.xml")) this.set(uriOf(p), await readFile(p, "utf8"), 0);
      }
    };
    await walk(join(root, "plc"));
  }

  set(uri: string, text: string, version: number): Doc {
    const doc: Doc = { uri, text, lines: new LineIndex(text), version };
    if (SOURCE.test(uri)) doc.parsed = parse(text);
    this.docs.set(uri, doc);
    this.dirty = true;
    return doc;
  }

  remove(uri: string) {
    this.docs.delete(uri);
    this.dirty = true;
  }

  private rebuild() {
    if (!this.dirty) return;
    const g = new Map<string, GlobalSymbol[]>();
    const add = (s: GlobalSymbol) => {
      const k = s.name.toUpperCase();
      g.set(k, [...(g.get(k) ?? []), s]);
    };
    for (const d of this.docs.values()) {
      if (d.parsed) for (const b of d.parsed.blocks) add({ name: b.name, kind: b.kind, uri: d.uri, start: b.nameStart, end: b.nameEnd, block: b });
      else if (d.uri.endsWith(".tags.xml")) for (const t of parseTags(d.text, d.uri)) add(t);
      else {
        // LAD/FBD/GRAPH/protected objects: known by name only
        const leaf = decodeURIComponent(d.uri.split("/").pop()!).replace(/\.(s7dcl|xml|protected\.yaml)$/i, "");
        const name = leaf.includes("~") ? leaf.split("~").pop()! : leaf;
        add({ name: name.replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), kind: "OBJECT", uri: d.uri, start: 0, end: 0 });
      }
    }
    this.globals = g;
    this.dirty = false;
  }

  global(name: string): GlobalSymbol | undefined {
    this.rebuild();
    return this.globals.get(name.toUpperCase())?.[0];
  }

  allGlobals(): GlobalSymbol[] {
    this.rebuild();
    return [...this.globals.values()].flat();
  }

  /** The block containing `offset` in `uri`. */
  blockAt(uri: string, offset: number): BlockModel | undefined {
    return this.docs.get(uri)?.parsed?.blocks.find((b) => offset >= b.start && offset <= b.end);
  }

  /** Members of a named type: UDT, FB (instance view), DB of a UDT/FB, or a standard FB from the catalog. */
  membersOfType(typeRef: string | undefined, seen = new Set<string>()): Member[] {
    if (!typeRef) return [];
    const key = typeRef.toUpperCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const g = this.global(typeRef);
    if (g?.block) {
      const b = g.block;
      if (b.kind === "DB" && b.dbOf) return this.membersOfType(b.dbOf, seen);
      const visible = b.kind === "FB" ? b.vars.filter((v) => v.section !== "Temp" && v.section !== "Constant") : b.vars;
      return visible.map((v) => ({ ...v, uri: g.uri }));
    }
    const std = STANDARD_BY_NAME.get(key);
    if (std?.kind === "functionBlock") return std.params.map((p) => ({ name: p.name, type: p.type, typeRef: p.type, isArray: false, section: p.dir === "in" ? "Input" : p.dir === "out" ? "Output" : "InOut" }));
    return [];
  }

  /** Members reachable from a declaration (inline struct or named type). */
  membersOf(m: Member | VarDecl): Member[] {
    if (m.members?.length) return m.members.map((v) => ({ ...v, uri: (m as Member).uri }));
    return this.membersOfType(m.typeRef);
  }

  /** Resolves a member chain starting from a list of candidate members. */
  resolveChain(start: Member[], chain: { name: string }[]): (Member | undefined)[] {
    const out: (Member | undefined)[] = [];
    let scope = start;
    for (const seg of chain) {
      const hit = scope.find((m) => m.name.toUpperCase() === seg.name.toUpperCase());
      out.push(hit);
      scope = hit ? this.membersOf(hit) : [];
    }
    return out;
  }
}

/** Extracts tags from a SimaticML tag-table export (regex-based; the files are machine-generated). */
export function parseTags(xml: string, uri: string): GlobalSymbol[] {
  const out: GlobalSymbol[] = [];
  const table = /<SW\.Tags\.PlcTagTable[\s\S]*?<Name>([^<]*)<\/Name>/.exec(xml)?.[1] ?? "";
  const re = /<SW\.Tags\.PlcTag\b[\s\S]*?<\/SW\.Tags\.PlcTag>/g;
  for (const m of xml.matchAll(re)) {
    const body = m[0];
    const name = /<Name>([^<]*)<\/Name>/.exec(body);
    if (!name) continue;
    const nameAt = m.index! + body.indexOf(name[0]) + "<Name>".length;
    const dataType = /<DataTypeName>([^<]*)<\/DataTypeName>/.exec(body)?.[1] ?? "?";
    const address = /<LogicalAddress>([^<]*)<\/LogicalAddress>/.exec(body)?.[1];
    const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    out.push({ name: decode(name[1]!), kind: "TAG", uri, start: nameAt, end: nameAt + name[1]!.length, tag: { dataType: decode(dataType), ...(address ? { address } : {}), table } });
  }
  return out;
}
