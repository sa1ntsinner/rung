// SPDX-License-Identifier: BUSL-1.1
// One two-way reconciliation pass between the workspace and TIA Portal (rung sync; rung watch repeats it).
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  BlobStore,
  Journal,
  MAX_ABSOLUTE_PATH,
  WorkspaceError,
  addressToStem,
  bundleHash,
  formatAddress,
  ignoredSourceReason,
  parseAddress,
  pathToAddress,
  preflight,
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
  isLockError,
  isReadOnlyEntry,
  localStatus,
  readOnlyReason,
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
  /** TIA revision the object had when the message was produced (compile messages are kept while it holds). */
  revision?: string;
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
const sameTexts = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const CREATABLE = new Set(["scl", "awl", "db", "udt", "xml", "s7dcl", "tags.xml"]);
const CONFLICT_SUFFIXES = [".conflict", ".tia"];

interface LocalFile {
  path: string;
  form: string;
  stem: string;
}

/**
 * Primary files in the workspace: address → the files that claim it (normally one). Conflict artefacts,
 * dotfiles and companions are skipped; a file that looks like a source but is not one rung reads is reported.
 */
async function scanWorkspace(root: string): Promise<{ files: Map<string, LocalFile[]>; ignored: { path: string; reason: string }[] }> {
  const out = new Map<string, LocalFile[]>();
  const ignored: { path: string; reason: string }[] = [];
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
      if (!hit) {
        const reason = ignoredSourceReason(rel);
        if (reason) ignored.push({ path: rel, reason });
        continue;
      }
      const address = formatAddress(hit.address);
      out.set(address, [...(out.get(address) ?? []), { path: rel, form: hit.form, stem: rel.slice(0, -(hit.form.length + 1)) }]);
    }
  };
  await walk(join(root, "plc"));
  return { files: out, ignored };
}

/** Staging folders older than this are left over from an interrupted pass (a live one exists for seconds). */
const STAGING_MAX_AGE_MS = 30 * 60_000;

async function sweepStaging(root: string, now: number): Promise<void> {
  const dir = join(root, ".rung", "tmp");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    try {
      if (now - (await stat(p)).mtimeMs > STAGING_MAX_AGE_MS) await rm(p, { recursive: true, force: true });
    } catch {
      /* gone or in use: the next pass tries again */
    }
  }
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

/**
 * Writes this pass's diagnostics. Compile messages of earlier passes stay while their object was not
 * compiled again and still has the TIA revision they were produced for: a broken block stays red.
 */
/**
 * The imported objects plus every mirrored object that names one of them: instance DBs of a changed FB and
 * the blocks that call it are inconsistent in TIA until they are compiled too.
 */
async function withUsers(root: string, state: StateStore, imported: string[]): Promise<string[]> {
  const out = new Set(imported);
  const devices = new Set(imported.map((a) => parseAddress(a).device));
  const texts = new Map<string, string>();
  const candidates = state.all().filter((s) => !s.readOnly && s.files[0] && devices.has(parseAddress(s.address).device));
  for (const s of candidates) texts.set(s.address, await readFile(join(root, s.files[0]!.path), "utf8").catch(() => ""));
  const usersOf = (names: string[]) => candidates.filter((s) => !out.has(s.address) && names.some((n) => texts.get(s.address)!.includes(`"${n}"`)));
  const first = usersOf(imported.map((a) => parseAddress(a).name));
  for (const s of first) out.add(s.address);
  // a call goes through the instance DB ("FB_Pump_DB"()), so the blocks that use those DBs follow too
  for (const s of usersOf(first.filter((s) => s.form === "db").map((s) => parseAddress(s.address).name))) out.add(s.address);
  return [...out];
}

