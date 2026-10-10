// SPDX-License-Identifier: BUSL-1.1
// Workspace-wide symbol index: blocks, data blocks, UDTs and PLC tags, with member resolution.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { parseAddress } from "@rung/core";
import { LineIndex } from "./lexer.js";
import { parse, type BlockModel, type ParsedDocument, type VarDecl } from "./parser.js";
import { STANDARD_BY_NAME, SYSTEM_TYPES } from "./catalog.js";
import { TWINCAT_FILE, extractTwinCat } from "./twincat.js";
import { isSimaticMl, parseSimaticMl } from "./simaticml.js";
import { parseSd } from "./simaticsd.js";

export type SymbolKind = "FB" | "FC" | "OB" | "DB" | "UDT" | "PRG" | "GVL" | "GVAR" | "TAG" | "OBJECT";

export interface GlobalSymbol {
  name: string;
  kind: SymbolKind;
  uri: string;
  start: number;
  end: number;
  block?: BlockModel;
  /** PLC tag, or a user constant (`value` set) from a tag table. */
  tag?: { dataType: string; address?: string; table: string; value?: string };
  /** For GVAR: the variable declaration and its list. */
  gvar?: { decl: VarDecl; list: string };
  /** For a technology object: its type (TO_SpeedAxis, TO_PositioningAxis) and DB number, when known. */
  techObject?: { type?: string; number?: string };
}

/** A technology object known by name (from its XML export or the `rung views` YAML of its PLC). */
export interface NamedObject {
  name: string;
  start: number;
  end: number;
  type?: string;
  number?: string;
}

export interface Doc {
  uri: string;
  text: string;
  lines: LineIndex;
  parsed?: ParsedDocument;
  /** Text the parser saw (blanked XML for TwinCAT files); offsets match `text`. */
  code?: string;
  version: number;
  /** SimaticML tag table (rung `*.tags.xml`, VCI `PLC tags/*.xml`). */
  tagTable?: boolean;
  /** Named objects without a usable interface (technology objects). */
  objects?: NamedObject[];
}

/** Member view of a type: variables with their declarations (uri/offset) or catalog parameters. */
export interface Member {
  name: string;
  type: string;
  typeRef?: string;
  isArray: boolean;
  members?: VarDecl[];
  init?: string;
  comment?: string;
  uri?: string;
  start?: number;
  end?: number;
  section?: string;
}

/** How the workspace folder is organised. */
export type WorkspaceLayout = "rung" | "vci" | "iec";

const SOURCE = /\.(scl|db|udt|awl)$/i;
const IEC_SOURCE = /\.st$/i;
const XML = /\.xml$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".rung", ".vci", "_Boot", "_CompileInfo", "_Libraries", "bin", "obj", "dist", "views"]);
const OTHER = /\.(s7dcl|xml|protected\.yaml)$/i;
const SD = /\.s7dcl$/i;
/** A PLC's technology objects as `rung views` lists them. */
const TECH_VIEW = /\/views\/techobjects\/[^/]+\.yaml$/i;
/** Top-level folders of a TIA Portal VCI (version control interface) export. */
const VCI_DIRS = new Set(["program blocks", "plc tags", "plc data types", "technology objects", ".vci"]);

export function uriOf(path: string): string {
  return pathToFileURL(path).href;
}

export class WorkspaceIndex {
  readonly docs = new Map<string, Doc>();
  private globals = new Map<string, GlobalSymbol[]>();
  private dirty = true;
  /** Set by load(): rung workspace, TIA VCI export, or IEC/TwinCAT/loose sources. */
  layout?: WorkspaceLayout;

