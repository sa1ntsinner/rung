// SPDX-License-Identifier: BUSL-1.1
// rung rename: TIA Portal renames the object and keeps every use symbolic; the users' fingerprints stay the same,
// so the files that name the old object are marked stale and a pull brings them (and the renamed file) back.
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceError, parseAddress, type RungConfig, type StateStore } from "@rung/core";
import type { BridgeClient } from "@rung/bridge-client";
import { localStatus, type BridgeLike } from "./objects.js";
import { pull, type PullReport } from "./pull.js";
import { recordTombstone, tombstoneOf } from "./tombstones.js";

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

/** Quoted uses of a name in SCL/SD (`"Name"`, `"Name".x`) and in SimaticML (`Name="Name"`). */
export function mentions(text: string, name: string): boolean {
  return text.includes(`"${name}"`) || text.includes(`Name="${name.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
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
  users.push(...(await renameInTests(root, oldName, newName, parseAddress(address).device)));
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

/** Unit tests name blocks too (`block: Fx_Counter`, `"Fx_Counter".member`); they follow the rename. */
/** The tests that name the old block, unless they name another PLC (`plc: PLC_2`: another block of that name). */
async function renameInTests(root: string, oldName: string, newName: string, device: string): Promise<string[]> {
  const changed: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) await walk(rel);
      else if (/\.test\.ya?ml$/i.test(e.name)) {
        const text = await readFile(join(root, rel), "utf8");
        const plc = /^plc:\s*["']?([^"'#\n]*?)["']?\s*(#.*)?$/im.exec(text)?.[1]?.trim();
        if (plc && plc.toUpperCase() !== device.toUpperCase()) continue;
        const own = new RegExp(`^\\s*block:\\s*"?${escapeRe(oldName)}"?\\s*(?:#.*)?$`, "m").test(text);
        let next = text
          .replace(new RegExp(`^(\\s*block:\\s*)"?${escapeRe(oldName)}"?(\\s*(?:#.*)?)$`, "gm"), `$1${newName}$2`)
          .split(`"${oldName}"`)
          .join(`"${newName}"`);
        // an FC's return value is named after the FC: expect: { FC_Scale: 750.0 } in its own tests
        if (own) next = next.replace(new RegExp(`(?<=[{,]\\s*)${escapeRe(oldName)}(?=\\s*:)`, "g"), newName);
        if (next !== text) {
          await writeFile(join(root, rel), next);
          changed.push(rel);
        }
      }
    }
  };
  await walk("tests");
  return changed;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
