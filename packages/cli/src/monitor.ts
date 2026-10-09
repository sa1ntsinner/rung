// SPDX-License-Identifier: BUSL-1.1
// rung live watch: TIA Portal's "monitoring on" for one block. rung works out which variables the block shows
// on which line, and through which instance DB an FB is watched; then it reads them from the PLC's Web API
// (read-only) every interval and prints one JSON line per read, for editors.
import { deviceOfUri, scopedTo, type BlockModel, type Member, type VarDecl, type WorkspaceIndex } from "@rung/lsp";
import { WorkspaceError } from "@rung/core";

export interface MonitorPlan {
  block: string;
  kind: string;
  /** The instance an FB is read through: "Fx_Motor_DB" or "Line_DB".Motor1. */
  instance?: string;
  /** Web API name of each label: "#Running" → "\"Fx_Motor_DB\".Running". */
  vars: Record<string, string>;
  /** 0-based line → the labels shown at its end, in order. */
  lines: Record<number, string[]>;
}

/** Types whose values fit at the end of a line (structures, arrays and instances do not). */
const ELEMENTARY =
  /^(BOOL|BYTE|WORD|DWORD|LWORD|SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|REAL|LREAL|TIME|LTIME|S5TIME|DATE|TIME_OF_DAY|TOD|LTIME_OF_DAY|LTOD|DATE_AND_TIME|DT|LDT|CHAR|WCHAR|STRING|WSTRING)(\s*\[.*\])?$/i;
const elementary = (m: Pick<Member, "type" | "isArray"> | undefined) => !!m && !m.isArray && ELEMENTARY.test(m.type.trim());
/** How many elements of a declared array monitoring reads: the first ones, a page. */
const ARRAY_PAGE = 16;

/** A member name as the Web API wants it: plain, or in quotes when it has other characters. */
const seg = (n: string) => (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(n) ? n : `"${n}"`);
const quoted = (n: string) => (n.startsWith('"') ? n : `"${n}"`);

/** Both files of one PLC (or not in a rung layout, where there is one program). */
const samePlc = (a: string, b: string) => deviceOfUri(a) === deviceOfUri(b);

