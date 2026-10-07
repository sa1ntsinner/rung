// SPDX-License-Identifier: BUSL-1.1
// Call hierarchy: which blocks call this one (through an instance DB, a multi-instance or by name) and which it
// calls, as the editor's native view (VS Code "Show Call Hierarchy", Neovim vim.lsp.buf.incoming_calls()).
import { callsOf } from "./features.js";
import type { BlockModel, Ref } from "./parser.js";
import { scopedTo, type WorkspaceIndex } from "./workspace.js";

export interface HierarchyItem {
  name: string;
  kind: BlockModel["kind"];
  uri: string;
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
}

function item(b: BlockModel, uri: string): HierarchyItem {
  return { name: b.name, kind: b.kind, uri, start: b.start, end: b.end, nameStart: b.nameStart, nameEnd: b.nameEnd };
}

/** The block a call reference runs: an FC or FB by name, an instance DB's FB, a multi-instance's FB. */
function callee(index: WorkspaceIndex, uri: string, from: BlockModel, r: Ref): { block: BlockModel; uri: string } | undefined {
  const seen = scopedTo(index, uri);
  let name: string | undefined = r.name;
  if (r.kind === "local") {
    const owner = from.owner ? seen.global(from.owner)?.block : undefined;
    name = [...from.vars, ...(owner?.vars ?? [])].find((v) => v.name.toUpperCase() === r.name.toUpperCase())?.typeRef;
  }
  if (!name) return undefined;
  let g = seen.global(name);
  if (g?.kind === "DB" && g.block?.dbOf) g = seen.global(g.block.dbOf);
  return g?.block && (g.kind === "FB" || g.kind === "FC") ? { block: g.block, uri: g.uri } : undefined;
}

/** The block named at the cursor (its header, or a call of it), for the view's root. */
export function prepareCallHierarchy(index: WorkspaceIndex, uri: string, offset: number): HierarchyItem | undefined {
  const here = index.blockAt(uri, offset);
  if (!here) return undefined;
  if (offset >= here.nameStart && offset <= here.nameEnd) return item(here, uri);
  const r = here.refs.find((x) => x.access === "call" && offset >= x.start && offset <= x.end);
  const c = r && callee(index, uri, here, r);
  return c ? item(c.block, c.uri) : item(here, uri);
}

function blockOf(index: WorkspaceIndex, it: HierarchyItem): BlockModel | undefined {
  return index.docs.get(it.uri)?.parsed?.blocks.find((b) => b.name === it.name && b.start === it.start) ?? scopedTo(index, it.uri).global(it.name)?.block;
}

/** Who calls it, by caller, with each call's place. */
export function incomingCalls(index: WorkspaceIndex, it: HierarchyItem): { from: HierarchyItem; ranges: { start: number; end: number }[] }[] {
  const b = blockOf(index, it);
  if (!b) return [];
  const byCaller = new Map<string, { from: HierarchyItem; ranges: { start: number; end: number }[] }>();
  for (const c of callsOf(index, b, it.uri)) {
    const caller = index.docs.get(c.uri)?.parsed?.blocks.find((x) => x.name === c.block);
    if (!caller) continue;
    const key = `${c.uri}#${caller.start}`;
    const ref = caller.refs.find((r) => r.start === c.start);
    let e = byCaller.get(key);
    if (!e) byCaller.set(key, (e = { from: item(caller, c.uri), ranges: [] }));
    e.ranges.push({ start: c.start, end: ref?.end ?? c.start });
  }
  return [...byCaller.values()];
}

/** What it calls, by callee, with each call's place. */
export function outgoingCalls(index: WorkspaceIndex, it: HierarchyItem): { to: HierarchyItem; ranges: { start: number; end: number }[] }[] {
  const b = blockOf(index, it);
  if (!b) return [];
  const byCallee = new Map<string, { to: HierarchyItem; ranges: { start: number; end: number }[] }>();
  for (const r of b.refs) {
    if (r.access !== "call" || r.members.length) continue;
    const c = callee(index, it.uri, b, r);
    if (!c) continue;
    const key = `${c.uri}#${c.block.start}`;
    let e = byCallee.get(key);
    if (!e) byCallee.set(key, (e = { to: item(c.block, c.uri), ranges: [] }));
    e.ranges.push({ start: r.start, end: r.end });
  }
  return [...byCallee.values()];
}