  /**
   * Loads <root>/plc of a rung workspace and the technology objects of its views; otherwise every source under
   * root: TIA VCI exports (`Program blocks/`, `PLC tags/`, `PLC data types/`, `Technology objects/`),
   * TwinCAT/CODESYS projects and loose SCL/ST files.
   */
  async load(root: string): Promise<void> {
    if (!(await isRungLayout(root))) return this.loadTree(root);
    this.layout = "rung";
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
        else if (SOURCE.test(e.name) || OTHER.test(e.name) || IEC_SOURCE.test(e.name) || e.name.endsWith(".tags.xml")) this.set(uriOf(p), await readFile(p, "utf8"), 0);
      }
    };
    await walk(join(root, "plc"));
    // TIA Portal exports no text of a technology object: the code names them, `rung views` lists them
    const views = join(root, "views", "techobjects");
    const files = await readdir(views).catch(() => [] as string[]);
    for (const f of files) if (f.endsWith(".yaml")) this.set(uriOf(join(views, f)), await readFile(join(views, f), "utf8"), 0);
  }

  private async loadTree(root: string): Promise<void> {
    this.layout = "iec";
    const walk = async (dir: string, inTechnology: boolean): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory() && VCI_DIRS.has(e.name.toLowerCase())) this.layout = "vci";
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p, inTechnology || e.name.toLowerCase() === "technology objects");
        else if (TWINCAT_FILE.test(e.name) || IEC_SOURCE.test(e.name) || SOURCE.test(e.name) || XML.test(e.name)) {
          const text = await readFile(p, "utf8");
          if (text.includes("\u0000")) continue; // binary files (a TIA project's SQLite *.db) are not sources
          // XML: SimaticML exports only (other XML, e.g. TwinCAT project files, is not PLC code); technology
          // objects are indexed by name even when their XML is not SimaticML
          if (XML.test(e.name) && !isSimaticMl(text) && !inTechnology) continue;
          this.set(uriOf(p), text, 0);
        }
      }
    };
    await walk(root, false);
  }

  set(uri: string, text: string, version: number): Doc {
    const doc: Doc = { uri, text, lines: new LineIndex(text), version };
    if (SOURCE.test(uri)) doc.parsed = parse(text, /\.awl$/i.test(uri) ? { dialect: "stl" } : {});
    else if (/\.protected\.yaml$/i.test(uri)) {
      // Public system-instance type only: protected bodies and user FBs stay opaque.
      try {
        if (text.length > 65536) throw new Error("metadata too large");
        const yaml = parseDocument(text, { uniqueKeys: true });
        if (yaml.errors.length) throw new Error("invalid metadata");
        const m = yaml.toJS({ maxAliasCount: 0 });
        const type = typeof m?.instanceOf === "string" ? STANDARD_BY_NAME.get(m.instanceOf.toUpperCase()) : undefined;
        if (m?.kind === "block" && m.blockType === "InstanceDB" && m.isSystem === true && m.readOnly === true && type?.kind === "functionBlock") {
          const address = parseAddress(m.address);
          if (address.kind === "block") doc.parsed = { blocks: [{ kind: "DB", name: address.name, nameStart: 0, nameEnd: 0, start: 0, end: text.length, vars: [], regions: [], refs: [], dbOf: type.name }], diagnostics: [], tokens: [] };
        }
      } catch { /* malformed or unsupported metadata remains opaque */ }
    }
    else if (SD.test(uri)) {
      // unreadable SD stays known by its file name, like other graphical objects
      const sd = parseSd(text);
      if (sd.blocks.length) doc.parsed = sd;
    }
    else if (IEC_SOURCE.test(uri)) doc.parsed = parse(text, { dialect: "iec", unitName: decodeURIComponent(uri.split("/").pop()!).replace(/\.st$/i, "") });
    else if (TWINCAT_FILE.test(uri)) {
      const unit = extractTwinCat(text);
      doc.code = unit.code;
      doc.parsed = parse(unit.code, { dialect: "iec", ...(unit.name ? { unitName: unit.name } : {}) });
    } else if (TECH_VIEW.test(uri)) doc.objects = techObjectsOfView(text);
    else if (XML.test(uri)) {
      doc.tagTable = uri.endsWith(".tags.xml") || /<SW\.Tags\.PlcTagTable\b/.test(text);
      if (!doc.tagTable && isSimaticMl(text)) {
        // LAD/FBD/GRAPH blocks, DBs and PLC data types exported as SimaticML: their interface is indexed
        const unit = parseSimaticMl(text);
        if (unit.blocks.length) doc.parsed = { blocks: unit.blocks, diagnostics: [], tokens: [] };
        if (unit.objects.length) doc.objects = unit.objects;
      }
    }
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
    // a METHOD or PROPERTY is known as FB.Name: a bare name means the object of that name, not a member
    const add = (s: GlobalSymbol, key = s.name) => {
      const k = key.toUpperCase();
      g.set(k, [...(g.get(k) ?? []), s]);
    };
    for (const d of this.docs.values()) {
      if (d.parsed && TAG_TEXT.test(d.uri)) for (const t of tagsOfText(d)) add(t);
      else if (d.parsed)
        for (const b of d.parsed.blocks) {
          add({ name: b.name, kind: b.kind, uri: d.uri, start: b.nameStart, end: b.nameEnd, block: b }, b.owner ? `${b.owner}.${b.name}` : b.name);
          if (b.kind === "GVL") for (const v of b.vars) add({ name: v.name, kind: "GVAR", uri: d.uri, start: v.start, end: v.end, gvar: { decl: v, list: b.name } });
        }
      else if (d.tagTable) for (const t of parseTags(d.text, d.uri)) add(t);
      else if (d.objects) {
        // (a PLC without technology objects has a view without any: it is not an object named after the PLC)
        for (const o of d.objects) add({ name: o.name, kind: "OBJECT", uri: d.uri, start: o.start, end: o.end, techObject: { ...(o.type ? { type: o.type } : {}), ...(o.number ? { number: o.number } : {}) } });
      } else {
        // LAD/FBD/GRAPH/protected objects: known by name only
        const leaf = decodeURIComponent(d.uri.split("/").pop()!).replace(/\.(s7dcl|xml|protected\.yaml)$/i, "");
        const name = leaf.includes("~") ? leaf.split("~").pop()! : leaf;
        add({ name: name.replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), kind: "OBJECT", uri: d.uri, start: 0, end: 0 });
      }
    }
    this.globals = g;
    const en = new Map<string, GlobalSymbol[]>();
    for (const list of g.values())
      for (const s of list) for (const e of s.block?.enumValues ?? []) en.set(e.name.toUpperCase(), [...(en.get(e.name.toUpperCase()) ?? []), s]);
    this.enumerators = en;
    this.dirty = false;
  }

  private enumerators = new Map<string, GlobalSymbol[]>();

  /** Enumeration types with a value of this name (IEC code may use the value without its type). */
  enumTypesWith(name: string): GlobalSymbol[] {
    this.rebuild();
    return this.enumerators.get(name.toUpperCase()) ?? [];
  }

  /**
   * The object of this name. Seen from a file of plc/<PLC>/ (`from`), the one of that PLC: another PLC's blocks,
   * DBs and tags are not visible from it, even when they have the same name.
   */
  global(name: string, from?: string): GlobalSymbol | undefined {
    this.rebuild();
    const all = this.globals.get(name.toUpperCase());
    const device = from ? deviceOfUri(from) : undefined;
    if (!all || !device) return all?.[0];
    return all.find((s) => deviceOfUri(s.uri) === device) ?? all.find((s) => !deviceOfUri(s.uri));
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
    if (g?.gvar) return this.membersOf({ ...g.gvar.decl, uri: g.uri });
    if (g?.block) {
      const b = g.block;
      if (b.kind === "DB" && b.dbOf) return this.membersOfType(b.dbOf, seen);
      const visible = b.kind === "FB" || b.kind === "PRG" ? b.vars.filter((v) => v.section !== "Temp" && v.section !== "Constant") : b.vars;
      // an IEC FB's properties (read and written like variables) and methods are members too
      const owned = (this.docs.get(g.uri)?.parsed?.blocks ?? []).filter((x) => x.owner?.toUpperCase() === b.name.toUpperCase());
      const extra: Member[] = owned.map((x) => ({
        name: x.name,
        type: x.property ? (x.returnType ?? "?") : `${x.action ? "action" : "method"} of ${b.name}`,
        ...(x.property && x.returnType ? { typeRef: x.returnType.replace(/^"|"$/g, "") } : {}),
        isArray: false,
        section: x.property ? "Property" : x.action ? "Action" : "Method",
        uri: g.uri,
        start: x.nameStart,
        end: x.nameEnd,
      }));
      return [...visible.map((v) => ({ ...v, uri: g.uri })), ...extra];
    }
    const std = STANDARD_BY_NAME.get(key);
    if (std?.kind === "functionBlock") {
      const params: Member[] = std.params.map((p) => ({ name: p.name, type: p.type, typeRef: p.type, isArray: false, section: p.dir === "in" ? "Input" : p.dir === "out" ? "Output" : "InOut" }));
      return [...params, ...(std.methods ?? []).map((m) => ({ name: m, type: `${m} instruction`, isArray: false, section: "Method" }))];
    }
    const sys = SYSTEM_TYPES.get(key);
    if (sys) return sys.map((m) => ({ name: m.name, type: m.type, typeRef: m.typeRef ?? m.type, isArray: !!m.isArray }));
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

/**
 * A rung workspace has `rung.toml` next to an exactly-named `plc/` folder, or `plc/<Device>/{blocks,types,tags}`.
 * Anything else (TwinCAT `PLC/` folders, CODESYS trees with a `plc` folder of .st files) is loaded in IEC mode.
 */
async function isRungLayout(root: string): Promise<boolean> {
  let top;
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }
  // exact case: on Windows readdir(join(root, "plc")) would also open a "PLC" folder
  if (!top.some((e) => e.isDirectory() && e.name === "plc")) return false;
  if (top.some((e) => e.isFile() && e.name === "rung.toml")) return true;
  let devices;
  try {
    devices = await readdir(join(root, "plc"), { withFileTypes: true });
  } catch {
    return false;
  }
  for (const d of devices) {
    if (!d.isDirectory()) continue;
    try {
      const inner = await readdir(join(root, "plc", d.name));
      if (inner.some((n) => n === "blocks" || n === "types" || n === "tags")) return true;
    } catch {
      /* unreadable device folder */
    }
  }
  return false;
}

