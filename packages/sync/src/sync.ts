// SPDX-License-Identifier: BUSL-1.1
// One two-way reconciliation pass between the workspace and TIA Portal (rung sync; rung watch repeats it).
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  BlobStore,
  Journal,
  WorkspaceError,
  addressToStem,
  bundleHash,
  formatAddress,
  parseAddress,
  pathToAddress,
  publishBundle,
  replaceGuarded,
  sha256,
  writeFileAtomic,
  type ObjectState,
  type RungConfig,
  type StateFile,
  type StateStore,
} from "@rung/core";
import { BridgeError, type BridgeClient } from "@rung/bridge-client";
import { takeInventory, type Warning } from "./inventory.js";
import { SOURCE_FORMS, mergeBundle, mergeText } from "./merge.js";
import {
  baseBundle,
  buildState,
  diskHash,
  isReadOnlyEntry,
  localStatus,
  mapStaged,
  planPublication,
  readBundle,
  rel2abs,
  stageExport,
  stageForImport,
  type BridgeLike,
  type StagedExport,
} from "./objects.js";
import { FATAL_BRIDGE_CODES, isFresh } from "./pull.js";
import { placeCompileMessages } from "./compile-lines.js";

export type SyncBridge = BridgeLike & Pick<BridgeClient, "importObject" | "compile">;

export interface Diagnostic {
  address: string;
  /** Workspace-relative path of the primary file. */
  path: string;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  line?: number;
  column?: number;
}

export interface SyncReport {
  exported: number;
  imported: number;
  created: number;
  merged: number;
  unchanged: number;
  conflicts: number;
  removed: number;
  pendingDeletes: number;
  warnings: Warning[];
  diagnostics: Diagnostic[];
}

export interface SyncOptions {
  config: RungConfig;
  now?: () => number;
  onProgress?: (done: number, total: number) => void;
}

interface ImportJob {
  address: string;
  name: string;
  form: string;
  stem: string;
  bundle: Record<string, string>;
  /** TIA revision the bundle was based on, or "absent" for a new object. */
  expected: string;
  /** Raw disk hashes of the files as read, used to guard the canonical rewrite. */
  captured: StateFile[];
  kind: "update" | "create" | "merge";
  rank: number;
  deps: string[];
}

const stemOf = (s: Pick<ObjectState, "path" | "form">) => s.path.slice(0, -(s.form.length + 1));
const CREATABLE = new Set(["scl", "awl", "db", "udt", "xml", "s7dcl", "tags.xml"]);
const CONFLICT_SUFFIXES = [".conflict", ".tia"];

/** Primary files in the workspace: address → path/form (conflict artefacts, dotfiles and unknown files ignored). */
async function scanWorkspace(root: string): Promise<Map<string, { path: string; form: string; stem: string }>> {
  const out = new Map<string, { path: string; form: string; stem: string }>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (CONFLICT_SUFFIXES.some((s) => e.name.endsWith(s))) continue;
      const rel = relative(root, abs).split(sep).join("/");
      const hit = pathToAddress(rel);
      if (!hit) continue;
      out.set(formatAddress(hit.address), { path: rel, form: hit.form, stem: rel.slice(0, -(hit.form.length + 1)) });
    }
  };
  await walk(join(root, "plc"));
  return out;
}


/** Local companion files of a stem (e.g. .s7res next to .s7dcl) plus the primary. */
async function localBundle(root: string, stem: string, primaryPath: string): Promise<{ bundle: Record<string, string>; captured: StateFile[] }> {
  const dir = rel2abs(root, stem.split("/").slice(0, -1).join("/"));
  const leaf = stem.split("/").pop()!;
  const bundle: Record<string, string> = {};
  const captured: StateFile[] = [];
  for (const name of await readdir(dir)) {
    if (!name.startsWith(leaf + ".") || CONFLICT_SUFFIXES.some((s) => name.endsWith(s))) continue;
    const rel = stem + name.slice(leaf.length);
    const bytes = await readFile(rel2abs(root, rel));
    bundle[name.slice(leaf.length)] = bytes.toString("utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
    captured.push({ path: rel, role: rel === primaryPath ? "primary" : "companion" + name.slice(leaf.length), hash: sha256(bytes) });
  }
  return { bundle, captured };
}

/** Quoted identifiers a source refers to (its own name excluded). */
function referencedNames(texts: string[], self: string): string[] {
  const names = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/"([^"\r\n]+)"/g)) if (m[1] !== self) names.add(m[1]!);
  return [...names];
}

