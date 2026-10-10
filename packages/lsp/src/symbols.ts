// SPDX-License-Identifier: BUSL-1.1
// Workspace symbols: any block, PLC data type, DB, tag or global variable of the workspace, found by name.
import { deviceOfUri, type GlobalSymbol, type WorkspaceIndex } from "./workspace.js";

export interface FoundSymbol {
  name: string;
  kind: GlobalSymbol["kind"];
  /** Constant for a tag table's user constant. */
  constant?: boolean;
  /** The PLC and the folder, or the PLC and the tag table. */
  container: string;
  uri: string;
  start: number;
  end: number;
}

/** Enough for a pick list; the editor asks again as the query grows. */
const LIMIT = 500;

/**
 * Names that contain the query (case-insensitive): the name itself first, then names with a word starting with it
 * (TIA names carry prefixes: "motor" finds Fx_Motor and MotorOn before Fx_Pumpmotor), then the rest.
 */
export function workspaceSymbols(index: WorkspaceIndex, query: string): FoundSymbol[] {
  const q = query.trim().toUpperCase();
  const hits: { s: GlobalSymbol; rank: number }[] = [];
  for (const s of index.allGlobals()) {
    const name = s.name.toUpperCase();
    const at = name.indexOf(q);
    if (at < 0) continue;
    hits.push({ s, rank: name.length === q.length ? 0 : wordAt(s.name, at) || wordAt(s.name, name.indexOf(q, at + 1)) ? 1 : 2 });
  }
  hits.sort((a, b) => a.rank - b.rank || a.s.name.localeCompare(b.s.name) || a.s.uri.localeCompare(b.s.uri));
  return hits.slice(0, LIMIT).map(({ s }) => ({
    name: s.name,
    kind: s.kind,
    ...(s.tag?.value !== undefined ? { constant: true } : {}),
    container: containerOf(s),
    uri: s.uri,
    start: s.start,
    end: s.end,
  }));
}

/**
 * The members one level below a path that starts at a DB or a tag: ["Line_DB"] lists its variables (an instance DB
 * its FB's interface), ["Line_DB", "Pos"] those of Pos. `more`: the member has members of its own.
 */
export function pathMembers(index: WorkspaceIndex, path: string[]): { name: string; type: string; more: boolean }[] {
  const root = index.global(path[0] ?? "");
  let list = root?.tag ? index.membersOfType(root.tag.dataType.replace(/^"|"$/g, "")) : index.membersOfType(root?.name);
  for (const seg of path.slice(1)) {
    const m = list.find((x) => x.name.toUpperCase() === seg.toUpperCase());
    if (!m) return [];
    list = index.membersOf(m);
  }
  return list
    .filter((m) => m.section !== "Method" && m.section !== "Action")
    .map((m) => ({ name: m.name, type: m.type, more: !m.isArray && index.membersOf(m).length > 0 }));
}

/** A word starts at `at`: the name's start, after _ or another separator, or at a capital after a small letter or digit. */
function wordAt(name: string, at: number): boolean {
  if (at < 0) return false;
  if (at === 0) return true;
  const before = name[at - 1]!;
  return /[^\p{L}\p{N}]/u.test(before) || (/[\p{Ll}\p{N}]/u.test(before) && /\p{Lu}/u.test(name[at]!));
}

function containerOf(s: GlobalSymbol): string {
  const plc = deviceOfUri(s.uri);
  if (s.tag) return [plc, s.tag.table].filter(Boolean).join(" / ");
  const folder = /\/plc\/[^/]+\/(?:blocks|types)\/(.+)\/[^/]+$/.exec(s.uri)?.[1];
  return [plc, folder && decodeURIComponent(folder)].filter(Boolean).join(" / ");
}
