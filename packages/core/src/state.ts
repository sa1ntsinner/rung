// SPDX-License-Identifier: BUSL-1.1
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { WorkspaceError } from "./errors.js";

export type ObjectStatus =
  | "synced"
  | "conflicted"
  | "pending"
  | "fileDirty"
  | "tiaDirty"
  | "bothDirty"
  | "importing"
  | "exporting"
  | "merging"
  | "pendingDelete"
  | "recoveryRequired";

export interface StateFile {
  path: string;
  role: string;
  hash: string;
}

export interface ObjectState {
  address: string;
  /** Workspace-relative path of the primary file. */
  path: string;
  form: string;
  /** Bundle hash over role/hash pairs of all files. */
  fileHash: string;
  files: StateFile[];
  tiaFingerprint: string;
  /** Hash of the immutable base bundle manifest in .rung/base/. */
  baseId: string;
  expectedFileHash?: string;
  expectedTiaFingerprint?: string;
  readOnly: boolean;
  warnings: string[];
  status: ObjectStatus;
  /** Epoch ms of the last verification by export + hash (weak revisions). */
  verifiedAt?: number;
  /** Set while status is "conflicted": the TIA revision and files the conflict was computed against. */
  /** deletedInTia: the object is gone from TIA Portal while the file was edited (resolve --ours recreates it). */
  conflict?: { tiaFingerprint: string; tiaFiles: StateFile[]; deletedInTia?: true };
}

export interface Binding {
  projectPath: string;
  tiaVersion: string;
  devices: string[];
}

interface StateDoc {
  format: 1;
  workspaceId: string;
  binding: Binding;
  objects: Record<string, ObjectState>;
}

interface LockInfo {
  host: string;
  pid: number;
  nonce: string;
  startedAt?: number;
}

const STATE_FORMAT = 1;

function sameBinding(a: Binding, b: Binding): boolean {
  return (
    a.projectPath.replace(/\//g, "\\").toLowerCase() === b.projectPath.replace(/\//g, "\\").toLowerCase() &&
    a.tiaVersion === b.tiaVersion &&
    JSON.stringify([...a.devices].sort()) === JSON.stringify([...b.devices].sort())
  );
}

function sortedJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    2,
  ) + "\n";
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Single-writer workspace state (.rung/state.json), rewritten atomically.
 * Holding a StateStore means holding .rung/lock.
 */
export class StateStore {
  private objects = new Map<string, ObjectState>();
  private paths = new Map<string, string>();
  private dirty = false;
  private closed = false;

  private constructor(
    readonly root: string,
    readonly workspaceId: string,
    readonly binding: Binding,
    private readonly lockNonce: string,
  ) {}

  static rungDir(root: string) {
    return join(root, ".rung");
  }

  /** binding = null reuses the stored binding (read-mostly commands such as status). */
  static async open(root: string, binding: Binding | null, opts: { rebind?: boolean } = {}): Promise<StateStore> {
    const dir = StateStore.rungDir(root);
    await mkdir(dir, { recursive: true });
    const nonce = await StateStore.acquireLock(dir);
    try {
      let doc: StateDoc | undefined;
      try {
        doc = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as StateDoc;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new WorkspaceError("STATE_FORMAT", `unreadable state.json: ${String(e)}`);
      }
      if (doc && doc.format !== STATE_FORMAT) throw new WorkspaceError("STATE_FORMAT", `state format ${doc.format} is not supported`);
      if (!doc && !binding) throw new WorkspaceError("NOT_A_WORKSPACE", `${root} has no rung state; run rung init`);
      if (doc && binding && !opts.rebind && !sameBinding(doc.binding, binding))
        throw new WorkspaceError("BINDING_MISMATCH", `workspace is bound to ${doc.binding.projectPath}; run rung init --rebind`);
      const store = new StateStore(root, doc?.workspaceId ?? randomUUID(), binding ?? doc!.binding, nonce);
      for (const o of Object.values(doc?.objects ?? {})) store.put(o);
      store.dirty = !doc || !!opts.rebind;
      return store;
    } catch (e) {
      await StateStore.releaseLock(dir, nonce);
      throw e;
    }
  }

