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
  normalizeText,
  escapeSegment,
  formatAddress,
  ignoredSourceReason,
  parseAddress,
  pathKey,
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
import { BridgeError, type BridgeClient, type CompileMessage } from "@rung/bridge-client";
import { preparePass, takeInventory, type Inventory, type Warning } from "./inventory.js";
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
import { dryState, type Plan, type PlanEntry } from "./plan.js";

export type SyncBridge = BridgeLike & Pick<BridgeClient, "importObject" | "compile"> & Partial<Pick<BridgeClient, "receipts" | "archive">>;

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
  /** A quick pass (syncQuick): the objects it looked at; its warnings and diagnostics are about those alone. */
  objects?: string[];
  /** Files moved in this pass; JSON carries every file, terminals show a bounded sample. */
  changes?: { path: string; action: "export" | "import" | "create" | "merge" | "remove" | "restore" }[];
  /** A preview (SyncOptions.preview): what the pass would have done. */
  plan?: Plan;
  /** The archive TIA Portal wrote before this pass's first write of the day (sync.backup = "daily"). */
  backup?: { path: string; bytes: number };
}

const backupsFile = (root: string) => join(root, ".rung", "backups.json");

/** The day's first write is due an archive: none yet today, or the last one was of another project. */
async function backupDue(root: string, cfg: RungConfig, now: number): Promise<boolean> {
  try {
    const last = JSON.parse(await readFile(backupsFile(root), "utf8")) as { at?: number; project?: string };
    return last.project !== cfg.project.path || typeof last.at !== "number" || new Date(last.at).toDateString() !== new Date(now).toDateString();
  } catch {
    return true;
  }
}

export async function recordBackup(root: string, cfg: RungConfig, path: string, now: number): Promise<void> {
  await writeFileAtomic(backupsFile(root), JSON.stringify({ at: now, project: cfg.project.path, path }, null, 2) + "\n");
}

export interface SyncOptions {
  config: RungConfig;
  now?: () => number;
  onProgress?: (done: number, total: number) => void;
  /**
   * Imports TIA Portal refused, kept across passes by rung watch: the same content is not sent again while
   * neither the file nor anything in TIA Portal changed (it would be refused again, every poll). A one-shot
   * rung sync passes none and always tries.
   */
  refused?: Map<string, Refusal>;
  /**
   * How long an object TIA Portal gives no revision for (watch and force tables, which it exports each time to
   * compare) counts as checked: rung watch sets it so it does not export every table on every poll. Imports compare
   * the real content first, so a TIA edit seen later is merged, never overwritten. A one-shot rung sync checks always.
   */
  unversionedMs?: number;
  /**
   * rung sync --preview: the pass decides as it always does, on a copy of the state, and writes nothing: no import, no
   * file, no state on disk, no diagnostics. It plans as if writes were on; the report's plan says what it would do.
   */
  preview?: boolean;
  /** What the pass is doing now, for editors to show: sending a file to TIA Portal, compiling, archiving. */
  /** Tag-table checks supplied by the caller, avoiding a sync → lsp dependency cycle. */
  validateTags?: (path: string, text: string) => { code: string; message: string; line: number }[];
  onPhase?: (phase: "sending" | "compiling" | "archiving", detail: string) => void;
}

export interface Refusal {
  /** What was sent and what TIA Portal held besides the object (see refusalKey). */
  key: string;
  code: string;
  message: string;
}

/** Bridge answers to an import that the same content gets again from the same project. */
const REFUSALS = new Set(["IMPORT_FAILED", "UNSUPPORTED_OBJECT", "BAD_REQUEST", "READ_ONLY", "NAME_TAKEN"]);

interface ImportJob {
  address: string;
  name: string;
  form: string;
  stem: string;
  bundle: Record<string, string>;
  /** For a merge: the workspace files the merged bundle was made from. */
  local?: Record<string, string>;
  /** For a merge: TIA Portal's version it was merged with. */
  tia?: Record<string, string>;
  /** TIA revision the bundle was based on, or "absent" for a new object. */
  expected: string;
  /** Raw disk hashes of the files as read, used to guard the canonical rewrite. */
  captured: StateFile[];
  kind: "update" | "create" | "merge";
  rank: number;
  deps: string[];
}

const stemOf = (s: Pick<ObjectState, "path" | "form">) => s.path.slice(0, -(s.form.length + 1));
/** TIA Portal's names ignore letter case on every platform, whatever the filesystem under the workspace does. */
const nameKey = (p: string) => p.normalize("NFC").toLowerCase();

/** Why a file edit stays in the workspace: writes not turned on for this copy, or sync.import = "manual". */
const notSent = (cfg: RungConfig, what: string): [string, string] =>
  cfg.writesOff ? ["WRITES_OFF", `${what} not sent to TIA Portal: writes are off in this workspace (rung writes on)`] : ["IMPORT_MANUAL", `${what} not sent to TIA (sync.import = manual)`];
/** The sends whose outcome was never recorded, newest first (a state written before operation ids: files only). */
function sendsOf(st: ObjectState): { files: StateFile[]; op?: string }[] {
  const older = (st.sent ?? []).map((s) => (Array.isArray(s) ? { files: s as StateFile[] } : s));
  return [...(st.sending ? [{ files: st.sending, ...(st.sendingOp ? { op: st.sendingOp } : {}) }] : []), ...older];
}
const sameTexts = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
/** The same texts but for spaces and line breaks outside '…' and "…": TIA Portal's own layout of what was sent. */
const sameLayoutFree = (a: Record<string, string>, b: Record<string, string>) => {
  const squeeze = (x: Record<string, string>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, withoutLayout(v)]));
  return sameTexts(squeeze(a), squeeze(b));
};
export function withoutLayout(text: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === "$" && quote === "'") out += text[++i] ?? ""; // $' and $$ inside a string
      else if (c === quote) quote = undefined; // '' and "" inside a literal close and reopen: the same text either way
    } else if (c === "/" && text[i + 1] === "/") {
      // a line comment ends at its line break, which stays: "// note\n#x := 1;" is not "// note #x := 1;"
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out += text.slice(i, stop).replace(/\s+/g, "") + "\n";
      i = stop;
    } else if ((c === "(" || c === "/") && text[i + 1] === "*") {
      // a block comment as one piece: a quote in it opens no string
      const close = c === "(" ? "*)" : "*/";
      const end = text.indexOf(close, i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/\s+/g, "");
      i = stop - 1;
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (!/\s/.test(c)) out += c;
  }
  return out;
}
const CREATABLE = new Set(["scl", "awl", "db", "udt", "xml", "s7dcl", "tags.xml", "tags.st", "st"]);
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


/**
 * Local companion files of a stem (e.g. .s7res next to .s7dcl) plus the primary. On Windows and macOS a file
 * renamed only by letter case (fx_a.scl for Fx_A.scl) is the same file, so it still belongs to the stem.
 */