async function writeDiagnostics(root: string, items: Diagnostic[], keep: (d: Diagnostic) => boolean = () => false): Promise<number> {
  const file = join(root, ".rung", "diagnostics.json");
  let seq = 0;
  let previous: Diagnostic[] = [];
  try {
    const old = JSON.parse(await readFile(file, "utf8")) as { seq: number; items?: Diagnostic[] };
    seq = old.seq ?? 0;
    previous = old.items ?? [];
  } catch {
    /* first run */
  }
  const kept = previous.filter((d) => d.code === "COMPILE" && keep(d));
  const key = (d: Diagnostic) => `${d.address}\u0000${d.line ?? ""}\u0000${d.message}`;
  const seen = new Set(items.map(key));
  const all = [...kept.filter((d) => !seen.has(key(d))), ...items];
  await writeFileAtomic(file, JSON.stringify({ seq: seq + 1, items: all }, null, 2) + "\n");
  return seq + 1;
}

/**
 * One two-way sync. Importing a UDT or an FB changes the TIA revision of the DBs and blocks that use it, so a
 * change to both in the same pass would have to wait for the next one (STALE_REVISION): that pass runs right away.
 */
export async function syncOnce(root: string, bridge: SyncBridge, state: StateStore, opts: SyncOptions): Promise<SyncReport> {
  const first = await syncPass(root, bridge, state, opts);
  if (first.imported + first.created === 0 || !first.warnings.some((w) => w.code === "STALE_REVISION")) return first;
  const second = await syncPass(root, bridge, state, opts);
  const key = (x: { address: string; code: string; message?: string }) => `${x.address}\u0000${x.code}\u0000${x.message ?? ""}`;
  const unique = <T extends { address: string; code: string; message?: string }>(list: T[]) => [...new Map(list.map((x) => [key(x), x])).values()];
  return {
    exported: first.exported + second.exported,
    imported: first.imported + second.imported,
    created: first.created + second.created,
    merged: first.merged + second.merged,
    unchanged: second.unchanged,
    conflicts: second.conflicts,
    removed: first.removed + second.removed,
    pendingDeletes: second.pendingDeletes,
    warnings: unique([...first.warnings.filter((w) => w.code !== "STALE_REVISION"), ...second.warnings]),
    diagnostics: unique([...first.diagnostics, ...second.diagnostics]),
  };
}