function rankOf(form: string, texts: string[]): number {
  if (form === "udt" || form === "tags.xml") return 0;
  if (form === "db") return 1;
  if (texts.some((t) => /^\s*ORGANIZATION_BLOCK\b/m.test(t))) return 3;
  return 2;
}

async function writeDiagnostics(root: string, items: Diagnostic[]): Promise<number> {
  const file = join(root, ".rung", "diagnostics.json");
  let seq = 0;
  try {
    seq = (JSON.parse(await readFile(file, "utf8")) as { seq: number }).seq ?? 0;
  } catch {
    /* first run */
  }
  await writeFileAtomic(file, JSON.stringify({ seq: seq + 1, items }, null, 2) + "\n");
  return seq + 1;
}

export async function syncOnce(root: string, bridge: SyncBridge, state: StateStore, opts: SyncOptions): Promise<SyncReport> {
  const now = opts.now ?? Date.now;
  const cfg = opts.config;
  const report: SyncReport = { exported: 0, imported: 0, created: 0, merged: 0, unchanged: 0, conflicts: 0, removed: 0, pendingDeletes: 0, warnings: [], diagnostics: [] };
  const warn = (address: string, code: string, message?: string) => report.warnings.push(message ? { address, code, message } : { address, code });
  const diag = (d: Diagnostic) => report.diagnostics.push(d);

  const inv = await takeInventory(root, bridge, state, cfg, (w) => report.warnings.push(w));
  const items = new Map(inv.items.map((i) => [i.entry.address, i]));
  const local = await scanWorkspace(root);
  const bound = (a: string) => {
    try {
      return inv.devices.includes(parseAddress(a).device);
    } catch {
      return false;
    }
  };
  const addresses = [...new Set([...items.keys(), ...state.all().map((s) => s.address).filter(bound), ...[...local.keys()].filter(bound)])].sort();

  const journal = new Journal(root);
  const pendingOps: string[] = [];
  const checkpoint = async () => {
    await state.flush();
    for (const op of pendingOps.splice(0)) await journal.done(op);
  };
  const publish = async (address: string, prevFiles: readonly StateFile[], staged: StagedExport, readOnly: boolean, force = false) => {
    const plan = await planPublication(root, prevFiles, staged.files);
    if (plan.localEdit && !force) throw new WorkspaceError("LOCAL_CHANGES", `${staged.primary.path} changed locally; not overwritten`);
    const next = await buildState(root, address, staged, readOnly, now());
    if (plan.targets.length || plan.removes.length) {
      const opId = randomUUID();
      await publishBundle(root, { opId, address, targets: plan.targets, removes: plan.removes, nextState: next }, { keepJournal: true, force });
      pendingOps.push(opId);
    }
    state.upsert(next);
    return next;
  };
  const writeConflict = async (st: ObjectState, stem: string, files: Record<string, string>, staged: StagedExport, source: boolean) => {
    if (source) {
      for (const [suffix, text] of Object.entries(files)) if (text.includes("<<<<<<< file")) await writeFileAtomic(rel2abs(root, stem + suffix + ".conflict"), text);
    } else {
      for (const [suffix, text] of staged.texts) await writeFileAtomic(rel2abs(root, stem + suffix + ".tia"), text);
    }
    state.upsert({ ...st, status: "conflicted", conflict: { tiaFingerprint: staged.result.fingerprint, tiaFiles: staged.files } });
    report.conflicts++;
    diag({ address: st.address, path: st.path, severity: "error", code: "CONFLICT", message: "Edited in the workspace and in TIA Portal; resolve with rung resolve" });
  };

  const queue: ImportJob[] = [];
  let done = 0;
  for (const address of addresses) {
    try {
      if (inv.blocked.has(address) || inv.skipped.has(address)) continue;
      const item = items.get(address);
      const st = state.get(address);
      const loc = local.get(address);
      if (item && !item.stem) continue; // path collision, already warned

      if (st?.status === "conflicted") {
        warn(address, "CONFLICT", "unresolved conflict; run rung resolve");
        diag({ address, path: st.path, severity: "error", code: "CONFLICT", message: "Unresolved conflict; run rung resolve" });
        continue;
      }
      if (st?.status === "recoveryRequired") {
        warn(address, "RECOVERY_REQUIRED", "the last import has an unknown outcome; check TIA Portal and run rung resolve");
        continue;
      }

      if (item && st) {
        const stem = item.stem!;
        const readOnly = isReadOnlyEntry(item.entry);
        const status = await localStatus(root, st.files);
        let staged: StagedExport | undefined;
        let tiaChanged = false;
        if (!isFresh(item.entry.fingerprint, st, now(), cfg.sync.weakVerifyMs)) {
          staged = await stageExport(root, bridge, address, stem);
          tiaChanged = bundleHash(staged.files) !== st.fileHash;
          if (!tiaChanged) state.upsert({ ...st, tiaFingerprint: staged.result.fingerprint, verifiedAt: now() });
        }
        const cur = state.get(address)!;

        if (status === "clean") {
          if (tiaChanged) {
            await publish(address, cur.files, staged!, readOnly);
            report.exported++;
          } else {
            if (cur.status === "pendingDelete") state.upsert({ ...cur, status: "synced" });
            report.unchanged++;
          }
          continue;
        }
        if (status === "missing") {
          if (!tiaChanged && !readOnly && cfg.sync.delete === "confirm") {
            state.upsert({ ...cur, status: "pendingDelete" });
            report.pendingDeletes++;
            diag({ address, path: cur.path, severity: "warning", code: "DELETE_PENDING", message: "Deleted in the workspace; run rung confirm-delete to delete it in TIA Portal, or restore the file" });
            continue;
          }
          staged ??= await stageExport(root, bridge, address, stem);
          await publish(address, cur.files, staged, readOnly, true);
          report.exported++;
          if (tiaChanged) warn(address, "DELETE_CONFLICT", "deleted locally but changed in TIA; restored the TIA version");
          continue;
        }
        // modified locally
        if (readOnly) {
          state.upsert({ ...cur, status: "fileDirty" });
          diag({ address, path: cur.path, severity: "error", code: "READ_ONLY_EDIT", message: "This object is read-only in rung (protected, failsafe, system or GRAPH); the edit is not sent to TIA Portal" });
          continue;
        }
        if (cfg.sync.import === "manual") {
          warn(address, "IMPORT_MANUAL", "local edit not sent to TIA (sync.import = manual)");
          continue;
        }
        const { bundle, captured } = await localBundle(root, stemOf(cur), cur.path);
        const name = parseAddress(address).name;
        const texts = Object.values(bundle);
        if (!tiaChanged) {
          queue.push({ address, name, form: cur.form, stem, bundle, expected: cur.tiaFingerprint, captured, kind: "update", rank: rankOf(cur.form, texts), deps: referencedNames(texts, name) });
          continue;
        }
        // changed on both sides
        const base = await baseBundle(root, stemOf(cur), cur.files);
        const tia = Object.fromEntries(staged!.texts);
        if (staged!.result.form !== cur.form) {
          await writeConflict(cur, stem, bundle, staged!, false);
          continue;
        }
        const m = mergeBundle(cur.form, base, bundle, tia);
        if (m.kind === "conflict") {
          await writeConflict(cur, stem, m.files, staged!, SOURCE_FORMS.has(cur.form));
          continue;
        }
        const mergedTexts = Object.values(m.files);
        if (JSON.stringify(m.files) === JSON.stringify(tia)) {
          await publish(address, captured, staged!, readOnly, false);
          report.exported++;
        } else
          queue.push({ address, name, form: cur.form, stem, bundle: m.files, expected: staged!.result.fingerprint, captured, kind: "merge", rank: rankOf(cur.form, mergedTexts), deps: referencedNames(mergedTexts, name) });
        continue;
      }

      if (item && !st) {
        const stem = item.stem!;
        const readOnly = isReadOnlyEntry(item.entry);
        const staged = await stageExport(root, bridge, address, stem);
        const present = await Promise.all(staged.files.map((f) => diskHash(root, f.path)));
        if (present.every((h) => h === "absent")) {
          await publish(address, [], staged, readOnly);
          report.exported++;
        } else if (staged.files.every((f, i) => present[i] === f.hash)) {
          state.upsert(await buildState(root, address, staged, readOnly, now()));
          report.unchanged++;
        } else {
          const next = await buildState(root, address, staged, readOnly, now());
          const primarySuffix = "." + staged.result.form;
          const mine = (await readBundle(root, stem, staged.files)) ?? {};
          const files: Record<string, string> = {};
          if (SOURCE_FORMS.has(staged.result.form)) files[primarySuffix] = mergeText(null, mine[primarySuffix] ?? "", staged.texts.get(primarySuffix) ?? "").text;
          await writeConflict(next, stem, files, staged, SOURCE_FORMS.has(staged.result.form));
        }
        continue;
      }

      if (!item && st) {
        const status = await localStatus(root, st.files);
        if (status === "modified") {
          warn(address, "LOCAL_CHANGES", "deleted in TIA but edited locally; file kept");
          state.upsert({ ...st, status: "conflicted" });
          continue;
        }
        const removes = [];
        for (const f of st.files) {
          const h = await diskHash(root, f.path);
          if (h !== "absent") removes.push({ path: f.path, prevHash: h });
        }
        if (removes.length) await publishBundle(root, { opId: randomUUID(), address, targets: [], removes, nextState: st });
        state.remove(address);
        report.removed++;
        continue;
      }

      if (loc) {
        if (cfg.sync.import !== "auto") {
          warn(address, "IMPORT_MANUAL", "new file not sent to TIA (sync.import = manual)");
          continue;
        }
        if (!CREATABLE.has(loc.form)) {
          warn(address, "UNSUPPORTED_OBJECT", `cannot create objects from ${loc.form} files`);
          continue;
        }
        const { bundle, captured } = await localBundle(root, loc.stem, loc.path);
        const name = parseAddress(address).name;
        const texts = Object.values(bundle);
        queue.push({ address, name, form: loc.form, stem: addressToStem(parseAddress(address)), bundle, expected: "absent", captured, kind: "create", rank: rankOf(loc.form, texts), deps: referencedNames(texts, name) });
      }
    } catch (e) {
      if (e instanceof BridgeError && FATAL_BRIDGE_CODES.has(e.code)) {
        await checkpoint();
        throw e;
      }
      if (e instanceof BridgeError || e instanceof WorkspaceError) warn(address, e.code, e.message);
      else throw e;
    } finally {
      done++;
      opts.onProgress?.(done, addresses.length);
      if (done % 100 === 0) await checkpoint();
    }
  }

  // Imports in dependency order; cycles and dependants of failures are blocked, never guessed.
  const imported: string[] = [];
  const byName = new Map(queue.map((j) => [j.name, j]));
  const order: ImportJob[] = [];
  const visiting = new Set<string>();
  const cyclic = new Set<string>();
  const visited = new Set<string>();
  const visit = (j: ImportJob, stack: ImportJob[]): void => {
    if (visited.has(j.address)) return;
    if (visiting.has(j.address)) {
      for (const s of stack.slice(stack.indexOf(j))) cyclic.add(s.address);
      return;
    }
    visiting.add(j.address);
    for (const d of j.deps) {
      const dep = byName.get(d);
      if (dep) visit(dep, [...stack, j]);
    }
    visiting.delete(j.address);
    visited.add(j.address);
    order.push(j);
  };
  for (const j of [...queue].sort((a, b) => a.rank - b.rank || (a.address < b.address ? -1 : 1))) visit(j, [j]);

  const failed = new Set<string>();
  for (const job of order) {
    const st = state.get(job.address);
    const primaryPath = job.captured.find((c) => c.role === "primary")?.path ?? job.stem + "." + job.form;
    const blockedBy = job.deps.map((d) => byName.get(d)).find((d) => d && (failed.has(d.address) || cyclic.has(d.address)));
    if (cyclic.has(job.address) || blockedBy) {
      failed.add(job.address);
      diag({ address: job.address, path: primaryPath, severity: "error", code: "DEPENDENCY_BLOCKED", message: cyclic.has(job.address) ? "Cyclic dependency between changed objects; import them together with rung sync --batch (not automatic)" : `Waiting for ${blockedBy!.address}, which could not be imported` });
      continue;
    }
    const stage = await stageForImport(root, job.form, job.bundle);
    let result;
    try {
      result = await bridge.importObject(job.address, job.form, stage.primary, job.expected, randomUUID());
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      if (e.code === "OUTCOME_UNKNOWN") {
        state.upsert({
          ...(st ?? { address: job.address, path: primaryPath, form: job.form, fileHash: "", files: [], tiaFingerprint: "absent", baseId: "", readOnly: false, warnings: [] }),
          status: "recoveryRequired",
        });
        await checkpoint();
        throw e;
      }
      if (FATAL_BRIDGE_CODES.has(e.code)) {
        await checkpoint();
        throw e;
      }
      failed.add(job.address);
      if (e.code === "STALE_REVISION") warn(job.address, e.code, "TIA Portal changed meanwhile; merging on the next pass");
      else diag({ address: job.address, path: primaryPath, severity: "error", code: e.code, message: e.message });
      if (st) state.upsert({ ...st, status: "fileDirty" });
      continue;
    } finally {
      await rm(stage.dir, { recursive: true, force: true });
    }
    // Canonical rewrite: replace the imported files with TIA's form unless they were edited meanwhile.
    const staged = await mapStaged(root, result, null, job.stem);
    const plan = await planPublication(root, job.captured, staged.files);
    const next = await buildState(root, job.address, staged, false, now());
    if (plan.localEdit) warn(job.address, "EDITED_DURING_IMPORT", "the file changed while it was imported; the newer edit is sent on the next pass");
    else if (plan.targets.length || plan.removes.length) {
      const opId = randomUUID();
      await publishBundle(root, { opId, address: job.address, targets: plan.targets, removes: plan.removes, nextState: next }, { keepJournal: true });
      pendingOps.push(opId);
    }
    state.upsert(next);
    if (job.kind === "create") report.created++;
    else if (job.kind === "merge") report.merged++;
    else report.imported++;
    imported.push(job.address);
  }
  await checkpoint();

  // Compile what was imported and turn compiler messages into diagnostics.
  if (imported.length && cfg.sync.compile !== "none") {
    const byDevice = new Map<string, string[]>();
    for (const a of imported) {
      const d = parseAddress(a).device;
      byDevice.set(d, [...(byDevice.get(d) ?? []), a]);
    }
    for (const [device, addrs] of byDevice) {
      try {
        const raw = await bridge.compile(device, cfg.sync.compile === "all" ? [] : addrs);
        const msgs = await placeCompileMessages(root, (a) => state.get(a)?.path, raw, (f) => readFile(f, "utf8"));
        for (const m of msgs) {
          const target = m.address ?? "";
          const path = (target && state.get(target)?.path) || "";
          diag({ address: target, path, severity: m.severity, code: "COMPILE", message: m.description, ...(m.line ? { line: m.line } : {}), ...(m.column ? { column: m.column } : {}) });
        }
      } catch (e) {
        if (!(e instanceof BridgeError)) throw e;
        warn(`plc:${device}`, "COMPILE_FAILED", e.message);
      }
    }
  }

  await writeDiagnostics(root, report.diagnostics);
  await state.flush();
  return report;
}

