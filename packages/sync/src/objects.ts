// SPDX-License-Identifier: BUSL-1.1
// Shared per-object steps of pull and sync: staging exports, comparing with disk and base, building state.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  BlobStore,
  WorkspaceError,
  bundleHash,
  isContained,
  normalizeText,
  parseAddress,
  pathKey,
  sha256,
  type ObjectState,
  type StateStore,
  type PublishTarget,
  type StateFile,
} from "@rung/core";
import { BridgeError, type BridgeClient, type ExportResult, type ObjectEntry } from "@rung/bridge-client";

export type BridgeLike = Pick<BridgeClient, "projectInfo" | "listObjects" | "exportObject"> & Partial<Pick<BridgeClient, "identify">>;

/** Staged files are named "obj<suffix>"; the suffix is appended to the object's stem in the workspace. */
export const STAGED_STEM = "obj";
export const SAFE_SUFFIX = /^\.[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

export function isReadOnlyEntry(e: ObjectEntry): boolean {
  return readOnlyReason(e) !== undefined;
}

/** Why rung never sends an edit of this object to TIA Portal, or undefined. */
export function readOnlyReason(e: ObjectEntry): string | undefined {
  if (e.libraryType) return `an instance of the library type ${e.libraryType}; change the type in TIA Portal's library (Edit type)`;
  if (e.kind === "forcetable") return "a force table: forcing stays in TIA Portal";
  if (e.knowHowProtected) return "know-how protected";
  if (e.isFailsafe) return "part of the safety program, which stays in TIA Portal";
  if (e.isSystem) return "a system object";
  if ((e.language ?? "").includes("GRAPH")) return "a GRAPH block, which stays in TIA Portal";
  return undefined;
}

export const isStrong = (fp: string) => fp.startsWith("fp:");
export const rel2abs = (root: string, rel: string) => join(root, ...rel.split("/"));

/**
 * The file's hash; `like` when the file holds that content but with other line endings, a BOM or no final newline
 * (a git checkout with core.autocrlf): the same text, not an edit to send to TIA Portal.
 */
export async function diskHash(root: string, rel: string, like?: string): Promise<string | "absent"> {
  let bytes: Buffer;
  try {
    bytes = await readFile(rel2abs(root, rel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
  const hash = sha256(bytes);
  return like && hash !== like && sha256(normalizeText(bytes.toString("utf8"))) === like ? like : hash;
}

/** Disk state relative to the recorded base: clean, missing files only, or locally modified. */
export async function localStatus(root: string, files: readonly StateFile[]): Promise<"clean" | "missing" | "modified"> {
  let missing = false;
  for (const f of files) {
    const h = await diskHash(root, f.path, f.hash);
    if (h === "absent") missing = true;
    else if (h !== f.hash) return "modified";
  }
  return missing ? "missing" : "clean";
}

export interface StagedExport {
  result: ExportResult;
  /** Workspace files the export maps to, sorted by path. */
  files: StateFile[];
  /** suffix (".scl", ".s7res", …) → normalized text */
  texts: Map<string, string>;
  primary: StateFile;
}

/** Exports one object into a private staging dir, validates the file set and stores base blobs. */
export async function stageExport(root: string, bridge: Pick<BridgeClient, "exportObject">, address: string, stem: string): Promise<StagedExport> {
  const stage = join(root, ".rung", "tmp", randomUUID());
  await mkdir(stage, { recursive: true });
  try {
    const result = await bridge.exportObject(address, "auto", stage);
    return await mapStaged(root, result, stage, stem);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Maps an ExportResult whose files live in `stageDir` onto workspace paths below `stem`. */
export async function mapStaged(root: string, result: ExportResult, stageDir: string | null, stem: string): Promise<StagedExport> {
  const blobs = new BlobStore(root);
  const files: StateFile[] = [];
  const texts = new Map<string, string>();
  for (const f of result.files) {
    const name = basename(f.path);
    const suffix = name.startsWith(STAGED_STEM) ? name.slice(STAGED_STEM.length) : "";
    if (!SAFE_SUFFIX.test(suffix) || (f.role === "primary") !== (suffix === "." + result.form))
      throw new BridgeError("EXPORT_FAILED", `unexpected staged file ${JSON.stringify(name)} (${f.role})`);
    // a bridge on another machine sends the text itself (content); a local one leaves the file in stageDir
    if (f.content === undefined && stageDir && !(await isContained(stageDir, f.path))) throw new BridgeError("EXPORT_FAILED", `staged file outside staging dir: ${f.path}`);
    const text = normalizeText(f.content ?? (await readFile(f.path)).toString("utf8"));
    const rel = stem + suffix;
    if (!(await isContained(root, rel2abs(root, rel)))) throw new WorkspaceError("PATH_ESCAPE", `${rel} resolves outside the workspace`);
    files.push({ path: rel, role: f.role, hash: await blobs.put(text) });
    texts.set(suffix, text);
  }
  const primary = files.find((f) => f.role === "primary");
  if (!primary) throw new BridgeError("EXPORT_FAILED", "export returned no primary file");
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { result, files, texts, primary };
}

export interface Publication {
  targets: PublishTarget[];
  removes: { path: string; prevHash: string }[];
  /** Disk differs from the recorded base (a local edit that publishing would overwrite). */
  localEdit: boolean;
}

/** Compares the new file set with disk and with the previous base. */
export async function planPublication(root: string, prevFiles: readonly StateFile[], files: readonly StateFile[]): Promise<Publication> {
  const baseByKey = new Map(prevFiles.map((f) => [pathKey(f.path), f]));
  const targets: PublishTarget[] = [];
  let localEdit = false;
  for (const f of files) {
    const old = baseByKey.get(pathKey(f.path));
    const cur = await diskHash(root, f.path, old?.hash ?? f.hash);
    const base = old?.hash ?? "absent";
    if (cur !== base && cur !== f.hash && cur !== "absent") localEdit = true;
    // a case-only rename must republish even identical bytes so the on-disk name follows TIA
    if (cur !== f.hash || (old && old.path !== f.path)) targets.push({ path: f.path, hash: f.hash, prevHash: cur });
  }
  const removes: { path: string; prevHash: string }[] = [];
  for (const old of prevFiles) {
    if (files.some((f) => pathKey(f.path) === pathKey(old.path))) continue;
    const cur = await diskHash(root, old.path, old.hash);
    if (cur === "absent") continue;
    if (cur !== old.hash) localEdit = true;
    removes.push({ path: old.path, prevHash: cur });
  }
  return { targets, removes, localEdit };
}

export async function buildState(root: string, address: string, staged: StagedExport, readOnly: boolean, verifiedAt: number, extra: Partial<ObjectState> = {}): Promise<ObjectState> {
  const manifest = JSON.stringify(staged.files.map((f) => ({ role: f.role, path: f.path, hash: f.hash })));
  return {
    address,
    path: staged.primary.path,
    form: staged.result.form,
    fileHash: bundleHash(staged.files),
    files: staged.files,
    tiaFingerprint: staged.result.fingerprint,
    baseId: await new BlobStore(root).put(manifest),
    readOnly,
    warnings: [...(staged.result.warnings ?? [])],
    status: "synced",
    verifiedAt,
    ...extra,
  };
}

/** Reads the workspace bundle (suffix → normalized text) for the given recorded files, or null if the primary is gone. */
export async function readBundle(root: string, stem: string, files: readonly StateFile[]): Promise<Record<string, string> | null> {
  const out: Record<string, string> = {};
  for (const f of files) {
    try {
      out[f.path.slice(stem.length)] = normalizeText(await readFile(rel2abs(root, f.path), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (f.role === "primary") return null;
    }
  }
  return out;
}

/** Base texts of the recorded bundle from the blob store (suffix → text). */
export async function baseBundle(root: string, stem: string, files: readonly StateFile[]): Promise<Record<string, string>> {
  const blobs = new BlobStore(root);
  const out: Record<string, string> = {};
  for (const f of files) out[f.path.slice(stem.length)] = (await blobs.get(f.hash)).toString("utf8");
  return out;
}

/** Writes a bundle as obj<suffix> files into a fresh staging dir for import; returns the primary path. */
export async function stageForImport(root: string, form: string, bundle: Record<string, string>): Promise<{ dir: string; primary: string }> {
  const dir = join(root, ".rung", "tmp", randomUUID());
  await mkdir(dir, { recursive: true });
  for (const [suffix, text] of Object.entries(bundle)) {
    if (!SAFE_SUFFIX.test(suffix)) throw new WorkspaceError("PATH_ESCAPE", `bad suffix ${suffix}`);
    await writeFile(join(dir, STAGED_STEM + suffix), text);
  }
  return { dir, primary: join(dir, STAGED_STEM + "." + form) };
}

/** Another program holds the file (editor save in progress, antivirus, backup): skip it this pass. */
export function isLockError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

/** Quoted uses of a name in SCL/SD (`"Name"`, `"Name".x`) and in SimaticML (`Name="Name"`). */
export function mentions(text: string, name: string): boolean {
  return text.includes(`"${name}"`) || text.includes(`Name="${name.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
}

/** Unit tests name blocks too (`block: Fx_Counter`, `"Fx_Counter".member`); they follow the rename. */
/** The tests that name the old block, unless they name another PLC (`plc: PLC_2`: another block of that name). */
export async function renameInTests(root: string, oldName: string, newName: string, device: string): Promise<string[]> {
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

/**
 * Objects TIA Portal renamed or moved to another group since the last pass, by its lasting identity (V20 and later):
 * the new address and the state of the old one: `recognized` all of them, `renamed` those whose files are clean and
 * move (an edited file is left to the person). Also records the identity of every listed object that has none yet.
 * Fatal bridge failures pass through; a bridge without identities finds none.
 */
export async function renamesInTia(root: string, bridge: BridgeLike, state: StateStore, items: readonly { entry: ObjectEntry; stem?: string | null }[], orphans: Iterable<ObjectState>, fatal: ReadonlySet<string>): Promise<{ ids: Record<string, string>; renamed: Map<string, ObjectState>; recognized: Map<string, ObjectState> }> {
  const renamed = new Map<string, ObjectState>();
  const recognized = new Map<string, ObjectState>();
  const ask = items.filter((i) => i.stem && !state.get(i.entry.address)?.tiaId).map((i) => i.entry.address);
  if (!bridge.identify || !ask.length) return { ids: {}, renamed, recognized };
  let ids: Record<string, string>;
  try {
    ids = (await bridge.identify(ask)) ?? {};
  } catch (e) {
    if (e instanceof BridgeError && fatal.has(e.code)) throw e;
    return { ids: {}, renamed, recognized }; // an older bridge: no identities
  }
  for (const [address, id] of Object.entries(ids)) {
    const s = state.get(address);
    if (s && s.tiaId !== id) state.upsert({ ...s, tiaId: id });
  }
  const byId = new Map<string, ObjectState>();
  for (const s of orphans) if (s.tiaId) byId.set(s.tiaId, s);
  for (const address of ask) {
    const was = ids[address] ? byId.get(ids[address]!) : undefined;
    if (!was || state.get(address) || was.status === "importing" || [...recognized.values()].includes(was)) continue;
    recognized.set(address, was);
    if ((await localStatus(root, was.files)) === "clean") renamed.set(address, was);
  }
  return { ids, renamed, recognized };
}

/**
 * The orphan a new address takes over by letter case alone (Fx_A for fx_a.scl, on Windows one file), unless TIA
 * Portal's identity gives that orphan to another address (it was renamed, and this is a new object).
 */
export function caseOrphan(address: string, o: ObjectState | undefined, recognized: ReadonlyMap<string, ObjectState>): ObjectState | undefined {
  if (!o || [...recognized].some(([a, x]) => x === o && a !== address)) return undefined;
  return o;
}

/**
 * TIA Portal keeps uses symbolic: after a rename there, the files that name the old object come back with the new
 * name, though TIA reports them unchanged. Marked stale, the pass exports them again.
 */
export async function markUsersStale(root: string, state: StateStore, renamed: ReadonlyMap<string, ObjectState>): Promise<void> {
  const names = [...renamed].filter(([to, o]) => parseAddress(to).name !== parseAddress(o.address).name).map(([, o]) => parseAddress(o.address).name);
  if (!names.length) return;
  const moving = new Set([...renamed.values()].map((o) => o.address));
  for (const s of state.all()) {
    if (moving.has(s.address) || s.tiaFingerprint.startsWith("stale:")) continue;
    const texts = await Promise.all(s.files.map((f) => readFile(join(root, f.path), "utf8").catch(() => "")));
    if (texts.some((t) => names.some((n) => mentions(t, n)))) state.upsert({ ...s, tiaFingerprint: `stale:${s.tiaFingerprint}` });
  }
}