export function monitorPlan(index: WorkspaceIndex, uri: string, instance?: string): MonitorPlan {
  index = scopedTo(index, uri); // the block's own PLC: another may have DBs and tags of the same names
  const doc = index.docs.get(uri);
  const block: BlockModel | undefined = doc?.parsed?.blocks[0];
  if (!doc || !block) throw new WorkspaceError("BAD_ARGUMENT", "this file holds no block rung can monitor");
  const vars: Record<string, string> = {};
  const lines: Record<number, string[]> = {};
  const add = (offset: number, label: string, name: string) => {
    vars[label] = name;
    const line = doc.lines.position(offset).line;
    const list = (lines[line] ??= []);
    if (!list.includes(label)) list.push(label);
  };

  let inst: string | undefined;
  if (block.kind === "FB") {
    const dbs = monitorInstances(index, uri);
    inst = instance ? (/^"/.test(instance.trim()) ? instance.trim() : quoted(instance.trim())) : dbs.length === 1 ? quoted(dbs[0]!) : undefined;
    if (!inst)
      throw new WorkspaceError(
        "NO_INSTANCE",
        dbs.length
          ? `${block.name} has ${dbs.length} instance DBs (${dbs.join(", ")}); choose one with --instance`
          : `${block.name} has no instance DB of its own; name the instance with --instance, e.g. "Line_DB".Motor1`,
      );
  } else if (block.kind !== "DB" && block.kind !== "FC" && block.kind !== "OB")
    throw new WorkspaceError("BAD_ARGUMENT", `a ${block.kind} holds no values to monitor`);

  const readable = (v: VarDecl | undefined) => !!v && v.section !== "Temp" && v.section !== "Constant";
  // declarations: an FB's inputs, outputs and statics through the instance, a DB's members
  if (block.kind === "FB" || (block.kind === "DB" && !block.dbOf)) {
    const base = block.kind === "FB" ? inst! : quoted(block.name);
    // members of a STRUCT declared here too, each on its own line, labelled with its path (Motor.Speed)
    const walk = (vars: VarDecl[], label: string, path: string) => {
      for (const v of vars) {
        if (!readable(v)) continue;
        const l = label ? `${label}.${v.name}` : v.name;
        if (v.members?.length && !v.isArray) walk(v.members, l, `${path}.${seg(v.name)}`);
        else if (elementary(v)) add(v.start, l, `${path}.${seg(v.name)}`);
        else if (v.isArray) {
          // an array of an elementary type: its first elements (a page), each read like a member
          const a = /^Array\s*\[\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*\]\s*of\s+(.+)$/i.exec(v.type.trim());
          if (!a || !ELEMENTARY.test(a[3]!.trim())) continue;
          const lo = Number(a[1]);
          for (let i = lo; i <= Math.min(Number(a[2]), lo + ARRAY_PAGE - 1); i++) add(v.start, `${l}[${i}]`, `${path}.${seg(v.name)}[${i}]`);
        }
      }
    };
    walk(block.vars, "", base);
  } else if (block.kind === "DB" && block.dbOf) {
    // an instance or typed DB declares nothing itself: its values go on the line that names the FB or UDT
    const at = Math.max(block.start, doc.text.indexOf(`"${block.dbOf}"`, block.start));
    for (const m of index.membersOfType(block.dbOf)) if (m.section !== "Temp" && m.section !== "Constant" && elementary(m)) add(at, m.name, `${quoted(block.name)}.${seg(m.name)}`);
  }
  // uses in the code
  for (const ref of block.refs) {
    const path = [ref.name, ...ref.members.map((m) => m.name)];
    if (ref.kind === "local") {
      if (block.kind !== "FB") continue; // an FC's or OB's locals are temporary: nothing to read
      const d = block.vars.find((v) => v.name.toUpperCase() === ref.name.toUpperCase());
      if (!readable(d)) continue;
      const leaf = ref.members.length ? index.resolveChain(index.membersOf(d!), ref.members).at(-1) : d;
      if (elementary(leaf)) add(ref.start, `#${path.join(".")}`, `${inst}.${path.map(seg).join(".")}`);
    } else if (ref.kind === "global") {
      const g = index.global(ref.name);
      if (g?.tag && !ref.members.length) add(ref.start, `"${ref.name}"`, `"${ref.name}"`);
      else if (g?.block?.kind === "DB" && ref.members.length) {
        const root = g.block.dbOf ? index.membersOfType(g.block.dbOf) : g.block.vars;
        const leaf = index.resolveChain(root.map((m) => ({ ...m, uri: g.uri })), ref.members).at(-1);
        if (elementary(leaf)) add(ref.start, `"${ref.name}".${ref.members.map((m) => m.name).join(".")}`, `"${ref.name}".${ref.members.map((m) => seg(m.name)).join(".")}`);
      }
    }
  }
  return { block: block.name, kind: block.kind, ...(inst ? { instance: inst } : {}), vars, lines };
}

/**
 * The same for IEC structured text (CODESYS): values by their instance path. A PROGRAM or a GVL is its own
 * instance (PLC_PRG.nCycles, GVL_Plant.nSpeed); an FB is read through the PROGRAM variable that holds it
 * (PLC_PRG.fbCount.nCount), found by itself when there is one; its METHODs show the FB's variables.
 */
export function monitorPlanIec(index: WorkspaceIndex, uri: string, instance?: string): MonitorPlan {
  index = scopedTo(index, uri);
  const doc = index.docs.get(uri);
  const block: BlockModel | undefined = doc?.parsed?.blocks[0];
  if (!doc || !block) throw new WorkspaceError("BAD_ARGUMENT", "this file holds no POU rung can monitor");
  const vars: Record<string, string> = {};
  const lines: Record<number, string[]> = {};
  const add = (offset: number, label: string, name: string) => {
    vars[label] = name;
    const list = (lines[doc.lines.position(offset).line] ??= []);
    if (!list.includes(label)) list.push(label);
  };
  let base: string | undefined;
  if (block.kind === "PRG" || block.kind === "GVL") base = block.name;
  else if (block.kind === "FB") {
    const uses = monitorInstances(index, uri);
    base = instance?.trim() || (uses.length === 1 ? uses[0] : undefined);
    if (!base)
      throw new WorkspaceError(
        "NO_INSTANCE",
        uses.length ? `${block.name} has ${uses.length} instances (${uses.join(", ")}); choose one with --instance` : `${block.name} has no instance in a PROGRAM; name it with --instance, e.g. PLC_PRG.fbCount`,
      );
  } else if (block.kind !== "FC") throw new WorkspaceError("BAD_ARGUMENT", `a ${block.kind} holds no values to monitor`);
  const readable = (v: VarDecl | undefined) => !!v && v.section !== "Temp" && v.section !== "Constant";
  if (base) for (const v of block.vars) if (readable(v) && elementary(v)) add(v.start, v.name, `${base}.${v.name}`);
  for (const b of doc.parsed!.blocks) {
    for (const ref of b.refs) {
      const path = [ref.name, ...ref.members.map((m) => m.name)];
      if (ref.kind === "local") {
        // the POU's own variables (a METHOD's own are temporary, like a FUNCTION's)
        if (!base || block.kind === "GVL") continue;
        const d = block.vars.find((v) => v.name.toUpperCase() === ref.name.toUpperCase());
        if (!readable(d) || (b !== block && b.vars.some((v) => v.name.toUpperCase() === ref.name.toUpperCase()))) continue;
        const leaf = ref.members.length ? index.resolveChain(index.membersOf(d!), ref.members).at(-1) : d;
        if (elementary(leaf)) add(ref.start, path.join("."), `${base}.${path.join(".")}`);
      } else if (ref.kind === "global") {
        const g = index.global(ref.name);
        if (g?.gvar && !ref.members.length && elementary(g.gvar.decl)) add(ref.start, ref.name, `${g.gvar.list}.${ref.name}`);
        else if ((g?.block?.kind === "GVL" || g?.block?.kind === "PRG") && ref.members.length) {
          const leaf = index.resolveChain(g.block.vars.map((m) => ({ ...m, uri: g.uri })), ref.members).at(-1);
          if (elementary(leaf)) add(ref.start, path.join("."), path.join("."));
        }
      }
    }
  }
  return { block: block.name, kind: block.kind, ...(block.kind === "FB" ? { instance: base! } : {}), vars, lines };
}

export function monitorInstances(index: WorkspaceIndex, uri: string): string[] {
  index = scopedTo(index, uri);
  const block = index.docs.get(uri)?.parsed?.blocks[0];
  if (block?.kind !== "FB") return [];
  const globals = index.allGlobals().filter((g) => samePlc(g.uri, uri));
  if (isIecMonitor(uri))
    return globals.filter((g) => g.block?.kind === "PRG").flatMap((g) =>
      g.block!.vars.filter((v) => !v.isArray && (v.typeRef ?? v.type).toUpperCase() === block.name.toUpperCase()).map((v) => g.name + "." + v.name),
    );
  return globals.filter((g) => g.block?.kind === "DB" && g.block.dbOf?.toUpperCase() === block.name.toUpperCase()).map((g) => g.name);
}

export const isIecMonitor = (uri: string) => /\.(st|TcPOU|TcGVL|TcDUT)$/i.test(uri);
