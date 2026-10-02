// SPDX-License-Identifier: BUSL-1.1
// rung pull: one-way, incremental TIA → workspace mirror that never destroys local work.
import { randomUUID } from "node:crypto";
import { Journal, WorkspaceError, parseAddress, pathKey, publishBundle, type ObjectState, type RungConfig, type StateStore } from "@rung/core";
import { BridgeError } from "@rung/bridge-client";
import { takeInventory, type Warning } from "./inventory.js";
import { buildState, diskHash, isLockError, isReadOnlyEntry, isStrong, localStatus, planPublication, stageExport, type BridgeLike } from "./objects.js";

export { STAGED_STEM, isReadOnlyEntry, type BridgeLike } from "./objects.js";

export type PullWarning = Warning;

export interface PullReport {
  exported: number;
  unchanged: number;
  readOnly: number;
  removed: number;
  warnings: PullWarning[];
  collisions: [string, string][];
  tooLong: string[];
  /** Local edits --force replaced, each with the folder that keeps the person's version. */
  overwritten: { path: string; copy: string }[];
}

export interface PullOptions {
  config: RungConfig;
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
  now?: () => number;
}

const INCONSISTENT_HINT = "not compiled in TIA Portal since its last change (rung compile)";
const EXPORT_HINTS: Readonly<Record<string, string>> = {
  INCONSISTENT: INCONSISTENT_HINT,
  SD_FALLBACK: "kept as SimaticML XML: SD text would lose something it holds (OB type, network titles or comments)",
  TAGS_XML_FALLBACK: "kept as SimaticML XML (.tags.xml): the one-line-per-tag form would lose something it holds (comments in several languages, other settings)",
};

/** Bridge failures after which every remaining call would fail or wait for its own timeout. */
export const FATAL_BRIDGE_CODES = new Set(["TIA_NOT_RUNNING", "PORTAL_DISPOSED", "BRIDGE_EXITED", "ACCESS_DENIED", "TIMEOUT", "OUTCOME_UNKNOWN", "DIALOG_REQUIRED"]);

/**
 * A weak revision is fresh only if it matches and was verified recently. An object TIA Portal gives no revision
 * for ("none": watch and force tables) is exported again each pass, or with unversionedMs (rung watch) once it
 * was checked longer ago than that.
 */
export function isFresh(entryFp: string, prev: ObjectState, now: number, weakVerifyMs: number, unversionedMs = 0): boolean {
  // marked stale (an import refused as stale, a rename): exported again, whatever the listing or the last check says
  if (prev.tiaFingerprint.startsWith("stale:")) return false;
  // a check from the future (the clock was put back since) is of unknown age: checked again
  const age = now - (prev.verifiedAt ?? 0);
  if (entryFp === "none") return age >= 0 && age < unversionedMs;
  if (isStrong(entryFp)) return prev.tiaFingerprint === entryFp;
  return prev.tiaFingerprint === entryFp && age >= 0 && age < weakVerifyMs;
}

