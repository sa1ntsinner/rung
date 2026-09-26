// SPDX-License-Identifier: BUSL-1.1
// Shared per-object steps of pull and sync: staging exports, comparing with disk and base, building state.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  BlobStore,
  WorkspaceError,
  bundleHash,
  isContained,
  normalizeText,
  pathKey,
  sha256,
  type ObjectState,
  type PublishTarget,
  type StateFile,
} from "@rung/core";
import { BridgeError, type BridgeClient, type ExportResult, type ObjectEntry } from "@rung/bridge-client";

export type BridgeLike = Pick<BridgeClient, "projectInfo" | "listObjects" | "exportObject">;

/** Staged files are named "obj<suffix>"; the suffix is appended to the object's stem in the workspace. */
export const STAGED_STEM = "obj";
export const SAFE_SUFFIX = /^\.[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

export function isReadOnlyEntry(e: ObjectEntry): boolean {
  return e.knowHowProtected || e.isFailsafe || e.isSystem || (e.language ?? "").includes("GRAPH");
}

export const isStrong = (fp: string) => fp.startsWith("fp:");
export const rel2abs = (root: string, rel: string) => join(root, ...rel.split("/"));

export async function diskHash(root: string, rel: string): Promise<string | "absent"> {
  try {
    return sha256(await readFile(rel2abs(root, rel)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
}

/** Disk state relative to the recorded base: clean, missing files only, or locally modified. */
export async function localStatus(root: string, files: readonly StateFile[]): Promise<"clean" | "missing" | "modified"> {
  let missing = false;
  for (const f of files) {
    const h = await diskHash(root, f.path);
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
    if (stageDir && !(await isContained(stageDir, f.path))) throw new BridgeError("EXPORT_FAILED", `staged file outside staging dir: ${f.path}`);
    const text = normalizeText((await readFile(f.path)).toString("utf8"));
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
    const cur = await diskHash(root, f.path);
    const old = baseByKey.get(pathKey(f.path));
    const base = old?.hash ?? "absent";
    if (cur !== base && cur !== f.hash && cur !== "absent") localEdit = true;
    // a case-only rename must republish even identical bytes so the on-disk name follows TIA
    if (cur !== f.hash || (old && old.path !== f.path)) targets.push({ path: f.path, hash: f.hash, prevHash: cur });
  }
  const removes: { path: string; prevHash: string }[] = [];
  for (const old of prevFiles) {
    if (files.some((f) => pathKey(f.path) === pathKey(old.path))) continue;
    const cur = await diskHash(root, old.path);
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