  private static async acquireLock(dir: string): Promise<string> {
    const lock = join(dir, "lock");
    const mine: LockInfo = { host: hostname(), pid: process.pid, nonce: randomBytes(8).toString("hex"), startedAt: Date.now() };
    for (let attempt = 0; attempt < 3; attempt++) {
      // Write the complete lock record first, then publish it with an exclusive link: a lock file is never empty.
      const tmp = `${lock}.new-${mine.nonce}`;
      await writeFile(tmp, JSON.stringify(mine));
      try {
        await link(tmp, lock);
        return mine.nonce;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      } finally {
        await unlink(tmp).catch(() => {});
      }
      let owner: LockInfo | undefined;
      let ageMs = 0;
      try {
        ageMs = Date.now() - (await stat(lock)).mtimeMs;
        owner = JSON.parse(await readFile(lock, "utf8")) as LockInfo;
      } catch {
        owner = undefined;
      }
      // Unreadable lock (left by an older rung that crashed mid-write) counts as stale once it is clearly old.
      const stale = owner ? owner.host === hostname() && owner.pid !== process.pid && !alive(owner.pid) : ageMs > 30_000;
      if (!stale) throw new WorkspaceError("STATE_LOCKED", `workspace is in use by ${owner ? `${owner.host} pid ${owner.pid}` : "another process"}`);
      // Only one recoverer wins the rename; verify it moved the lock we inspected before discarding it.
      const moved = `${lock}.stale-${mine.nonce}`;
      try {
        await rename(lock, moved);
      } catch {
        continue; // someone else recovered it first
      }
      let check: LockInfo | undefined;
      try {
        check = JSON.parse(await readFile(moved, "utf8")) as LockInfo;
      } catch {
        check = undefined;
      }
      if ((check?.nonce ?? undefined) !== (owner?.nonce ?? undefined)) {
        // We grabbed a fresh lock taken by another recoverer: give it back untouched.
        await link(moved, lock).catch(() => {});
        await unlink(moved).catch(() => {});
        throw new WorkspaceError("STATE_LOCKED", "workspace lock changed during recovery");
      }
      await unlink(moved).catch(() => {});
    }
    throw new WorkspaceError("STATE_LOCKED", "could not acquire workspace lock");
  }

  private static async releaseLock(dir: string, nonce: string) {
    const lock = join(dir, "lock");
    try {
      const owner = JSON.parse(await readFile(lock, "utf8")) as LockInfo;
      if (owner.nonce === nonce) await unlink(lock);
    } catch {
      /* already gone */
    }
  }

  private put(o: ObjectState) {
    const prev = this.objects.get(o.address);
    if (prev) this.paths.delete(prev.path);
    const copy = structuredClone(o);
    this.objects.set(o.address, copy);
    this.paths.set(copy.path, copy.address);
  }

  get(address: string): ObjectState | undefined {
    const o = this.objects.get(address);
    return o && structuredClone(o);
  }

  byPath(path: string): ObjectState | undefined {
    const a = this.paths.get(path);
    return a === undefined ? undefined : this.get(a);
  }

  upsert(o: ObjectState): void {
    this.assertOpen();
    this.put(o);
    this.dirty = true;
  }

  remove(address: string): void {
    this.assertOpen();
    const prev = this.objects.get(address);
    if (!prev) return;
    this.objects.delete(address);
    this.paths.delete(prev.path);
    this.dirty = true;
  }

  all(): ObjectState[] {
    return [...this.objects.keys()].sort().map((a) => this.get(a)!);
  }

  transaction<T>(fn: () => T): T {
    const snapObjects = structuredClone(this.objects);
    const snapPaths = new Map(this.paths);
    const snapDirty = this.dirty;
    try {
      return fn();
    } catch (e) {
      this.objects = snapObjects;
      this.paths = snapPaths;
      this.dirty = snapDirty;
      throw e;
    }
  }

  async flush(force = false): Promise<void> {
    if (!this.dirty && !force) return;
    const objects: Record<string, ObjectState> = {};
    for (const a of [...this.objects.keys()].sort()) objects[a] = this.objects.get(a)!;
    const doc: StateDoc = { format: STATE_FORMAT, workspaceId: this.workspaceId, binding: this.binding, objects };
    await writeFileAtomic(join(StateStore.rungDir(this.root), "state.json"), sortedJson(doc));
    this.dirty = false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    await StateStore.releaseLock(StateStore.rungDir(this.root), this.lockNonce);
  }

  private assertOpen() {
    if (this.closed) throw new Error("StateStore is closed");
  }
}
