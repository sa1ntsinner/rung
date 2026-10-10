// SPDX-License-Identifier: BUSL-1.1
// rung xref <file or address>: TIA Portal's own cross-reference of an object: who uses it and what it uses, also
// what rung's files cannot show (HMI screens and alarms, technology objects, hardware). Read only: through the
// running rung watch when there is one, else a bridge of its own; an answer is kept while nothing mirrored changed.
import { relative } from "node:path";
import { loadConfig, WorkspaceError } from "@rung/core";
import type { XRefEntry } from "@rung/bridge-client";
import { OwnerClient, cachedXref } from "@rung/sync";
import { bridgeFor, findWorkspace, type Io } from "./common.js";
import { addressOf } from "./twoway.js";

/** TIA Portal's relation of a reference, said from the object asked about. */
export type Relation = "used by" | "uses" | "overlaps" | "related";
const RELATION: Record<string, Relation> = {
  UsedBy: "used by",
  TypeInstance: "used by", // it is the type of the other object
  Defines: "used by",
  GroupMember: "used by",
  Uses: "uses",
  InstanceType: "uses", // it is an instance of the other object
  DefinedBy: "uses",
  MemberGroup: "uses",
  Assigns: "uses",
  OverlapsWith: "overlaps", // shares (part of) an address range
};

export interface XRefRow {
  relation: Relation;
  /** the object that uses (or is used): its workspace file when rung mirrors it */
  name: string;
  type: string;
  path?: string;
  access: string;
  /** where in it: a network, a line, a screen element, as TIA Portal says */
  location?: string;
}

/** TIA Portal's cross-reference of one object, through the watch or a bridge of its own. */
export async function xrefOf(ws: string, address: string, io: Io): Promise<XRefEntry[]> {
  const owner = await OwnerClient.connect(ws);
  if (owner) {
    try {
      return await owner.request<XRefEntry[]>("xref", { address });
    } finally {
      owner.close();
    }
  }
  const b = await bridgeFor(await loadConfig(ws), io);
  try {
    return await b.xref(address);
  } finally {
    await b.close();
  }
}

export async function cmdXref(target: string | undefined, json: boolean, io: Io, fresh = false): Promise<number> {
  if (!target) {
    io.stderr("rung: usage: rung xref <mirrored file or plc:object-address> [--json] [--fresh]\n");
    return 1;
  }
  if (/^%[IQM](?:[XBWD])?\d+(?:\.\d+)?$/i.test(target)) throw new WorkspaceError("BAD_ARGUMENT", `${target} is a physical PLC address; rung xref needs a mirrored file or plc: object address. Find its tag name in the tag table, then use rung who <tag name> for readers/writers or rung xref <tag table file> for TIA references.`);
  const ws = await findWorkspace(io.cwd);
  const address = await addressOf(ws, target, io.cwd);
  const { entries, at } = await cachedXref(ws, address, () => xrefOf(ws, address, io), { fresh });
  const kept = at ? `TIA Portal's answer of ${new Date(at).toLocaleString(undefined, { hour12: false })}: nothing mirrored changed since (HMI screens are not mirrored; --fresh asks again)` : undefined;
  const state = await loadPaths(ws);
  const rows = entries.map((e) => {
    const where = e.target ? state.get(e.target) : undefined;
    return { relation: RELATION[e.referenceType] ?? "related", name: e.targetName, type: e.targetType, ...(where ? { path: where } : {}), access: e.access, ...(e.location ? { location: e.location } : {}), source: e.sourceName } as XRefRow & { source: string };
  });
  if (json) {
    io.stdout(JSON.stringify({ address, rows, ...(at ? { cachedAt: new Date(at).toISOString() } : {}) }, null, 2) + "\n");
    return 0;
  }
  if (!rows.length) {
    io.stdout(`TIA Portal knows no cross references of ${address}\n${kept ? `(${kept})\n` : ""}`);
    return 0;
  }
  io.stdout(`${address} in TIA Portal's cross-reference:\n`);
  const width = Math.min(40, Math.max(...rows.map((r) => r.name.length)));
  for (const rel of ["used by", "uses", "overlaps", "related"] as const) {
    const group = rows.filter((r) => r.relation === rel);
    if (!group.length) continue;
    io.stdout(`${rel}:\n`);
    for (const r of group) io.stdout(`  ${r.name.padEnd(width)}  ${r.access.padEnd(11)} ${r.type}${r.location ? `  ${r.location}` : ""}${r.path ? `  (${relative(io.cwd, `${ws}/${r.path}`) || r.path})` : ""}\n`);
  }
  if (kept) io.stdout(`(${kept})\n`);
  return 0;
}

async function loadPaths(ws: string): Promise<Map<string, string>> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    const s = JSON.parse(await readFile(join(ws, ".rung", "state.json"), "utf8")) as { objects?: Record<string, { address: string; path: string }> };
    return new Map(Object.values(s.objects ?? {}).map((o) => [o.address, o.path]));
  } catch {
    return new Map();
  }
}