/** The PLC of a rung workspace file (…/plc/<PLC>/…, views/techobjects/<PLC>.yaml), undefined elsewhere. */
export function deviceOfUri(uri: string): string | undefined {
  // the PLC's folder name as on disk (rung's workspace spelling of the PLC name), not its URI encoding
  // (plc/Line A/ is "Line A", not "Line%20A"): the same name workspace paths, test folders and reviews use
  const raw = /\/plc\/([^/]+)\//.exec(uri)?.[1] ?? /\/views\/techobjects\/([^/]+)\.yaml$/i.exec(uri)?.[1];
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The technology objects of a `rung views` YAML (views/techobjects/<PLC>.yaml): every `- type:
 * TechnologicalInstanceDB` entry with its name, InstanceOfName and Number, in groups too. Line-based: the file
 * is machine-written, one key per line.
 */
function techObjectsOfView(text: string): NamedObject[] {
  const out: NamedObject[] = [];
  const scalar = (raw: string) => {
    if (!raw.startsWith('"')) return raw;
    try {
      return String(JSON.parse(raw));
    } catch {
      return raw;
    }
  };
  let current: NamedObject | undefined;
  let depth = -1; // indent of the current entry's "- "
  let offset = 0;
  for (const full of text.split("\n")) {
    const line = full.replace(/\r$/, "");
    const at = offset;
    offset += full.length + 1;
    const indent = line.length - line.trimStart().length;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const entry = /^\s*- type: (.*)$/.exec(line);
    if (entry || indent <= depth) {
      if (current) out.push(current);
      current = undefined;
      depth = -1;
    }
    if (entry) {
      const type = scalar(entry[1]!.trim());
      if (/^Technological\w*$/.test(type) && !/Group$/.test(type)) {
        current = { name: "", start: 0, end: 0 };
        depth = indent;
      }
      continue;
    }
    if (!current) continue;
    const kv = /^(\s*)([A-Za-z]+): (.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[3]!.trim();
    if (kv[2] === "name" && indent === depth + 2) {
      current.name = scalar(value);
      current.start = at + line.indexOf(value, kv[1]!.length + "name: ".length) + (value.startsWith('"') ? 1 : 0);
      current.end = current.start + (value.startsWith('"') ? value.length - 2 : value.length);
    } else if (kv[2] === "InstanceOfName") current.type = scalar(value);
    else if (kv[2] === "Number") current.number = scalar(value);
  }
  if (current) out.push(current);
  return out.filter((o) => o.name);
}


/**
 * The index as seen from one file: every lookup by name finds that file's PLC's object (WorkspaceIndex.global
 * with `from`), and the list of all objects holds that PLC's only. Entry points of the language server and the
 * simulator wrap the index once with it.
 */
export function scopedTo(index: WorkspaceIndex, from: string): WorkspaceIndex {
  index = unscoped(index); // seen from another file, the view of that file's PLC, not of both
  const device = deviceOfUri(from);
  if (!device) return index;
  return new Proxy(index, {
    get(target, prop, receiver) {
      if (prop === UNSCOPED) return target;
      if (prop === "global") return (name: string, other?: string) => target.global(name, other ?? from);
      // the PLC's own objects, and those outside every PLC folder that no object of the PLC hides
      if (prop === "allGlobals") return () => target.allGlobals().filter((s) => deviceOfUri(s.uri) === device || (!deviceOfUri(s.uri) && target.global(s.name, from) === s));
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(receiver) : v;
    },
  });
}

const UNSCOPED = Symbol("unscoped");

/** The whole index behind a scopedTo view. */
export function unscoped(index: WorkspaceIndex): WorkspaceIndex {
  return (index as unknown as { [UNSCOPED]?: WorkspaceIndex })[UNSCOPED] ?? index;
}

/** A TIA tag table as text (rung `*.tags.st`): an IEC global variable list whose entries are PLC tags. */
export const TAG_TEXT = /\.tags\.st$/i;

/** The table named by the file (`Fx_Inputs.tags.st` → Fx_Inputs). */
export function tagTableName(uri: string): string {
  return decodeURIComponent(uri.split("/").pop()!).replace(TAG_TEXT, "").replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** The tag table as text a new PLC tag of the file's PLC goes in: the default tag table, else the first. */
export function tagTableFor(index: WorkspaceIndex, uri: string): { uri: string; name: string } | undefined {
  const device = /^(.*\/plc\/[^/]+\/)/.exec(uri)?.[1];
  if (!device) return undefined;
  const tables = [...index.docs.keys()].filter((u) => u.startsWith(device + "tags/") && TAG_TEXT.test(u)).sort();
  const pick = tables.find((u) => tagTableName(u).toLowerCase() === "default tag table") ?? tables[0];
  return pick ? { uri: pick, name: tagTableName(pick) } : undefined;
}

/** PLC tags and user constants of a `.tags.st` file, as parseTags gives them for SimaticML. */
export function tagsOfText(d: Doc): GlobalSymbol[] {
  const table = tagTableName(d.uri);
  return (d.parsed?.blocks ?? []).flatMap((b) =>
    b.vars.map((v) => ({
      name: v.name,
      kind: "TAG" as const,
      uri: d.uri,
      start: v.start,
      end: v.end,
      tag: { dataType: v.type, table, ...(v.at ? { address: v.at } : {}), ...(v.section === "Constant" && v.init !== undefined ? { value: v.init } : {}) },
    })),
  );
}

/** Extracts tags from a SimaticML tag-table export (regex-based; the files are machine-generated). */
export function parseTags(xml: string, uri: string): GlobalSymbol[] {
  const out: GlobalSymbol[] = [];
  const table = /<SW\.Tags\.PlcTagTable[\s\S]*?<Name>([^<]*)<\/Name>/.exec(xml)?.[1] ?? "";
  const re = /<SW\.Tags\.(PlcTag|PlcUserConstant)\b[\s\S]*?<\/SW\.Tags\.\1>/g;
  for (const m of xml.matchAll(re)) {
    const body = m[0];
    const value = m[1] === "PlcUserConstant" ? /<Value>([^<]*)<\/Value>/.exec(body)?.[1] : undefined;
    const name = /<Name>([^<]*)<\/Name>/.exec(body);
    if (!name) continue;
    const nameAt = m.index! + body.indexOf(name[0]) + "<Name>".length;
    const dataType = /<DataTypeName>([^<]*)<\/DataTypeName>/.exec(body)?.[1] ?? "?";
    const address = /<LogicalAddress>([^<]*)<\/LogicalAddress>/.exec(body)?.[1];
    const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    out.push({ name: decode(name[1]!), kind: "TAG", uri, start: nameAt, end: nameAt + name[1]!.length, tag: { dataType: decode(dataType), ...(address ? { address } : {}), table, ...(value !== undefined ? { value: decode(value) } : {}) } });
  }
  return out;
}