async function syncPass(root: string, bridge: SyncBridge, state: StateStore, opts: SyncOptions): Promise<SyncReport> {
  const now = opts.now ?? Date.now;
  const cfg = opts.config;
  const report: SyncReport = { exported: 0, imported: 0, created: 0, merged: 0, unchanged: 0, conflicts: 0, removed: 0, pendingDeletes: 0, warnings: [], diagnostics: [] };
  const warn = (address: string, code: string, message?: string) => report.warnings.push(message ? { address, code, message } : { address, code });
  const diag = (d: Diagnostic) => report.diagnostics.push(d);

  const inv = await takeInventory(root, bridge, state, cfg, (w) => report.warnings.push(w));
  await sweepStaging(root, Date.now()); // file times are real time, whatever clock the pass runs on
  const items = new Map(inv.items.map((i) => [i.entry.address, i]));
  const scan = await scanWorkspace(root);
  for (const f of scan.ignored) warn(f.path, "IGNORED_FILE", f.reason);
  // one file per object: the one rung mirrors; a second one (X.awl next to X.scl, X.scl next to
  // X.protected.yaml) is never read, and two new files for one object create nothing
  const local = new Map<string, LocalFile>();
  for (const [address, list] of scan.files) {
    const st = state.get(address);
    const primary = st ? list.find((f) => f.path === st.path) : list.length === 1 ? list[0] : undefined;
    for (const f of list)
      if (f !== primary) warn(f.path, "IGNORED_FILE", st ? `a second file for ${parseAddress(address).name}; rung mirrors it as ${st.path}` : `${list.map((x) => x.path).join(" and ")} are the same object; keep one`);
    if (primary) local.set(address, primary);
  }
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
    state.upsert({ ...st, status: "conflicted", conflict: { tiaFingerprint: staged.result.fingerprint, tiaFiles: staged.files }, sending: undefined });
    report.conflicts++;
    diag({ address: st.address, path: st.path, severity: "error", code: "CONFLICT", message: "Edited in the workspace and in TIA Portal; resolve with rung resolve" });
  };

  const queue: ImportJob[] = [];
  let done = 0;
  for (const address of addresses) {
    try {
      if (inv.blocked.has(address) || inv.skipped.has(address)) continue;
      const item = items.get(address);
      let st = state.get(address);
      const loc = local.get(address);
      if (item && !item.stem) continue; // path collision, already warned

      if (st?.status === "importing") {
        // a create interrupted (Ctrl+C, a crash) before rung recorded how it ended
        const untouched = (await localStatus(root, st.files)) === "clean";
        const files = st.files;
        state.remove(address);
        st = undefined;
        if (item && untouched) {
          // TIA Portal has it: finish what the import would have done (TIA's form of the file)
          await publish(address, files, await stageExport(root, bridge, address, item.stem!), isReadOnlyEntry(item.entry));
          report.created++;
          continue;
        }
        if (item && loc && cfg.sync.import === "auto") {
          // TIA Portal has it and the file was edited since: the file is newer
          const { bundle, captured } = await localBundle(root, loc.stem, loc.path);
          const name = parseAddress(address).name;
          const texts = Object.values(bundle);
          queue.push({ address, name, form: loc.form, stem: item.stem!, bundle, expected: item.entry.fingerprint, captured, kind: "update", rank: rankOf(loc.form, texts), deps: referencedNames(texts, name) });
          continue;
        }
        // not in TIA Portal: the file is simply new again
      }

      if (st?.status === "conflicted") {
        warn(address, "CONFLICT", "unresolved conflict; run rung resolve");
        report.conflicts++;
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
        let cur = state.get(address)!;
        if (cur.readOnly !== readOnly) {
          // e.g. tied to a library type in TIA Portal since the last pass
          cur = { ...cur, readOnly };
          state.upsert(cur);
        }

        if (status === "clean") {
          if (tiaChanged) {
            await publish(address, cur.files, staged!, readOnly);
            report.exported++;
          } else {
            // a restored file ends a pending delete or a refused edit
            if (cur.status === "pendingDelete" || cur.status === "fileDirty" || cur.sending) state.upsert({ ...cur, status: "synced", sending: undefined });
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
          diag({ address, path: cur.path, severity: "error", code: "READ_ONLY_EDIT", message: `Read-only in rung: ${readOnlyReason(item.entry)}. The edit is not sent to TIA Portal; restore the file` });
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
        let m = mergeBundle(cur.form, base, bundle, tia);
        if (m.kind === "conflict" && cur.sending) {
          // the last pass stopped during an import (Ctrl+C, a crash). If TIA Portal already has what it sent,
          // that is the base the file was edited from since; if not, the conflict is real.
          const sent = await baseBundle(root, stemOf(cur), cur.sending);
          const probe = mergeBundle(cur.form, base, sent, tia);
          if (probe.kind !== "conflict" && sameTexts(probe.files, tia)) m = mergeBundle(cur.form, sent, bundle, tia);
        }
        if (m.kind === "conflict") {
          await writeConflict(cur, stem, m.files, staged!, SOURCE_FORMS.has(cur.form));
          continue;
        }
        const mergedTexts = Object.values(m.files);
        if (sameTexts(m.files, tia)) {
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
          warn(address, "LOCAL_CHANGES", "deleted in TIA but edited locally; file kept (rung resolve --ours recreates it in TIA, --theirs accepts the delete)");
          state.upsert({ ...st, status: "conflicted", conflict: { tiaFingerprint: "absent", tiaFiles: st.files, deletedInTia: true } });
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
        // rung would create it in TIA Portal and then have no file to mirror it into
        const stem = addressToStem(parseAddress(address));
        if (preflight(root, [{ address, stem }]).tooLong.length) {
          warn(loc.path, "PATH_TOO_LONG", `not created in TIA Portal: rung's files for it need more than ${MAX_ABSOLUTE_PATH} characters (with ${join(root, stem)}); use shorter folder or block names`);
          continue;
        }
        const { bundle, captured } = await localBundle(root, loc.stem, loc.path);
        const name = parseAddress(address).name;
        const texts = Object.values(bundle);
        // a file being written (an editor's new file, a quick fix's DB before it is saved) creates nothing yet
        if (!(bundle["." + loc.form] ?? "").trim()) continue;
        queue.push({ address, name, form: loc.form, stem, bundle, expected: "absent", captured, kind: "create", rank: rankOf(loc.form, texts), deps: referencedNames(texts, name) });
      }
    } catch (e) {
      if (e instanceof BridgeError && FATAL_BRIDGE_CODES.has(e.code)) {
        await checkpoint();
        throw e;
      }
      if (e instanceof BridgeError || e instanceof WorkspaceError) warn(address, e.code, e.message);
      else if (isLockError(e)) warn(address, "FILE_LOCKED", `${(e as NodeJS.ErrnoException).path ?? "a file"} is locked or not readable (${(e as NodeJS.ErrnoException).code}); retrying on the next pass`);
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
    // a file saved in another encoding (e.g. Windows-1252) would lose its umlauts on the way to TIA
    if (Object.values(job.bundle).some((t) => t.includes("�"))) {
      const bad = [];
      for (const c of job.captured) if (!isUtf8(await readFile(rel2abs(root, c.path)).catch(() => Buffer.alloc(0)))) bad.push(c.path);
      if (bad.length) {
        failed.add(job.address);
        diag({ address: job.address, path: bad[0]!, severity: "error", code: "INVALID_ENCODING", message: `${bad.join(", ")} is not UTF-8 (probably Windows-1252); save it as UTF-8, rung imports nothing until then` });
        continue;
      }
    }
    const stage = await stageForImport(root, job.form, job.bundle);
    if (st) {
      // what is sent, kept until the import's outcome is recorded (see ObjectState.sending)
      const blobs = new BlobStore(root);
      const sending: StateFile[] = [];
      for (const [suffix, text] of Object.entries(job.bundle)) sending.push({ path: job.stem + suffix, role: suffix === "." + job.form ? "primary" : "companion" + suffix, hash: await blobs.put(text) });
      state.upsert({ ...st, sending });
      await state.flush();
    }
    if (job.kind === "create" && !st) {
      // written down before TIA Portal creates it: an interrupted pass then knows the object came from this file
      state.upsert({ address: job.address, path: primaryPath, form: job.form, fileHash: bundleHash(job.captured), files: job.captured, tiaFingerprint: "absent", baseId: "", readOnly: false, warnings: [], status: "importing" });
      await state.flush();
    }
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
      else state.remove(job.address); // refused: still just a new file
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
        const raw = await bridge.compile(device, cfg.sync.compile === "all" ? [] : await withUsers(root, state, addrs));
        const msgs = await placeCompileMessages(root, (a) => state.get(a)?.path, raw, (f) => readFile(f, "utf8"));
        for (const m of msgs) {
          // "No block was compiled. All blocks are up-to-date." says nothing about any file
          if (m.severity === "info" && /^No block was compiled/i.test(m.description)) continue;
          const target = m.address ?? "";
          const path = (target && state.get(target)?.path) || "";
          const revision = target ? state.get(target)?.tiaFingerprint : undefined;
          diag({ address: target, path, severity: m.severity, code: "COMPILE", message: m.description, ...(m.line ? { line: m.line } : {}), ...(m.column ? { column: m.column } : {}), ...(revision ? { revision } : {}) });
        }
      } catch (e) {
        if (!(e instanceof BridgeError)) throw e;
        warn(`plc:${device}`, "COMPILE_FAILED", e.message);
      }
    }
  }

  const compiledAll = imported.length > 0 && cfg.sync.compile === "all";
  const compiled = new Set(imported);
  await writeDiagnostics(root, report.diagnostics, (d) => {
    if (compiledAll || !d.address || compiled.has(d.address)) return false;
    const now = state.get(d.address);
    return !!now && (!d.revision || now.tiaFingerprint === d.revision);
  });
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
  if (!st || st.status !== "pendingDelete") throw new WorkspaceError("NOTHING_PENDING", `${address} has no pending delete (rung status lists them)`);
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
  if (!st || st.status !== "conflicted") throw new WorkspaceError("NOTHING_PENDING", `${path} is not in conflict (rung status lists conflicts)`);
  const tiaFiles = st.conflict?.tiaFiles ?? st.files;
  const tiaFingerprint = st.conflict?.tiaFingerprint ?? st.tiaFingerprint;
  const recoveryDir = join(root, ".rung", "recovery", "resolve-" + randomUUID());
  if (st.conflict?.deletedInTia) {
    // the object no longer exists in TIA Portal
    if (mode === "theirs") {
      // accept the delete: the edited files go to recovery, nothing is lost
      for (const f of st.files) {
        const from = rel2abs(root, f.path);
        if (!existsSync(from)) continue;
        await mkdir(join(recoveryDir, dirname(f.path)), { recursive: true });
        await rename(from, join(recoveryDir, f.path));
      }
    }
    // ours / merged: forget the old object; the next pass sees a new file and creates it in TIA
    state.remove(st.address);
    await state.flush();
    return;
  }
  if (mode === "theirs") {
    const blobs = new BlobStore(root);
    for (const f of tiaFiles)
      await replaceGuarded(rel2abs(root, f.path), await blobs.get(f.hash), { expectedHash: await diskHash(root, f.path), recoveryDir, force: true });
    state.upsert({ ...st, files: tiaFiles, fileHash: bundleHash(tiaFiles), path: tiaFiles.find((f) => f.role === "primary")?.path ?? st.path, tiaFingerprint, status: "synced", conflict: undefined });
  } else {
    const markers = /^<<<<<<< file$/m;
    for (const f of tiaFiles) {
      const primary = await readFile(rel2abs(root, f.path), "utf8").catch(() => "");
      const merged = await readFile(rel2abs(root, f.path + ".conflict"), "utf8").catch(() => null);
      if (mode === "merged" && merged !== null && !markers.test(merged)) {
        // the user merged inside the .conflict file; it becomes the file (the old one is kept for recovery)
        await replaceGuarded(rel2abs(root, f.path), Buffer.from(merged, "utf8"), { expectedHash: await diskHash(root, f.path), recoveryDir, force: true });
      } else if (markers.test(primary)) {
        throw new WorkspaceError("CONFLICT_MARKERS", `${f.path} still contains conflict markers${merged !== null ? ` (so does ${f.path}.conflict)` : ""}`);
      } else if (mode === "merged" && merged !== null && markers.test(merged) && primary === "") {
        throw new WorkspaceError("CONFLICT_MARKERS", `${f.path}.conflict still contains conflict markers`);
      }
    }
    // Base = the TIA version the conflict saw: the next pass sees "file modified, TIA unchanged" and imports.
    state.upsert({ ...st, files: tiaFiles, fileHash: bundleHash(tiaFiles), tiaFingerprint, status: "fileDirty", conflict: undefined });
  }
  // the helper files go to .rung/recovery instead of being deleted: nothing a person typed is lost
  for (const f of tiaFiles)
    for (const suffix of CONFLICT_SUFFIXES) {
      const from = rel2abs(root, f.path + suffix);
      if (!existsSync(from)) continue;
      await mkdir(join(recoveryDir, dirname(f.path)), { recursive: true });
      await rename(from, join(recoveryDir, f.path + suffix)).catch(() => unlink(from).catch(() => {}));
    }
  await state.flush();
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
function isUtf8(bytes: Uint8Array): boolean {
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}
