// SPDX-License-Identifier: BUSL-1.1
// rung pull: one-way, incremental TIA → workspace mirror that never destroys local work.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AddressError,
  BlobStore,
  WorkspaceError,
  addressToStem,
  bundleHash,
  isContained,
  normalizeText,
  parseAddress,
  preflight,
  publishBundle,
  recoverJournal,
  sha256,
  type Address,
  type ObjectState,
  type RungConfig,
  type StateFile,
  type StateStore,
} from "@rung/core";
import { BridgeError, type BridgeClient, type ObjectEntry } from "@rung/bridge-client";

export type BridgeLike = Pick<BridgeClient, "projectInfo" | "listObjects" | "exportObject">;

export interface PullWarning {
  address: string;
  code: string;
  message?: string;
}

export interface PullReport {
  exported: number;
  unchanged: number;
  readOnly: number;
  removed: number;
  warnings: PullWarning[];
  collisions: [string, string][];
  tooLong: string[];
}

export interface PullOptions {
  config: RungConfig;
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
  now?: () => number;
}

/** Staged files are named "obj<suffix>"; the suffix is appended to the object's stem in the workspace. */
export const STAGED_STEM = "obj";
const SAFE_SUFFIX = /^\.[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

export function isReadOnlyEntry(e: ObjectEntry): boolean {
  return e.knowHowProtected || e.isFailsafe || e.isSystem || (e.language ?? "").includes("GRAPH");
}

const isStrong = (fp: string) => fp.startsWith("fp:");
const rel2abs = (root: string, rel: string) => join(root, ...rel.split("/"));
const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

async function diskHash(root: string, rel: string): Promise<string | "absent"> {
  try {
    return sha256(await readFile(rel2abs(root, rel)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
}

async function diskMatches(root: string, files: readonly StateFile[]): Promise<boolean> {
  for (const f of files) if ((await diskHash(root, f.path)) !== f.hash) return false;
  return true;
}

/** Disk state relative to the recorded base: clean, missing files only, or locally modified. */
async function localStatus(root: string, files: readonly StateFile[]): Promise<"clean" | "missing" | "modified"> {
  let missing = false;
  for (const f of files) {
    const h = await diskHash(root, f.path);
    if (h === "absent") missing = true;
    else if (h !== f.hash) return "modified";
  }
  return missing ? "missing" : "clean";
}

export async function pull(root: string, bridge: BridgeLike, state: StateStore, opts: PullOptions): Promise<PullReport> {
  const now = opts.now ?? Date.now;
  const report: PullReport = { exported: 0, unchanged: 0, readOnly: 0, removed: 0, warnings: [], collisions: [], tooLong: [] };
  const warn = (address: string, code: string, message?: string) => report.warnings.push(message ? { address, code, message } : { address, code });

  // 1. Binding: never mirror a different project into this workspace.
  const info = await bridge.projectInfo();
  if (!samePath(info.path, opts.config.project.path) || info.tiaVersion !== opts.config.project.tiaVersion)
    throw new WorkspaceError("BINDING_MISMATCH", `bridge is attached to ${info.path} (${info.tiaVersion}); workspace is bound to ${opts.config.project.path}`);
  const devices = opts.config.devices.length ? opts.config.devices : info.devices;
  for (const d of devices) if (!info.devices.includes(d)) throw new WorkspaceError("BINDING_MISMATCH", `device ${d} not found in project`);

  for (const u of info.units ?? []) {
    const [dev, unit] = u.split("/");
    if (dev && unit && devices.includes(dev)) warn(`plc:${dev}/units/${unit}`, "UNSUPPORTED_UNIT", "software units are mirrored from M5 on");
  }

  // 2. Finish interrupted publications before deciding anything.
  const recovery = await recoverJournal(root);
  for (const s of recovery.completed) state.upsert(s);
  const blocked = new Set(recovery.recoveryRequired);
  for (const a of blocked) warn(a, "RECOVERY_REQUIRED", "interrupted publication left foreign content; see .rung/journal and .rung/recovery");

  // 3. Complete inventory first. Any failure aborts before a single file changes.
  const inventory: { entry: ObjectEntry; address: Address }[] = [];
  for (const device of devices) {
    for (const entry of await bridge.listObjects(device)) {
      let address: Address;
      try {
        address = parseAddress(entry.address);
      } catch (e) {
        if (!(e instanceof AddressError)) throw e;
        warn(entry.address, "BAD_ADDRESS", "bridge returned a non-canonical address");
        continue;
      }
      if ((entry.namespace ?? undefined) !== address.namespace || (entry.unit ?? undefined) !== address.unit) {
        warn(entry.address, "BAD_ADDRESS", "namespace/unit metadata does not match the address");
        continue;
      }
      if (address.unit !== undefined) {
        warn(entry.address, "UNSUPPORTED_UNIT", "software units are mirrored from M5 on");
        continue;
      }
      if (entry.isSystem) {
        warn(entry.address, "UNSUPPORTED_OBJECT", "system blocks are not mirrored");
        continue;
      }
      inventory.push({ entry, address });
    }
  }

  // 4. Path preflight: colliding or too-long objects are not written at all.
  const planned = inventory.map((i) => ({ address: i.entry.address, stem: addressToStem(i.address) }));
  const pre = preflight(root, planned);
  report.collisions = pre.collisions;
  report.tooLong = pre.tooLong;
  for (const [a, b] of pre.collisions) warn(a, "PATH_COLLISION", `collides with ${b}`);
  for (const s of pre.tooLong) warn(s, "PATH_TOO_LONG");
  const writable = new Map(pre.ok.map((p) => [p.address, p.stem]));

  const blobs = new BlobStore(root);
  const tmpRoot = join(root, ".rung", "tmp");
  let done = 0;
  const total = inventory.length;

  for (const { entry } of inventory) {
    const stem = writable.get(entry.address);
    try {
      if (!stem || blocked.has(entry.address)) continue;
      const readOnly = isReadOnlyEntry(entry);
      const prev = state.get(entry.address);

      if (prev && !opts.force) {
        const local = await localStatus(root, prev.files);
        const fresh = isStrong(entry.fingerprint)
          ? prev.tiaFingerprint === entry.fingerprint
          : prev.tiaFingerprint === entry.fingerprint && now() - (prev.verifiedAt ?? 0) < opts.config.sync.weakVerifyMs;
        if (fresh && local === "clean") {
          report.unchanged++;
          if (prev.readOnly) report.readOnly++;
          continue;
        }
        if (fresh && local === "modified") {
          warn(entry.address, "LOCAL_CHANGES", "file edited locally; TIA unchanged (two-way sync arrives with rung watch)");
          continue;
        }
      }

      // Export into a private staging directory.
      const stage = join(tmpRoot, randomUUID());
      await mkdir(stage, { recursive: true });
      let result;
      try {
        result = await bridge.exportObject(entry.address, "auto", stage);
        const files: StateFile[] = [];
        const data = new Map<string, Buffer>();
        for (const f of result.files) {
          const name = basename(f.path);
          const suffix = name.startsWith(STAGED_STEM) ? name.slice(STAGED_STEM.length) : "";
          if (!SAFE_SUFFIX.test(suffix) || (f.role === "primary") !== (suffix === "." + result.form))
            throw new BridgeError("EXPORT_FAILED", `unexpected staged file ${JSON.stringify(name)} (${f.role})`);
          if (!(await isContained(stage, f.path))) throw new BridgeError("EXPORT_FAILED", `staged file outside staging dir: ${f.path}`);
          const bytes = Buffer.from(normalizeText((await readFile(f.path)).toString("utf8")), "utf8");
          const rel = stem + suffix;
          if (!(await isContained(root, rel2abs(root, rel)))) throw new WorkspaceError("PATH_ESCAPE", `${rel} resolves outside the workspace`);
          files.push({ path: rel, role: f.role, hash: await blobs.put(bytes) });
          data.set(rel, bytes);
        }
        const primary = files.find((f) => f.role === "primary");
        if (!primary) throw new BridgeError("EXPORT_FAILED", "export returned no primary file");
        files.sort((a, b) => (a.path < b.path ? -1 : 1));

        // Compare with disk and base; build a guarded publication.
        const baseByPath = new Map((prev?.files ?? []).map((f) => [f.path, f.hash]));
        const targets = [];
        let localEdit = false;
        for (const f of files) {
          const cur = await diskHash(root, f.path);
          const base = baseByPath.get(f.path) ?? "absent";
          if (cur !== base && cur !== f.hash && cur !== "absent") localEdit = true;
          if (cur !== f.hash) targets.push({ path: f.path, hash: f.hash, prevHash: cur });
        }
        const removes = [];
        for (const old of prev?.files ?? []) {
          if (files.some((f) => f.path === old.path)) continue;
          const cur = await diskHash(root, old.path);
          if (cur === "absent") continue;
          if (cur !== old.hash) localEdit = true;
          removes.push({ path: old.path, prevHash: cur });
        }
        if (localEdit && !opts.force) {
          warn(entry.address, "LOCAL_CHANGES", "file differs from the last pulled version; not overwritten (use --force to replace, keeping a recovery copy)");
          continue;
        }
        const manifest = JSON.stringify(files.map((f) => ({ role: f.role, path: f.path, hash: f.hash })));
        const next: ObjectState = {
          address: entry.address,
          path: primary.path,
          form: result.form,
          fileHash: bundleHash(files),
          files,
          tiaFingerprint: result.fingerprint || entry.fingerprint,
          baseId: await blobs.put(manifest),
          readOnly,
          warnings: [...(result.warnings ?? [])],
          status: "synced",
          verifiedAt: now(),
        };
        if (targets.length || removes.length)
          await publishBundle(root, { opId: randomUUID(), address: entry.address, targets, removes, nextState: next }, { force: !!opts.force });
        state.upsert(next);
        for (const w of result.warnings ?? []) warn(entry.address, w);
        report.exported++;
        if (readOnly) report.readOnly++;
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    } catch (e) {
      if (e instanceof BridgeError && ["TIA_NOT_RUNNING", "PORTAL_DISPOSED", "BRIDGE_EXITED", "ACCESS_DENIED"].includes(e.code)) throw e;
      if (e instanceof BridgeError || e instanceof WorkspaceError) warn(entry.address, e.code, e.message);
      else throw e;
    } finally {
      done++;
      opts.onProgress?.(done, total);
      if (done % 100 === 0) await state.flush();
    }
  }

  // 5. Objects gone from a complete inventory: trash their files if untouched.
  const seen = new Set(inventory.map((i) => i.entry.address));
  const skipped = new Set(report.warnings.filter((w) => w.code === "UNSUPPORTED_UNIT" || w.code === "UNSUPPORTED_OBJECT" || w.code === "BAD_ADDRESS").map((w) => w.address));
  for (const s of state.all()) {
    if (seen.has(s.address) || skipped.has(s.address)) continue;
    const device = parseAddress(s.address).device;
    if (!devices.includes(device)) continue;
    const removes = [];
    let localEdit = false;
    for (const f of s.files) {
      const cur = await diskHash(root, f.path);
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

/** True when every file recorded for the object is on disk with the recorded hash. */
export { diskMatches };
