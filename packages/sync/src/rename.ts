// SPDX-License-Identifier: BUSL-1.1
// rung rename: TIA Portal renames the object and keeps every use symbolic; the users' fingerprints stay the same,
// so the files that name the old object are marked stale and a pull brings them (and the renamed file) back.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceError, parseAddress, type RungConfig, type StateStore } from "@rung/core";
import type { BridgeClient } from "@rung/bridge-client";
import { localStatus, mentions, renameInTests, type BridgeLike } from "./objects.js";
import { pull, type PullReport } from "./pull.js";
import { recordTombstone, tombstoneOf } from "./tombstones.js";

export { mentions } from "./objects.js";

export type RenameBridge = BridgeLike & Pick<BridgeClient, "renameObject">;

export interface RenameReport {
  from: string;
  to: string;
  /** workspace files of the renamed object, before and after */
  oldPath: string;
  newPath?: string;
  /** workspace files that named the old object and were brought back from TIA */
  users: string[];
  pull: PullReport;
}

export async function renameObject(root: string, bridge: RenameBridge, state: StateStore, config: RungConfig, address: string, newName: string): Promise<RenameReport> {
  const st = state.get(address);
  if (!st) throw new WorkspaceError("NOT_MIRRORED", `${address} is not in this workspace; run rung pull`);
  if (st.readOnly) throw new WorkspaceError("READ_ONLY", `${st.path} is read-only in TIA Portal`);
  if (st.status !== "synced" || (await localStatus(root, st.files)) !== "clean")
    throw new WorkspaceError("LOCAL_CHANGES", `${st.path} has changes that are not in TIA Portal yet; sync them first (rung sync)`);
  const oldName = parseAddress(address).name;
  if (newName === oldName) throw new WorkspaceError("BAD_ARGUMENT", `${oldName} already has that name`);

  const inconsistent = new Set((await bridge.listObjects(parseAddress(address).device)).filter((o) => o.isConsistent === false).map((o) => o.address));
  const { address: to } = await bridge.renameObject(address, newName, st.tiaFingerprint, randomUUID());
  const tomb = tombstoneOf(st, { to });
  if (tomb) await recordTombstone(root, tomb).catch(() => undefined);

  // every other file that names the old object is re-exported, even though TIA reports it unchanged
  const users: string[] = [];
  for (const s of state.all()) {
    if (s.address === address) continue;
    const texts = await Promise.all(s.files.map((f) => readFile(join(root, f.path), "utf8").catch(() => "")));
    if (!texts.some((t) => mentions(t, oldName))) continue;
    users.push(s.path);
    state.upsert({ ...s, tiaFingerprint: `stale:${s.tiaFingerprint}` });
  }
  await state.flush();
  const report = await pull(root, bridge, state, { config });
  for (const w of report.warnings) if (w.code === "INCONSISTENT" && inconsistent.has(w.address)) w.message = `already inconsistent before rename; ${w.message ?? "run rung compile"}`;
  // the pass follows the rename by TIA Portal's identity (V20 and later) and renames the tests itself; the person
  // renamed it here, so that is no news to them
  report.warnings = report.warnings.filter((w) => w.code !== "RENAMED_IN_TIA");
  users.push(...(report.renamed ?? []).flatMap((r) => r.tests), ...(await renameInTests(root, oldName, newName, parseAddress(address).device)));
  // what the last pass said about either name (a hand rename held back, a missing block) is answered now
  const gone = new Set([address, to, st.path, state.get(to)?.path].filter((x): x is string => !!x));
  const file = join(root, ".rung", "diagnostics.json");
  try {
    const doc = JSON.parse(await readFile(file, "utf8")) as { seq?: number; items?: { address?: string; path?: string; code?: string }[] };
    const items = (doc.items ?? []).filter((d) => d.code === "COMPILE" || !(gone.has(d.address ?? "") || gone.has(d.path ?? "")));
    if (items.length !== (doc.items ?? []).length) await writeFile(file, JSON.stringify({ ...doc, items }, null, 2) + "\n");
  } catch {
    /* no diagnostics yet */
  }
  return { from: address, to, oldPath: st.path, ...(state.get(to) ? { newPath: state.get(to)!.path } : {}), users, pull: report };
}