async function localBundle(root: string, stem: string, primaryPath: string): Promise<{ bundle: Record<string, string>; captured: StateFile[] }> {
  const dir = rel2abs(root, stem.split("/").slice(0, -1).join("/"));
  const leaf = stem.split("/").pop()!;
  const bundle: Record<string, string> = {};
  const captured: StateFile[] = [];
  for (const name of await readdir(dir)) {
    if (!pathKey(name).startsWith(pathKey(leaf + ".")) || CONFLICT_SUFFIXES.some((s) => name.endsWith(s))) continue;
    // the suffix is plain ASCII: as long in the name as in its folded form; the primary keeps its own (.scl for .SCL)
    const found = name.slice(name.length - (pathKey(name).length - pathKey(leaf).length));
    const primary = pathKey(stem + found) === pathKey(primaryPath);
    const suffix = primary ? primaryPath.slice(stem.length) : found;
    const rel = stem + suffix;
    const bytes = await readFile(join(dir, name));
    bundle[suffix] = bytes.toString("utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
    captured.push({ path: rel, role: primary ? "primary" : "companion" + suffix, hash: sha256(bytes) });
  }
  return { bundle, captured };
}

/**
 * What other blocks see of a source: its header and declarations, for the forms where rung can tell them apart from
 * the body. undefined where it cannot (data types, tag tables, LAD as SD, network settings): their users always compile.
 */
function interfaceOf(form: string, text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const squeeze = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
  if (form === "scl" || form === "awl" || form === "db") {
    const begin = /^[ \t]*BEGIN[ \t]*$/im.exec(text);
    return begin ? squeeze(text.slice(0, begin.index)) : undefined;
  }
  if (form === "xml") {
    const m = /<Interface>[\s\S]*?<\/Interface>/.exec(text);
    return m ? squeeze(m[0]) : undefined;
  }
  return undefined;
}

/** Quoted identifiers a source refers to (its own name excluded). */
function referencedNames(texts: string[], self: string): string[] {
  const names = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/"([^"\r\n]+)"/g)) if (m[1] !== self) names.add(m[1]!);
  return [...names];
}

function rankOf(form: string, texts: string[]): number {
  if (form === "udt" || form === "tags.xml" || form === "tags.st") return 0;
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

async function writeDiagnostics(root: string, items: Diagnostic[], keep: (d: Diagnostic) => boolean = () => false, untouched: (d: Diagnostic) => boolean = () => false): Promise<number> {
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
  // a quick pass leaves what it did not look at (a conflict elsewhere, a pending delete) as the last pass found it
  const kept = previous.filter((d) => !/^\s*Compiling finished\b/i.test(d.message) && (untouched(d) || (d.code === "COMPILE" && keep(d))));
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
  if (opts.preview) return syncPass(root, bridge, dryState(state), opts);
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
    changes: [...(first.changes ?? []), ...(second.changes ?? [])],
    ...((first.backup ?? second.backup) ? { backup: first.backup ?? second.backup } : {}),
  };
}

const emptyReport = (): SyncReport => ({ exported: 0, imported: 0, created: 0, merged: 0, unchanged: 0, conflicts: 0, removed: 0, pendingDeletes: 0, warnings: [], diagnostics: [], changes: [] });

/**
 * A pass for files rung watch saw change: only their objects are imported, compiled and written back, without
 * listing the project. Each import names the revision TIA Portal had at the last complete pass and TIA Portal refuses
 * it if the object changed since, so nothing of TIA's is overwritten. Anything else (a new, deleted or renamed file,
 * a conflict, an interrupted send, an object marked stale or read-only) needs a complete pass: then this returns null,
 * having changed nothing, or, when TIA Portal refused an import as stale, having marked that object for the merge.
 */
export async function syncQuick(root: string, bridge: SyncBridge, state: StateStore, opts: SyncOptions, paths: readonly string[]): Promise<SyncReport | null> {
  const picked = new Map<string, LocalFile>();
  for (const path of new Set(paths)) {
    const st = state.all().find((s) => s.files.some((f) => f.path === path));
    if (!st) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (name.startsWith(".") || CONFLICT_SUFFIXES.some((s) => name.endsWith(s)) || !pathToAddress(path)) continue; // not a file rung mirrors
      return null; // a new or renamed source
    }
    if (picked.has(st.address)) continue;
    const status = await localStatus(root, st.files);
    if (status === "clean") continue; // rung's own write-back, or saved unchanged
    const plain = (st.status === "synced" || st.status === "fileDirty") && !st.readOnly && !st.sending && !st.sent;
    if (status === "missing" || !plain || !st.tiaFingerprint || st.tiaFingerprint === "none" || st.tiaFingerprint.startsWith("stale:")) return null;
    picked.set(st.address, { path: st.path, form: st.form, stem: stemOf(st) });
  }
  if (!picked.size) return { ...emptyReport(), objects: [] };
  const r = await syncPass(root, bridge, state, opts, picked);
  return r.warnings.some((w) => w.code === "STALE_REVISION") ? null : { ...r, objects: [...picked.keys()] };
}

/** The objects of a quick pass as the last complete pass left them; TIA Portal's real revision is checked by the import. */
async function quickInventory(root: string, bridge: SyncBridge, state: StateStore, cfg: RungConfig, picked: Map<string, LocalFile>, warn: (w: Warning) => void): Promise<Inventory> {
  const { info, devices, blocked } = await preparePass(root, bridge, state, cfg, warn);
  const items: Inventory["items"] = [];
  for (const address of picked.keys()) {
    const st = state.get(address);
    if (!st) continue; // finished or dropped by the journal recovery just now
    const parsed = parseAddress(address);
    items.push({ entry: { address, kind: parsed.kind, knowHowProtected: false, isFailsafe: false, isSystem: false, fingerprint: st.tiaFingerprint }, address: parsed, stem: stemOf(st) });
  }
  return { info, devices, items, blocked, skipped: new Set(), collisions: [], tooLong: [] };
}