export async function pull(root: string, bridge: BridgeLike, state: StateStore, opts: PullOptions): Promise<PullReport> {
  const now = opts.now ?? Date.now;
  const report: PullReport = { exported: 0, unchanged: 0, readOnly: 0, removed: 0, warnings: [], collisions: [], tooLong: [], overwritten: [] };
  // a person opens files, not addresses: the warning carries the object's file when rung has one
  const warn = (address: string, code: string, message?: string) => {
    const path = state.get(address)?.path;
    report.warnings.push({ address, code, ...(message ? { message } : {}), ...(path ? { path } : {}) });
  };

  const inv = await takeInventory(root, bridge, state, opts.config, (w) => report.warnings.push(w));
  report.collisions = inv.collisions;
  report.tooLong = inv.tooLong;

  // Objects renamed in TIA only by letter case map onto the same file on Windows/macOS:
  // the new address adopts the old state instead of reporting a false local edit and trashing the file.
  const live = new Set(inv.items.map((i) => i.entry.address));
  const orphans = new Map<string, ObjectState>();
  for (const s of state.all()) if (!live.has(s.address)) orphans.set(pathKey(s.path.slice(0, -(s.form.length + 1))), s);
  const adopted = new Set<string>();
  const pendingOps: string[] = [];
  const journal = new Journal(root);
  const checkpoint = async () => {
    await state.flush();
    for (const op of pendingOps.splice(0)) await journal.done(op);
  };

  let done = 0;
  for (const { entry, stem } of inv.items) {
    try {
      if (!stem || inv.blocked.has(entry.address)) continue;
      const readOnly = isReadOnlyEntry(entry);
      let prev = state.get(entry.address);
      let adoptedFrom: string | undefined;
      if (!prev) {
        const o = orphans.get(pathKey(stem));
        if (o && !adopted.has(o.address)) {
          prev = { ...o, address: entry.address };
          adoptedFrom = o.address;
        }
      }

      if (prev && !opts.force && !adoptedFrom) {
        const local = await localStatus(root, prev.files);
        const fresh = isFresh(entry.fingerprint, prev, now(), opts.config.sync.weakVerifyMs);
        if (fresh && local === "clean") {
          report.unchanged++;
          if (prev.readOnly !== readOnly) state.upsert({ ...prev, readOnly });
          if (readOnly) report.readOnly++;
          if (entry.isConsistent === false) warn(entry.address, "INCONSISTENT", INCONSISTENT_HINT);
          continue;
        }
        if (fresh && local === "modified") {
          warn(entry.address, "LOCAL_CHANGES", "file edited locally; TIA unchanged (use rung sync or rung watch to send it to TIA)");
          continue;
        }
      }

      const staged = await stageExport(root, bridge, entry.address, stem);
      const plan = await planPublication(root, prev?.files ?? [], staged.files);
      if (plan.localEdit && !opts.force) {
        warn(entry.address, "LOCAL_CHANGES", "file differs from the last pulled version; not overwritten (use --force to replace, keeping a recovery copy)");
        continue;
      }
      const next = await buildState(root, entry.address, staged, readOnly, now());
      if (!next.tiaFingerprint) next.tiaFingerprint = entry.fingerprint;
      if (plan.targets.length || plan.removes.length) {
        const opId = randomUUID();
        await publishBundle(root, { opId, address: entry.address, targets: plan.targets, removes: plan.removes, nextState: next }, { force: !!opts.force, keepJournal: true });
        if (plan.localEdit) report.overwritten.push({ path: next.path, copy: `.rung/recovery/${opId}` });
        pendingOps.push(opId); // the journal entry is dropped only after state.json has recorded `next`
      }
      state.upsert(next);
      if (adoptedFrom) {
        state.remove(adoptedFrom);
        adopted.add(adoptedFrom);
      }
      for (const w of staged.result.warnings ?? []) warn(entry.address, w, EXPORT_HINTS[w]);
      // re-verified objects without a fingerprint (force tables) whose bytes did not change are not "exported"
      if (plan.targets.length || plan.removes.length || !prev) report.exported++;
      else report.unchanged++;
      if (readOnly) report.readOnly++;
    } catch (e) {
      // A stuck or dead bridge would make every remaining object wait for its own timeout: stop the pull.
      if (e instanceof BridgeError && FATAL_BRIDGE_CODES.has(e.code)) {
        await checkpoint();
        throw e;
      }
      if (e instanceof BridgeError || e instanceof WorkspaceError) warn(entry.address, e.code, e.message);
      else if (isLockError(e)) warn(entry.address, "FILE_LOCKED", `${(e as NodeJS.ErrnoException).path ?? "a file"} is locked or not readable (${(e as NodeJS.ErrnoException).code}); retrying on the next pass`);
      else throw e;
    } finally {
      done++;
      opts.onProgress?.(done, inv.items.length);
      if (done % 100 === 0) await checkpoint();
    }
  }
  await checkpoint();

  // Objects gone from a complete inventory: trash their files if untouched.
  for (const s of state.all()) {
    if (live.has(s.address) || inv.skipped.has(s.address) || adopted.has(s.address)) continue;
    if (s.status === "importing") {
      // a create interrupted before TIA Portal had it: the file is the user's new file, never trash it
      state.remove(s.address);
      continue;
    }
    if (!inv.devices.includes(parseAddress(s.address).device)) continue;
    const removes = [];
    let localEdit = false;
    for (const f of s.files) {
      const cur = await diskHash(root, f.path, f.hash);
      if (cur === "absent") continue;
      if (cur !== f.hash) localEdit = true;
      removes.push({ path: f.path, prevHash: cur });
    }
    if (localEdit) {
      warn(s.address, "LOCAL_CHANGES", "deleted in TIA but edited locally; file kept");
      state.upsert({ ...s, status: "conflicted" });
      continue;
    }
    if (removes.length) await publishBundle(root, { opId: randomUUID(), address: s.address, targets: [], removes, nextState: s });
    state.remove(s.address);
    report.removed++;
  }

  await state.flush();
  return report;
}
