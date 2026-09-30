// SPDX-License-Identifier: BUSL-1.1
// Content-addressed base blobs and a journal that makes multi-file publication recoverable.
import { mkdir, readdir, readFile, stat, unlink, writeFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { replaceGuarded, sha256, writeFileAtomic } from "./atomic.js";
import { WorkspaceError } from "./errors.js";
import type { ObjectState } from "./state.js";

export function bundleHash(files: readonly { role: string; hash: string }[]): string {
  return sha256(
    files
      .map((f) => `${f.role}\t${f.hash}`)
      .sort()
      .join("\n"),
  );
}

export class BlobStore {
  readonly dir: string;
  constructor(root: string) {
    this.dir = join(root, ".rung", "base");
  }
  async put(data: string | Uint8Array): Promise<string> {
    const h = sha256(data);
    const p = join(this.dir, h.slice(0, 2), h);
    try {
      await stat(p);
    } catch {
      await writeFileAtomic(p, data);
    }
    return h;
  }
  get(hash: string): Promise<Buffer> {
    return readFile(join(this.dir, hash.slice(0, 2), hash));
  }
}

export interface PublishTarget {
  /** Workspace-relative POSIX path. */
  path: string;
  /** Blob hash of the new content. */
  hash: string;
  /** Hash the file must have now, or "absent". */
  prevHash: string | "absent";
}

export interface PublishIntent {
  opId: string;
  address: string;
  targets: PublishTarget[];
  removes: { path: string; prevHash: string }[];
  nextState: ObjectState;
}

export class Journal {
  readonly dir: string;
  constructor(private readonly root: string) {
    this.dir = join(root, ".rung", "journal");
  }
  async write(intent: PublishIntent): Promise<void> {
    await writeFileAtomic(join(this.dir, `${intent.opId}.json`), JSON.stringify(intent));
  }
  async done(opId: string): Promise<void> {
    await unlink(join(this.dir, `${opId}.json`)).catch(() => {});
  }
  async pending(): Promise<PublishIntent[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: PublishIntent[] = [];
    for (const n of names.filter((n) => n.endsWith(".json")).sort())
      out.push(JSON.parse(await readFile(join(this.dir, n), "utf8")) as PublishIntent);
    return out;
  }
}

async function currentHash(abs: string): Promise<string | "absent"> {
  try {
    return sha256(await readFile(abs));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
}

const abs = (root: string, rel: string) => join(root, ...rel.split("/"));

/** True if the directory lists exactly this spelling (case-insensitive filesystems also answer for other casings). */
async function exactName(p: string): Promise<boolean> {
  try {
    return (await readdir(dirname(p))).includes(basename(p));
  } catch {
    return false;
  }
}
/**
 * Key under which the filesystem sees the same file: case-insensitive and normalizing on
 * Windows and macOS (default volumes), exact on Linux.
 */
export const pathKey = (p: string) => (process.platform === "linux" ? p : p.normalize("NFC").toLowerCase());
const fold = pathKey;

async function apply(root: string, intent: PublishIntent, force: boolean): Promise<void> {
  const blobs = new BlobStore(root);
  const recoveryDir = join(root, ".rung", "recovery", intent.opId);
  for (const t of intent.targets) {
    const now = await currentHash(abs(root, t.path));
    if (now === t.hash && (await exactName(abs(root, t.path)))) continue;
    await replaceGuarded(abs(root, t.path), await blobs.get(t.hash), { expectedHash: t.prevHash, recoveryDir, force });
  }
  const targetKeys = new Set(intent.targets.map((t) => fold(t.path)));
  for (const r of intent.removes) {
    // A case-only rename (Motor.scl → MOTOR.scl) is the same file on Windows/macOS: never trash the new one.
    if (targetKeys.has(fold(r.path))) continue;
    const p = abs(root, r.path);
    const now = await currentHash(p);
    if (now === "absent") continue;
    if (now !== r.prevHash && !force) throw new WorkspaceError("LOCAL_CHANGES", `${r.path} changed locally; not removed`);
    const dest = join(root, ".rung", "trash", intent.opId, ...r.path.split("/"));
    await mkdir(dirname(dest), { recursive: true });
    await rename(p, dest);
  }
}

/**
 * Publish all files of one object. Every target is checked against its expected
 * previous hash before anything is written; the intent is journaled so a crash in
 * the middle is rolled forward by recoverJournal().
 */
export async function publishBundle(root: string, intent: PublishIntent, opts: { force?: boolean; keepJournal?: boolean } = {}): Promise<PublishIntent> {
  if (!opts.force) {
    for (const t of intent.targets) {
      const now = await currentHash(abs(root, t.path));
      if (now !== t.prevHash && now !== t.hash) throw new WorkspaceError("LOCAL_CHANGES", `${t.path} changed locally; not overwritten`);
    }
    const targetKeys = new Set(intent.targets.map((t) => fold(t.path)));
    for (const r of intent.removes) {
      if (targetKeys.has(fold(r.path))) continue;
      const now = await currentHash(abs(root, r.path));
      if (now !== "absent" && now !== r.prevHash) throw new WorkspaceError("LOCAL_CHANGES", `${r.path} changed locally; not removed`);
    }
  }
  const journal = new Journal(root);
  await journal.write(intent);
  await apply(root, intent, !!opts.force);
  // Callers that record nextState in a state file flushed later keep the journal entry until that flush.
  if (!opts.keepJournal) await journal.done(intent.opId);
  return intent;
}

/** Puts back the file a dropped write-back had moved aside (its preimage), if it did. */
async function restorePreimage(root: string, opId: string, t: PublishTarget): Promise<void> {
  if (t.prevHash === "absent") return;
  const dir = join(root, ".rung", "recovery", opId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names)
    if ((await currentHash(join(dir, n))) === t.prevHash) {
      await mkdir(dirname(abs(root, t.path)), { recursive: true });
      await rename(join(dir, n), abs(root, t.path));
      return;
    }
}

/** A retained preimage of `prevHash` for this operation proves an "absent" target is mid-publication, not foreign. */
async function hasPreimage(root: string, opId: string, prevHash: string): Promise<boolean> {
  const dir = join(root, ".rung", "recovery", opId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  for (const n of names) if ((await currentHash(join(dir, n))) === prevHash) return true;
  return false;
}

export interface RecoveryReport {
  /** Intents that are now fully published; the caller must record nextState. */
  completed: ObjectState[];
  /** Objects whose write-back could not be finished; journal entry kept. */
  recoveryRequired: string[];
  /** Objects whose files were edited after an interrupted write-back: dropped, the files and the state kept. */
  dropped: string[];
}

export async function recoverJournal(root: string): Promise<RecoveryReport> {
  const journal = new Journal(root);
  const report: RecoveryReport = { completed: [], recoveryRequired: [], dropped: [] };
  for (const intent of await journal.pending()) {
    let consistent = true;
    for (const t of intent.targets) {
      const now = await currentHash(abs(root, t.path));
      if (now === t.hash || now === t.prevHash) continue;
      if (now === "absent" && (await hasPreimage(root, intent.opId, t.prevHash))) continue;
      consistent = false;
    }
    if (!consistent) {
      // A file was edited after the write-back stopped. The person's files stay and the write-back is dropped;
      // the state stays as it was, so the next pass compares the files with TIA Portal again (a merge, or a
      // conflict where both changed the same lines). A file the write-back had moved aside comes back.
      for (const t of intent.targets) if ((await currentHash(abs(root, t.path))) === "absent") await restorePreimage(root, intent.opId, t);
      await journal.done(intent.opId);
      report.dropped.push(intent.address);
      continue;
    }
    try {
      await apply(root, intent, false);
      await journal.done(intent.opId);
      report.completed.push(intent.nextState);
    } catch (e) {
      if (!(e instanceof WorkspaceError)) throw e;
      report.recoveryRequired.push(intent.address);
    }
  }
  return report;
}

/** Record a note next to retained recovery material (human-readable). */
export async function writeRecoveryNote(root: string, opId: string, text: string): Promise<void> {
  const p = join(root, ".rung", "recovery", opId, "README.txt");
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
}