/** Deletes an object in TIA after the user deleted its files and confirmed. */
export async function confirmDelete(
  root: string,
  bridge: { deleteObject(address: string, expectedTiaRevision: string, operationId: string): Promise<unknown> },
  state: StateStore,
  address: string,
): Promise<void> {
  const st = state.get(address);
  if (!st || st.status !== "pendingDelete") throw new WorkspaceError("CONFIG_INVALID", `${address} has no pending delete`);
  if ((await localStatus(root, st.files)) !== "missing" || (await Promise.all(st.files.map((f) => diskHash(root, f.path)))).some((h) => h !== "absent"))
    throw new WorkspaceError("LOCAL_CHANGES", `${address} has files again; delete not confirmed`);
  await bridge.deleteObject(address, st.tiaFingerprint, randomUUID());
  state.remove(address);
  await state.flush();
}

/**
 * Resolves a conflict recorded by syncOnce:
 *  - "theirs": the TIA version replaces the workspace file (the workspace version is kept in .rung/recovery);
 *  - "ours" / "merged": the current workspace file is the resolution and is imported on the next pass
 *    against exactly the TIA revision the conflict was computed from.
 */
export async function resolveConflict(root: string, state: StateStore, path: string, mode: "ours" | "theirs" | "merged"): Promise<void> {
  const st = state.byPath(path);
  if (!st || st.status !== "conflicted") throw new WorkspaceError("CONFIG_INVALID", `${path} is not in conflict`);
  const tiaFiles = st.conflict?.tiaFiles ?? st.files;
  const tiaFingerprint = st.conflict?.tiaFingerprint ?? st.tiaFingerprint;
  if (mode === "theirs") {
    const blobs = new BlobStore(root);
    for (const f of tiaFiles)
      await replaceGuarded(rel2abs(root, f.path), await blobs.get(f.hash), { expectedHash: await diskHash(root, f.path), recoveryDir: join(root, ".rung", "recovery", "resolve-" + randomUUID()), force: true });
    state.upsert({ ...st, files: tiaFiles, fileHash: bundleHash(tiaFiles), path: tiaFiles.find((f) => f.role === "primary")?.path ?? st.path, tiaFingerprint, status: "synced", conflict: undefined });
  } else {
    for (const f of tiaFiles) {
      const text = await readFile(rel2abs(root, f.path), "utf8").catch(() => "");
      if (/^<<<<<<< file$/m.test(text)) throw new WorkspaceError("CONFIG_INVALID", `${f.path} still contains conflict markers`);
    }
    // Base = the TIA version the conflict saw: the next pass sees "file modified, TIA unchanged" and imports.
    state.upsert({ ...st, files: tiaFiles, fileHash: bundleHash(tiaFiles), tiaFingerprint, status: "fileDirty", conflict: undefined });
  }
  for (const f of tiaFiles) for (const s of CONFLICT_SUFFIXES) await unlink(rel2abs(root, f.path + s)).catch(() => {});
  await state.flush();
}