async function syncPass(root: string, bridge: SyncBridge, state: StateStore, opts: SyncOptions, quick?: Map<string, LocalFile>): Promise<SyncReport> {
  const now = opts.now ?? Date.now;
  // a preview shows what the pass would send once writes are on, whatever they are now
  const cfg = opts.preview && opts.config.sync.import !== "auto" ? { ...opts.config, sync: { ...opts.config.sync, import: "auto" as const }, writesOff: undefined } : opts.config;
  const report = emptyReport();
  const warn = (address: string, code: string, message?: string, path = state.get(address)?.path) => report.warnings.push({ address, code, ...(message ? { message } : {}), ...(path ? { path } : {}) });
  const diag = (d: Diagnostic) => {
    report.diagnostics.push(d);
    const st = state.get(d.address);
    if (st && d.severity === "error" && d.code !== "COMPILE" && st.status === "fileDirty") state.upsert({ ...st, notSent: { code: d.code, message: d.message } });
  };
  const plan: Plan | undefined = opts.preview ? { entries: [], compile: [] } : undefined;
  const planned = (e: PlanEntry) => plan!.entries.push(e);

  const inv = quick ? await quickInventory(root, bridge, state, cfg, quick, (w) => report.warnings.push(w)) : await takeInventory(root, bridge, state, cfg, (w) => report.warnings.push(w), !!plan);
  if (!plan) await sweepStaging(root, Date.now()); // file times are real time, whatever clock the pass runs on
  const items = new Map(inv.items.map((i) => [i.entry.address, i]));
  const scan = quick ? { files: new Map([...quick].filter(([a]) => items.has(a)).map(([a, f]) => [a, [f]])), ignored: [] } : await scanWorkspace(root);
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
  // files of a PLC this workspace does not sync are not read: say so once per folder (a typo, a block from elsewhere)
  for (const device of new Set([...local.keys()].filter((a) => !bound(a)).map((a) => parseAddress(a).device)))
    warn(
      `plc/${escapeSegment(device)}`,
      "IGNORED_FILE",
      inv.info.devices.includes(device)
        ? `${device} is not among the devices in rung.toml; the files under it are not synced`
        : `the project has no PLC ${device} (its PLCs: ${inv.info.devices.join(", ")}); the files under it are not synced`,
    );
  // a quick pass looks at its own objects only: every other one would look deleted in TIA Portal
  const addresses = quick ? [...items.keys()] : [...new Set([...items.keys(), ...state.all().map((s) => s.address).filter(bound), ...[...local.keys()].filter(bound)])].sort();

  // An object renamed in TIA Portal only by letter case is the same object (and, on Windows and macOS, the same
  // file): the new address takes over the old one's state (as in pull), instead of a conflict with its own file
  // and a delete. Its files then follow the new name.
  const orphans = new Map<string, ObjectState>();
  if (!quick) for (const s of state.all()) if (!items.has(s.address) && bound(s.address) && !inv.skipped.has(s.address) && !inv.blocked.has(s.address)) orphans.set(nameKey(stemOf(s)), s);
  const adopted = new Set<string>();
  const adoptedFrom = new Set<string>();
  for (const i of inv.items) {
    const o = i.stem && !state.get(i.entry.address) ? orphans.get(nameKey(i.stem)) : undefined;
    if (!o || adoptedFrom.has(o.address) || o.status === "importing") continue;
    state.remove(o.address);
    state.upsert({ ...o, address: i.entry.address });
    adopted.add(i.entry.address);
    adoptedFrom.add(o.address);
  }
  /** A mirrored object TIA Portal takes this file for, its name differing only in letter case (Fx_A for fx_a.scl). */
  const caseTwin = (address: string, file: LocalFile): { name: string; path: string } | undefined => {
    const s = state.all().find((x) => x.address !== address && nameKey(x.path) === nameKey(file.path));
    if (s) return { name: parseAddress(s.address).name, path: s.path };
    const i = inv.items.find((x) => x.entry.address !== address && x.stem && nameKey(x.stem) === nameKey(file.stem));
    return i ? { name: i.address.name, path: `${i.stem}.${file.form}` } : undefined;
  };

  const journal = new Journal(root);
  const pendingOps: string[] = [];
  const checkpoint = async () => {
    await state.flush();
    for (const op of pendingOps.splice(0)) await journal.done(op);
  };
  const publish = async (address: string, prevFiles: readonly StateFile[], staged: StagedExport, readOnly: boolean, force = false) => {
    if (plan) {
      const path = staged.primary.path;
      const before = await readFile(rel2abs(root, path), "utf8").catch(() => undefined);
      planned({ address, path, action: force ? "restore" : "export", ...(before !== undefined ? { before } : {}), after: staged.texts.get("." + staged.result.form) ?? "" });
      return undefined;
    }
    const pub = await planPublication(root, prevFiles, staged.files);
    if (pub.localEdit && !force) throw new WorkspaceError("LOCAL_CHANGES", `${staged.primary.path} changed locally; not overwritten`);
    const next = await buildState(root, address, staged, readOnly, now());
    if (pub.targets.length || pub.removes.length) {
      const opId = randomUUID();
      await publishBundle(root, { opId, address, targets: pub.targets, removes: pub.removes, nextState: next }, { keepJournal: true, force });
      pendingOps.push(opId);
    }
    state.upsert(next);
    report.changes!.push({ path: staged.primary.path, action: force ? "restore" : "export" });
    return next;
  };
  const writeConflict = async (st: ObjectState, stem: string, files: Record<string, string>, staged: StagedExport, source: boolean) => {
    if (plan) {
      planned({ address: st.address, path: st.path, action: "conflict", detail: `changed here and in TIA Portal on the same lines; run rung resolve ${st.path} --ours|--theirs|--merged after sync writes the conflict helpers` });
      report.conflicts++;
      return;
    }
    const local: Record<string, string> = {};
    if (source) {
      for (const [suffix, text] of Object.entries(files))
        if (text.includes("<<<<<<< file")) {
          await writeFileAtomic(rel2abs(root, stem + suffix + ".conflict"), text);
          const h = await diskHash(root, stem + suffix);
          if (h !== "absent") local[stem + suffix] = h;
        }
    } else {
      for (const [suffix, text] of staged.texts) await writeFileAtomic(rel2abs(root, stem + suffix + ".tia"), text);
    }
    state.upsert({
      ...st,
      status: "conflicted",
      conflict: { tiaFingerprint: staged.result.fingerprint, tiaFiles: staged.files, ...(staged.result.form !== st.form ? { tiaForm: staged.result.form } : {}), ...(Object.keys(local).length ? { local } : {}) },
      sending: undefined,
      sendingOp: undefined,
      sent: undefined,
    });
    report.conflicts++;
    diag({ address: st.address, path: st.path, severity: "error", code: "CONFLICT", message: `Edited here and in TIA Portal; ${source ? `markers in ${st.path}.conflict` : `TIA version in ${st.path}.tia`}; run rung resolve ${st.path} --ours|--theirs|--merged` });
  };

  /**
   * The sends of the last passes whose answer never came (Ctrl+C, a crash, a bridge that stopped) that TIA Portal may
   * hold now. With the bridge's receipts only the newest one it committed can be it: an older one that matches is
   * someone's change back to it, not rung's send.
   */
  const sendCandidates = async (cur: ObjectState) => {
    const sends = sendsOf(cur);
    if (sends.length && bridge.receipts && sends.every((s) => s.op)) {
      const landed = await bridge.receipts(sends.map((s) => s.op!));
      if (landed) {
        const newest = sends.find((s) => landed.includes(s.op!));
        return newest ? [newest] : [];
      }
    }
    return sends;
  };

  const queue: ImportJob[] = [];
  let done = 0;
  for (const address of addresses) {
    try {
      if (inv.blocked.has(address) || inv.skipped.has(address) || adoptedFrom.has(address)) continue;
      const item = items.get(address);
      let st = state.get(address);
      const loc = local.get(address);
      if (item && !item.stem) continue; // path collision, already warned

      if (st?.status === "recoveryRequired" && st.sendingOp && bridge.receipts && (await bridge.receipts([st.sendingOp])) !== undefined) {
        // the bridge (or TIA Portal) stopped during an import while rung waited for the answer: with its receipts this
        // pass tells whether TIA Portal took what was sent, as after an interrupted send; what rung resolve would do
        st = st.tiaFingerprint === "absent" ? { ...st, status: "importing" } : { ...st, status: "fileDirty", tiaFingerprint: st.tiaFingerprint.startsWith("stale:") ? st.tiaFingerprint : `stale:${st.tiaFingerprint}` };
        state.upsert(st);
      }

      if (st?.status === "importing") {
        // a create interrupted (Ctrl+C, a crash) before rung recorded how it ended
        const untouched = (await localStatus(root, st.files)) === "clean";
        const files = st.files;
        const sending = st.sending;
        // with the bridge's receipts: an object there that this create did not make is someone else's, new on both
        // sides (taken when the same, else a conflict keeping both), never published over the file
        const landed = item && st.sendingOp && bridge.receipts ? await bridge.receipts([st.sendingOp]) : undefined;
        const someoneElses = landed !== undefined && !landed.includes(st.sendingOp!);
        state.remove(address);
        st = undefined;
        if (item && untouched && !someoneElses) {
          // TIA Portal has it: finish what the import would have done (TIA's form of the file)
          await publish(address, files, await stageExport(root, bridge, address, item.stem!), isReadOnlyEntry(item.entry));
          report.created++;
          continue;
        }
        if (item && loc && cfg.sync.import === "auto" && !someoneElses) {
          // TIA Portal has it and the file was edited since. What the create sent is the base: if TIA Portal's
          // version is that (in its own layout), the file is simply newer; if someone changed it in TIA Portal
          // meanwhile, the two are merged, or a conflict where both changed the same lines
          const { bundle, captured } = await localBundle(root, loc.stem, loc.path);
          const name = parseAddress(address).name;
          const texts = Object.values(bundle);
          const job = { address, name, form: loc.form, stem: item.stem!, captured, rank: rankOf(loc.form, texts), deps: referencedNames(texts, name) };
          const sent = sending?.length ? await baseBundle(root, loc.stem, sending) : undefined;
          const staged = sent ? await stageExport(root, bridge, address, item.stem!) : undefined;
          const tia = staged ? Object.fromEntries(staged.texts) : undefined;
          const tiaIsBase = !sent || !staged || !tia || staged.result.form !== loc.form || sameLayoutFree(sent, tia);
          // from here on the object is an ordinary one with a file edit: what the create sent is its base, so a
          // send TIA Portal refuses (it changed meanwhile) leaves it for the next pass to merge. One snapshot:
          // the base's files and hash, and TIA Portal's fingerprint only where TIA Portal holds that base; where
          // it was changed since, no fingerprint, so the next pass exports it and merges again
          const base = sending?.length ? sending : files;
          const cur: ObjectState = { address, path: loc.path, form: loc.form, fileHash: bundleHash(base), files: base, tiaFingerprint: tiaIsBase ? (staged?.result.fingerprint ?? item.entry.fingerprint) : "", baseId: "", readOnly: isReadOnlyEntry(item.entry), warnings: [], status: "fileDirty" };
          state.upsert(cur);
          if (tiaIsBase) {
            queue.push({ ...job, bundle, expected: item.entry.fingerprint, kind: "update" });
            continue;
          }
          const m = mergeBundle(loc.form, sent, bundle, tia);
          if (m.kind === "conflict") await writeConflict(cur, loc.stem, m.files, staged, SOURCE_FORMS.has(loc.form));
          else if (sameTexts(m.files, tia)) {
            await publish(address, captured, staged, cur.readOnly);
            report.created++;
          } else queue.push({ ...job, bundle: m.files, local: bundle, tia, expected: staged.result.fingerprint, kind: "merge" });
          continue;
        }
        // not in TIA Portal: the file is simply new again
      }

      if (st?.status === "conflicted") {
        const hint = `Unresolved conflict; check ${st.path}.conflict or ${st.path}.tia; run rung resolve ${st.path} --ours|--theirs|--merged`;
        warn(address, "CONFLICT", hint, st.path);
        report.conflicts++;
        diag({ address, path: st.path, severity: "error", code: "CONFLICT", message: hint });
        continue;
      }
      if (st?.status === "recoveryRequired") {
        warn(address, "RECOVERY_REQUIRED", `the last import has an unknown outcome; check TIA Portal, then run rung resolve ${st.path} --ours|--theirs|--merged`, st.path);
        continue;
      }

      if (item && st) {
        const stem = item.stem!;
        const readOnly = isReadOnlyEntry(item.entry);
        const status = await localStatus(root, st.files);
        let staged: StagedExport | undefined;
        let tiaChanged = false;
        // an adopted state is written under the new name even when the object did not change
        // a quick pass does not look: the import tells whether TIA Portal still has the revision it names
        if (adopted.has(address) || (!quick && !isFresh(item.entry.fingerprint, st, now(), cfg.sync.weakVerifyMs, opts.unversionedMs))) {
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

        // a file back where it was before a send TIA Portal took without answering (an undo) is the newer edit:
        // handled like an edited file, which asks which send TIA Portal holds before merging
        const undone = status === "clean" && tiaChanged && !adopted.has(address) && sendsOf(cur).length > 0 && !readOnly && cfg.sync.import === "auto";
        if (status === "clean" && !undone) {
          if (tiaChanged || adopted.has(address)) {
            await publish(address, cur.files, staged!, readOnly);
            report.exported++;
          } else {
            // a restored file ends a pending delete or a refused edit
            if (cur.status === "pendingDelete" || cur.status === "fileDirty" || cur.sending || cur.sent) state.upsert({ ...cur, status: "synced", notSent: undefined, sending: undefined, sendingOp: undefined, sent: undefined });
            report.unchanged++;
          }
          continue;
        }
        if (status === "missing") {
          // a PLC's network settings and its default tag table cannot be deleted: the file comes back
          const deletable = parseAddress(address).kind !== "hardware" && !isDefaultTagTable(address);
          if (!deletable) warn(address, "NOT_DELETABLE", isDefaultTagTable(address) ? "TIA Portal keeps a PLC's default tag table; the file was put back" : "a PLC's network settings stay with the PLC; the file was put back");
          if (deletable && !tiaChanged && !readOnly && cfg.sync.delete === "confirm") {
            state.upsert({ ...cur, status: "pendingDelete" });
            report.pendingDeletes++;
            if (plan) planned({ address, path: cur.path, action: "pending-delete", detail: `deleted here: rung confirm-delete ${cur.path} deletes it in TIA Portal, or restore the file` });
            const how = cfg.writesOff ? `with writes on (rung writes on), rung confirm-delete ${cur.path} deletes it in TIA Portal` : `run rung confirm-delete ${cur.path} to delete it in TIA Portal`;
            diag({ address, path: cur.path, severity: "warning", code: "DELETE_PENDING", message: `Deleted in the workspace; ${how}, or restore the file` });
            continue;
          }
          staged ??= await stageExport(root, bridge, address, stem);
          await publish(address, cur.files, staged, readOnly, true);
          report.exported++;
          if (tiaChanged) warn(address, "DELETE_CONFLICT", "deleted locally but changed in TIA; restored the TIA version");
          continue;
        }
        // modified locally
        cur = { ...cur, status: "fileDirty", notSent: undefined };
        state.upsert(cur);
        if (readOnly) {
          state.upsert({ ...cur, status: "fileDirty" });
          diag({ address, path: cur.path, severity: "error", code: "READ_ONLY_EDIT", message: `Read-only in rung: ${readOnlyReason(item.entry)}. The edit is not sent to TIA Portal; rung restore ${cur.path} takes TIA Portal's version back` });
          continue;
        }
        if (cfg.sync.import === "manual") {
          const [code, message] = notSent(cfg, "local edit");
          state.upsert({ ...cur, status: "fileDirty", notSent: { code, message } });
          warn(address, code, message, cur.path);
          continue;
        }
        const { bundle, captured } = await localBundle(root, stemOf(cur), cur.path);
        const name = parseAddress(address).name;
        const texts = Object.values(bundle);
        // an editor half-way through a save, or a sync client, leaves a file empty for a moment; sent, it would
        // empty the object in TIA Portal (an empty tag table there has no tags)
        if (!(bundle["." + cur.form] ?? "").trim()) {
          warn(cur.path, "EMPTY_FILE", `the file is empty; nothing is sent to TIA Portal (delete the file to delete ${name} there)`);
          continue;
        }
        if (!tiaChanged) {
          queue.push({ address, name, form: cur.form, stem, bundle, expected: cur.tiaFingerprint, captured, kind: "update", rank: rankOf(cur.form, texts), deps: referencedNames(texts, name) });
          continue;
        }
        // changed on both sides
        const base = await baseBundle(root, stemOf(cur), cur.files);
        const tia = Object.fromEntries(staged!.texts);
        if (staged!.result.form !== cur.form) {
          // TIA Portal exports it in another form now (a tag table: .tags.xml → .tags.st). When only the form
          // changed, not the object, the edit is sent as it is and TIA's answer brings the new form.
          if (staged!.result.fingerprint === cur.tiaFingerprint) {
            queue.push({ address, name, form: cur.form, stem, bundle, expected: cur.tiaFingerprint, captured, kind: "update", rank: rankOf(cur.form, texts), deps: referencedNames(texts, name) });
            continue;
          }
          await writeConflict(cur, stem, bundle, staged!, false);
          continue;
        }
        // If TIA Portal already has the edits a send it never answered carried (TIA Portal may have changed other
        // lines since), those files are the base the file was edited from since: asked first, as a merge with the
        // older base could take an edit the person has undone since for TIA Portal's change and keep it
        let m: ReturnType<typeof mergeBundle> | undefined;
        for (const { files } of await sendCandidates(cur)) {
          const from = await baseBundle(root, stemOf(cur), files);
          const probe = mergeBundle(cur.form, base, from, tia);
          // in TIA Portal's own layout of it (it ends a source with a blank line the sent file may not have)
          if (probe.kind !== "conflict" && sameLayoutFree(probe.files, tia)) {
            m = mergeBundle(cur.form, from, bundle, tia);
            break;
          }
        }
        m ??= mergeBundle(cur.form, base, bundle, tia);
        if (m.kind === "conflict") {
          await writeConflict(cur, stem, m.files, staged!, SOURCE_FORMS.has(cur.form));
          continue;
        }
        const mergedTexts = Object.values(m.files);
        if (sameTexts(m.files, tia)) {
          await publish(address, captured, staged!, readOnly, false);
          report.exported++;
        } else
          queue.push({ address, name, form: cur.form, stem, bundle: m.files, local: bundle, tia, expected: staged!.result.fingerprint, captured, kind: "merge", rank: rankOf(cur.form, mergedTexts), deps: referencedNames(mergedTexts, name) });
        continue;
      }

      if (item && !st) {
        const stem = item.stem!;
        const readOnly = isReadOnlyEntry(item.entry);
        const staged = await stageExport(root, bridge, address, stem);
        const present = await Promise.all(staged.files.map((f) => diskHash(root, f.path, f.hash)));
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
          warn(address, "LOCAL_CHANGES", `deleted in TIA but edited locally; file kept (rung resolve ${st.path} --ours recreates it in TIA; rung resolve ${st.path} --theirs accepts the delete)`, st.path);
          state.upsert({ ...st, status: "conflicted", conflict: { tiaFingerprint: "absent", tiaFiles: st.files, deletedInTia: true } });
          if (plan) planned({ address, path: st.path, action: "conflict", detail: `deleted in TIA Portal but edited here; file kept until rung resolve ${st.path} --ours|--theirs|--merged` });
          continue;
        }
        if (plan) {
          planned({ address, path: st.path, action: "remove", detail: "deleted in TIA Portal: the file goes too" });
          report.removed++;
          continue;
        }
        const removes = [];
        for (const f of st.files) {
          const h = await diskHash(root, f.path, f.hash);
          if (h !== "absent") removes.push({ path: f.path, prevHash: h });
        }
        if (removes.length) await publishBundle(root, { opId: randomUUID(), address, targets: [], removes, nextState: st });
        state.remove(address);
        report.changes!.push({ path: st.path, action: "remove" });
        report.removed++;
        continue;
      }

      if (loc) {
        if (cfg.sync.import !== "auto") {
          const [code, message] = notSent(cfg, "new file");
          warn(address, code, message, loc.path);
          continue;
        }
        if (!CREATABLE.has(loc.form)) {
          warn(address, "UNSUPPORTED_OBJECT", `cannot create objects from ${loc.form} files`);
          continue;
        }
        // TIA Portal would take it for the object whose file it is: names ignore letter case there too
        const twin = caseTwin(address, loc);
        if (twin) {
          warn(loc.path, "IGNORED_FILE", `${twin.name} is mirrored as ${twin.path}; a name that differs only in letter case is the same object (rename it in TIA Portal: rung rename)`);
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
        // a block renamed by hand (git mv and its header): creating it would leave TIA Portal two blocks, the callers on the old one
        const from = await renamedBy(root, state, name, bundle["." + loc.form] ?? "");
        if (from) {
          const how = `rung restore ${from.path}, remove ${loc.path}, then rung rename ${from.path} ${name}: TIA Portal keeps the block, its number and its callers. For a new block instead, rung confirm-delete ${from.path} first`;
          diag({ address, path: loc.path, severity: "error", code: "LOOKS_LIKE_RENAME", message: `the block of ${from.path} (deleted here) under a new name, not created: ${how}` });
          if (plan) planned({ address, path: loc.path, action: "conflict", detail: `looks like a rename of ${from.path}: ${how}` });
          continue;
        }
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
  /** What TIA Portal's compile during the import said, per object (bridges that tell). */
  const compiledByImport = new Map<string, CompileMessage[]>();
  /** Imported objects whose users must compile too. */
  const withCallers: string[] = [];
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
  // the rest of the PLC as TIA Portal holds it: an import TIA Portal refused may succeed once that changed
  const others = (address: string) => {
    const device = parseAddress(address).device;
    const lines = inv.items.filter((i) => i.address.device === device && i.entry.address !== address).map((i) => `${i.entry.address}\u0000${i.entry.fingerprint}`);
    return sha256(Buffer.from(lines.sort().join("\n"), "utf8"));
  };
  const refusalKey = (job: ImportJob) => sha256(Buffer.from(JSON.stringify(Object.entries(job.bundle).sort()), "utf8")) + ":" + others(job.address);
  // before the first write of the day TIA Portal archives the project: a whole project to go back to. Without it
  // nothing is written; the next pass tries again
  let backupFailed: string | undefined;
  if (!plan && order.length && cfg.sync.backup === "daily" && bridge.archive && (await backupDue(root, cfg, now()))) {
    try {
      opts.onPhase?.("archiving", "the project, before the first write of the day");
      const b = await bridge.archive(cfg.sync.backupDir);
      if (b) {
        await recordBackup(root, cfg, b.path, now());
        report.backup = { path: b.path, bytes: b.bytes };
      }
    } catch (e) {
      if (!(e instanceof BridgeError) || FATAL_BRIDGE_CODES.has(e.code)) throw e;
      backupFailed = e.message;
    }
  }
  for (const job of order) {
    const st = state.get(job.address);
    const primaryPath = job.captured.find((c) => c.role === "primary")?.path ?? job.stem + "." + job.form;
    if (backupFailed) {
      failed.add(job.address);
      diag({ address: job.address, path: primaryPath, severity: "error", code: "BACKUP_FAILED", message: `Not sent: TIA Portal could not archive the project first (${backupFailed}). rung writes nothing without that archive; sync.backup = "off" in rung.toml turns it off` });
      continue;
    }
    const blockedBy = job.deps.map((d) => byName.get(d)).find((d) => d && (failed.has(d.address) || cyclic.has(d.address)));
    if (cyclic.has(job.address) || blockedBy) {
      failed.add(job.address);
      diag({ address: job.address, path: primaryPath, severity: "error", code: "DEPENDENCY_BLOCKED", message: cyclic.has(job.address) ? "Cyclic dependency between changed objects; import them together with rung sync --batch (not automatic)" : `Waiting for ${blockedBy!.address}, which could not be imported` });
      continue;
    }
    if (job.form === "tags.st" && opts.validateTags) {
      const problems = opts.validateTags(primaryPath, job.bundle[".tags.st"] ?? "");
      if (problems.length) {
        failed.add(job.address);
        for (const p of problems) diag({ address: job.address, path: primaryPath, severity: "error", code: p.code, line: p.line, message: `${p.message}. Nothing was changed in TIA Portal` });
        continue;
      }
    }
    const key = opts.refused ? refusalKey(job) : "";
    const earlier = opts.refused?.get(job.address);
    if (earlier && earlier.key === key) {
      failed.add(job.address);
      diag({ address: job.address, path: primaryPath, severity: "error", code: earlier.code, message: earlier.message });
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
    if (plan) {
      // what TIA Portal holds now (the base it last had, or what it was merged with) against what it would get
      const suffix = "." + job.form;
      const before = job.kind === "create" ? "" : job.kind === "merge" ? (job.tia?.[suffix] ?? "") : st ? ((await baseBundle(root, stemOf(st), st.files).catch(() => ({}) as Record<string, string>))[suffix] ?? "") : "";
      planned({ address: job.address, path: primaryPath, action: job.kind, before, after: job.bundle[suffix] ?? "" });
      imported.push(job.address);
      if (job.kind !== "update" || interfaceOf(job.form, before) === undefined || interfaceOf(job.form, before) !== interfaceOf(job.form, job.bundle[suffix])) withCallers.push(job.address);
      continue;
    }
    opts.onPhase?.("sending", primaryPath);
    const stage = await stageForImport(root, job.form, job.bundle);
    // the operation's id: the bridge keeps a receipt when TIA Portal commits it (see sendsOf)
    const opId = randomUUID();
    if (st) {
      // the files this send was made from, kept until the import's outcome is recorded (see ObjectState.sending)
      const blobs = new BlobStore(root);
      const sending: StateFile[] = [];
      for (const [suffix, text] of Object.entries(job.local ?? job.bundle)) sending.push({ path: job.stem + suffix, role: suffix === "." + job.form ? "primary" : "companion" + suffix, hash: await blobs.put(text) });
      // a send whose outcome the last pass never recorded stays known: TIA Portal may have that one
      const sent = sendsOf(st).slice(0, 8);
      state.upsert({ ...st, sending, sendingOp: opId, sent: sent.length ? sent : undefined });
      await state.flush();
    }
    if (job.kind === "create" && !st) {
      // written down before TIA Portal creates it: an interrupted pass then knows the object came from this file,
      // and with what was sent, what someone may have changed in TIA Portal since
      const blobs = new BlobStore(root);
      const sending: StateFile[] = [];
      for (const [suffix, text] of Object.entries(job.bundle)) sending.push({ path: job.stem + suffix, role: suffix === "." + job.form ? "primary" : "companion" + suffix, hash: await blobs.put(text) });
      state.upsert({ address: job.address, path: primaryPath, form: job.form, fileHash: bundleHash(job.captured), files: job.captured, tiaFingerprint: "absent", baseId: "", readOnly: false, warnings: [], status: "importing", sending, sendingOp: opId });
      await state.flush();
    }
    let result;
    try {
      result = await bridge.importObject(job.address, job.form, stage.primary, job.expected, opId);
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      if (e.code === "OUTCOME_UNKNOWN") {
        // with what was sent (sending, or the new file of a create): rung resolve then lets the next pass tell
        state.upsert({
          ...(state.get(job.address) ?? { address: job.address, path: primaryPath, form: job.form, fileHash: "", files: [], tiaFingerprint: "absent", baseId: "", readOnly: false, warnings: [] }),
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
      if (REFUSALS.has(e.code)) opts.refused?.set(job.address, { key, code: e.code, message: e.message });
      if (e.code === "STALE_REVISION") warn(job.address, e.code, "TIA Portal changed meanwhile; merging on the next pass");
      else diag({ address: job.address, path: primaryPath, severity: "error", code: e.code, message: e.message });
      // what was sent stays known: an error can come after TIA Portal took the import (another Openness client
      // replaced the block before the answer was read). After a stale refusal the listing's fingerprint is no proof
      // (the bridge may keep one by modification dates): the next pass exports TIA Portal's version and merges.
      if (st) {
        const cur = state.get(job.address) ?? st;
        const stale = e.code === "STALE_REVISION" && !cur.tiaFingerprint.startsWith("stale:");
        state.upsert({ ...cur, status: "fileDirty", ...(stale ? { tiaFingerprint: `stale:${cur.tiaFingerprint}` } : {}) });
      } else state.remove(job.address); // refused: still just a new file
      continue;
    } finally {
      await rm(stage.dir, { recursive: true, force: true });
    }
    opts.refused?.delete(job.address);
    // Canonical rewrite: replace the imported files with TIA's form unless they were edited meanwhile.
    const staged = await mapStaged(root, result, null, job.stem);
    const pub = await planPublication(root, job.captured, staged.files);
    let next = await buildState(root, job.address, staged, false, now());
    if (pub.localEdit && next.form !== job.form) {
      // TIA Portal answered in a new form, but the file changed meanwhile: the state keeps the file's form, with
      // what was sent as its base, so the next pass sends the newer edit and then takes the new form
      next = { ...next, path: primaryPath, form: job.form, files: job.captured, fileHash: bundleHash(job.captured) };
    }
    if (pub.localEdit) warn(job.address, "EDITED_DURING_IMPORT", "the file changed while it was imported; the newer edit is sent on the next pass");
    else if (pub.targets.length || pub.removes.length) {
      const opId = randomUUID();
      await publishBundle(root, { opId, address: job.address, targets: pub.targets, removes: pub.removes, nextState: next }, { keepJournal: true });
      pendingOps.push(opId);
    }
    state.upsert(next);
    if (job.kind === "create") report.created++;
    else if (job.kind === "merge") report.merged++;
    else report.imported++;
    report.changes!.push({ path: primaryPath, action: job.kind === "update" ? "import" : job.kind });
    imported.push(job.address);
    if (result.compile) compiledByImport.set(job.address, result.compile);
    // its instance DBs and callers compile again only when what they see of it changed, or rung cannot tell
    const before = job.kind === "update" && st ? (await baseBundle(root, stemOf(st), st.files).catch(() => ({}) as Record<string, string>))["." + job.form] : undefined;
    const was = interfaceOf(job.form, before);
    // a DB is the exception: TIA Portal marks its users inconsistent after any import of it, a start value too
    if (!result.compile || job.form === "db" || was === undefined || was !== interfaceOf(job.form, job.bundle["." + job.form])) withCallers.push(job.address);
  }
  await checkpoint();

  if (plan) {
    // what would be compiled: the imported objects (by their imports) and, where they need it, their users
    if (imported.length && cfg.sync.compile !== "none") plan.compile = cfg.sync.compile === "all" ? ["(the whole PLC)"] : [...new Set([...imported, ...(await withUsers(root, state, withCallers))])];
    report.plan = plan;
    return report;
  }

  // Compile what was imported and turn compiler messages into diagnostics.
  if (imported.length && cfg.sync.compile !== "none") {
    const byDevice = new Map<string, string[]>();
    for (const a of imported) {
      const d = parseAddress(a).device;
      byDevice.set(d, [...(byDevice.get(d) ?? []), a]);
    }
    for (const [device, addrs] of byDevice) {
      try {
        let raw: CompileMessage[];
        if (withCallers.some((a) => addrs.includes(a)) || cfg.sync.compile === "all") opts.onPhase?.("compiling", cfg.sync.compile === "all" ? device : "what uses the changed blocks");
        if (cfg.sync.compile === "all") raw = await bridge.compile(device, []);
        else {
          // the import compiled the object itself already; what is left is its users, where they need it
          const own = addrs.filter((a) => compiledByImport.has(a));
          const order = new Map(imported.map((a, i) => [a, i]));
          const changed = addrs.filter((a) => withCallers.includes(a));
          const lastChange = Math.max(-1, ...changed.map((a) => order.get(a)!));
          // a user imported before the last interface change of the pass compiled against the old interface: again
          const scope = (await withUsers(root, state, changed)).filter((a) => !compiledByImport.has(a) || order.get(a)! < lastChange);
          // each object keeps the messages of the last compile that saw it: FB_Motor's import compiles its caller's
          // old text, the caller's own import a moment later compiles its new one (a renamed parameter in both)
          const events = [...own.map((a) => compiledByImport.get(a)!), ...(scope.length ? [await bridge.compile(device, scope)] : [])];
          const covers = events.map((msgs, i) => new Set([...(i < own.length ? [own[i]!] : scope), ...msgs.flatMap((m) => (m.address ? [m.address] : []))]));
          const last = new Map<string, number>();
          covers.forEach((c, i) => c.forEach((a) => last.set(a, i)));
          raw = events.flatMap((msgs, i) => msgs.filter((m) => !m.address || last.get(m.address) === i));
        }
        const msgs = await placeCompileMessages(root, (a) => state.get(a)?.path, raw, (f) => readFile(f, "utf8"));
        for (const m of msgs) {
          // "No block was compiled. All blocks are up-to-date." says nothing about any file
          if (m.severity === "info" && /^No block was compiled/i.test(m.description)) continue;
          const target = m.address ?? `plc:${device}`;
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
  await writeDiagnostics(
    root,
    report.diagnostics,
    (d) => {
      if (compiledAll || !d.address || compiled.has(d.address)) return false;
      const now = state.get(d.address);
      return !!now && (!d.revision || now.tiaFingerprint === d.revision);
    },
    (d) => !!quick && d.code !== "COMPILE" && !items.has(d.address),
  );
  await state.flush();
  return report;
}

/** Deletes an object in TIA after the user deleted its files and confirmed. */
/**
 * TIA Portal's version of one object as rung last had it, back in its files (a deleted file too); the person's
 * version is kept in .rung/recovery. Offline: the next pass brings anything newer from TIA Portal.
 */
export async function restoreFile(root: string, state: StateStore, path: string): Promise<{ copy?: string }> {
  const st = state.byPath(path);
  if (!st) throw new WorkspaceError("NOT_MIRRORED", `${path} is not a file rung mirrors (rung status lists them)`);
  if (st.status === "conflicted") throw new WorkspaceError("BAD_ARGUMENT", `${path} is in conflict: rung resolve ${st.path} --theirs takes TIA Portal's version`);
  const opId = randomUUID();
  const recoveryDir = join(root, ".rung", "recovery", "restore-" + opId);
  const blobs = new BlobStore(root);
  let kept = false;
  for (const f of st.files) {
    const now = await diskHash(root, f.path, f.hash);
    if (now === f.hash) continue;
    if (now !== "absent") kept = true;
    await replaceGuarded(rel2abs(root, f.path), await blobs.get(f.hash), { expectedHash: now, recoveryDir, force: true });
  }
  state.upsert({ ...st, status: st.status === "pendingDelete" || st.status === "fileDirty" ? "synced" : st.status, notSent: undefined });
  await state.flush();
  return kept ? { copy: relative(root, recoveryDir).split(sep).join("/") } : {};
}

/** An object whose files are gone here and whose block is this new file's under another name: a rename by hand. */
async function renamedBy(root: string, state: StateStore, name: string, text: string): Promise<ObjectState | undefined> {
  const blobs = new BlobStore(root);
  const squeeze = (s: string) => normalizeText(s).replace(/[ \t]+$/gm, "");
  for (const st of state.all()) {
    const primary = st.files.find((f) => f.role === "primary") ?? st.files[0];
    if (!primary || st.readOnly || (st.status !== "pendingDelete" && (st.status !== "synced" || existsSync(rel2abs(root, primary.path))))) continue;
    const old = parseAddress(st.address).name;
    if (old.toLowerCase() === name.toLowerCase()) continue;
    const before = await blobs.get(primary.hash).then((b) => b.toString("utf8"), () => undefined);
    if (before && squeeze(before.split(`"${old}"`).join(`"${name}"`)) === squeeze(text)) return st;
  }
  return undefined;
}

/** A PLC's default tag table, which TIA Portal never deletes (its name follows TIA's language). */
function isDefaultTagTable(address: string): boolean {
  const a = parseAddress(address);
  return a.kind === "tagtable" && !a.unit && /^(default tag table|standard-variablentabelle|table des variables standard|tabella delle variabili standard|tabla de variables estándar)$/i.test(a.name);
}

export async function confirmDelete(
  root: string,
  bridge: { deleteObject(address: string, expectedTiaRevision: string, operationId: string): Promise<unknown> },
  state: StateStore,
  address: string,
  opts: { force?: boolean } = {},
): Promise<{ users: string[] }> {
  const st = state.get(address);
  if (!st || st.status !== "pendingDelete") throw new WorkspaceError("NOTHING_PENDING", `${address} has no pending delete (rung status lists them)`);
  if ((await localStatus(root, st.files)) !== "missing" || (await Promise.all(st.files.map((f) => diskHash(root, f.path)))).some((h) => h !== "absent"))
    throw new WorkspaceError("LOCAL_CHANGES", `${address} has files again; delete not confirmed`);
  const { name } = parseAddress(address);
  if (isDefaultTagTable(address))
    throw new WorkspaceError("NOT_DELETABLE", `TIA Portal never deletes a PLC's default tag table; restore ${st.path} (git checkout -- "${st.path}", or rung pull)`);
  // what still names it stops compiling: say so first, and only --force deletes it anyway
  const users = (await withUsers(root, state, [address])).filter((a) => a !== address);
  if (users.length && !opts.force)
    throw new WorkspaceError("IN_USE", `${name} is used by ${users.map((a) => state.get(a)?.path ?? a).join(", ")}; they will not compile without it. rung confirm-delete ${st.path} --force deletes it anyway`);
  await bridge.deleteObject(address, st.tiaFingerprint, randomUUID());
  state.remove(address);
  await state.flush();
  return { users };
}

/**
 * Resolves a conflict recorded by syncOnce:
 *  - "theirs": the TIA version replaces the workspace file (the workspace version is kept in .rung/recovery);
 *  - "ours" / "merged": the current workspace file is the resolution and is imported on the next pass
 *    against exactly the TIA revision the conflict was computed from.
 */
export async function resolveConflict(root: string, state: StateStore, path: string, mode: "ours" | "theirs" | "merged"): Promise<void> {
  const st = state.byPath(path);
  if (!st || (st.status !== "conflicted" && st.status !== "recoveryRequired")) throw new WorkspaceError("NOTHING_PENDING", `${path} is not in conflict (rung status lists conflicts)`);
  const recoveryDir = join(root, ".rung", "recovery", "resolve-" + randomUUID());
  if (st.status === "recoveryRequired") return resolveUnknownImport(root, state, st, mode, recoveryDir);
  const tiaFiles = st.conflict?.tiaFiles ?? st.files;
  const tiaFingerprint = st.conflict?.tiaFingerprint ?? st.tiaFingerprint;
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
  // TIA Portal's side came in another form (a tag table that became .tags.st)
  const tiaForm = st.conflict?.tiaForm;
  if (mode === "theirs") {
    const blobs = new BlobStore(root);
    for (const f of tiaFiles)
      await replaceGuarded(rel2abs(root, f.path), await blobs.get(f.hash), { expectedHash: await diskHash(root, f.path), recoveryDir, force: true });
    if (tiaForm)
      // the files of the old form go to recovery: TIA's version replaces them
      for (const f of st.files) {
        const from = rel2abs(root, f.path);
        if (tiaFiles.some((t) => t.path === f.path) || !existsSync(from)) continue;
        await mkdir(join(recoveryDir, dirname(f.path)), { recursive: true });
        await rename(from, join(recoveryDir, f.path));
      }
    state.upsert({ ...st, files: tiaFiles, fileHash: bundleHash(tiaFiles), path: tiaFiles.find((f) => f.role === "primary")?.path ?? st.path, ...(tiaForm ? { form: tiaForm } : {}), tiaFingerprint, status: "synced", conflict: undefined });
  } else if (tiaForm) {
    // ours / merged across a form change: the person's file (its form) is sent against TIA's current version;
    // TIA's answer then brings the new form. The .tia helper files show TIA's side meanwhile.
    state.upsert({ ...st, tiaFingerprint, status: "fileDirty", conflict: undefined });
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
      } else if (
        mode === "merged" &&
        merged !== null &&
        markers.test(merged) &&
        (st.conflict?.local?.[f.path] !== undefined ? (await diskHash(root, f.path)) === st.conflict.local[f.path] : normalizeText(primary) === normalizeText(fileSide(merged)))
      ) {
        // nothing was merged: the file is as it was when the conflict came (an older state: still only its own
        // side). Taken as it is, TIA Portal's side would be lost
        throw new WorkspaceError(
          "CONFLICT_MARKERS",
          `${f.path}.conflict still contains conflict markers: merge it there, or merge into ${f.path} and delete ${f.path}.conflict; rung resolve ${f.path} --ours keeps your file; rung resolve ${f.path} --theirs takes TIA Portal's`,
        );
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

/**
 * An import that timed out: TIA Portal may or may not have it, so nothing is assumed. "ours" hands the file back
 * to the next pass, which compares it with TIA Portal again (the TIA revision is marked stale): sent again when
 * TIA Portal does not have it, merged or a conflict when it does. "theirs" puts back the version from before the
 * import (the file goes to .rung/recovery) and the next pass brings TIA Portal's.
 */
async function resolveUnknownImport(root: string, state: StateStore, st: ObjectState, mode: "ours" | "theirs" | "merged", recoveryDir: string): Promise<void> {
  const create = st.tiaFingerprint === "absent";
  if (mode === "theirs") {
    const blobs = new BlobStore(root);
    for (const f of st.files) {
      const from = rel2abs(root, f.path);
      if (!existsSync(from)) continue;
      if (create) {
        await mkdir(join(recoveryDir, dirname(f.path)), { recursive: true });
        await rename(from, join(recoveryDir, f.path));
      } else await replaceGuarded(from, await blobs.get(f.hash), { expectedHash: await diskHash(root, f.path), recoveryDir, force: true });
    }
    if (create) state.remove(st.address);
    else state.upsert({ ...st, status: "synced", tiaFingerprint: `stale:${st.tiaFingerprint}`, sending: undefined, sendingOp: undefined, sent: undefined });
  } else if (create) {
    // as a create Ctrl+C interrupted: finished from TIA Portal's side if it has the object, else created again
    state.upsert({ ...st, status: "importing" });
  } else state.upsert({ ...st, status: "fileDirty", tiaFingerprint: `stale:${st.tiaFingerprint}` });
  await state.flush();
}

/** The workspace's side of a .conflict file: the common lines and the lines between <<<<<<< file and the next marker. */
function fileSide(conflict: string): string {
  const out: string[] = [];
  let part: "common" | "file" | "other" = "common";
  for (const line of conflict.replace(/\r\n/g, "\n").split("\n")) {
    if (line === "<<<<<<< file") part = "file";
    else if ((line === "||||||| base" || line === "=======") && part === "file") part = "other";
    else if (line === ">>>>>>> tia") part = "common";
    else if (part !== "other") out.push(line);
  }
  return out.join("\n");
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
