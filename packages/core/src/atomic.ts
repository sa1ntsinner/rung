// SPDX-License-Identifier: BUSL-1.1
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, link, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { WorkspaceError } from "./errors.js";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

/** Strip BOM, CRLF → LF, exactly one trailing LF for non-empty text. */
export function normalizeText(s: string): string {
  let t = s.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (t.length && !t.endsWith("\n")) t += "\n";
  return t;
}

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Windows antivirus/indexers briefly lock fresh files; retry a bounded number of times. */
async function retry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (i >= attempts || !RETRYABLE.has(code)) throw e;
      await sleep(25 * 2 ** i);
    }
  }
}

async function writeTemp(target: string, data: string | Uint8Array): Promise<string> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.rung-tmp-${randomBytes(6).toString("hex")}`);
  const fh = await open(tmp, "wx");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  return tmp;
}

/** Write to a temp file in the same directory, fsync, then rename over the target. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = await writeTemp(path, data);
  try {
    await retry(() => rename(tmp, path));
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface GuardOptions {
  /** Hash the destination must currently have, or "absent" if it must not exist. */
  expectedHash: string | "absent";
  /** Where displaced files are retained (never deleted here). */
  recoveryDir: string;
  /** Replace even if the destination differs from expectedHash (its content is kept in recoveryDir). */
  force?: boolean;
}

export interface GuardResult {
  /** Retained previous content, if the destination existed. */
  preimage?: string;
}

/**
 * Publish `data` at `path` without silently destroying concurrent edits:
 * the current file is moved aside (so late writers keep writing into the moved file),
 * its captured content is verified against the expectation, and the new file is created
 * exclusively so a file recreated by an editor in the meantime is never clobbered.
 */
export async function replaceGuarded(path: string, data: string | Uint8Array, opts: GuardOptions): Promise<GuardResult> {
  const tmp = await writeTemp(path, data);
  let preimage: string | undefined;
  let mode: number | undefined;
  try {
    if (await exists(path)) {
      mode = (await stat(path)).mode & 0o777; // a read-only file stays read-only
      await mkdir(opts.recoveryDir, { recursive: true });
      preimage = join(opts.recoveryDir, `${Date.now()}-${randomBytes(4).toString("hex")}-${basename(path)}`);
      await retry(() => rename(path, preimage!));
      const captured = sha256(await readFile(preimage));
      // the same text with other line endings (a git checkout with core.autocrlf) is what was expected
      const unexpected = opts.expectedHash === "absent" || (captured !== opts.expectedHash && sha256(normalizeText((await readFile(preimage)).toString("utf8"))) !== opts.expectedHash);
      if (unexpected && !opts.force) {
        // put the user's file back where it was, unless something recreated it meanwhile
        if (!(await exists(path))) await retry(() => rename(preimage!, path));
        throw new WorkspaceError("LOCAL_CHANGES", `${path} changed locally; not overwritten`);
      }
    }
    try {
      // link fails with EEXIST if an editor recreated the file; no retry on EPERM (no hard links on FAT/exFAT/shares)
      await link(tmp, path);
      await unlink(tmp).catch(() => {});
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new WorkspaceError("LOCAL_CHANGES", `${path} was recreated during publication; new content kept at ${tmp}`);
      if (code === "EXDEV" || code === "ENOTSUP" || code === "EPERM" || code === "ENOSYS") {
        if (await exists(path)) throw new WorkspaceError("LOCAL_CHANGES", `${path} was recreated during publication`);
        await retry(() => rename(tmp, path)); // filesystems without hard links
      } else throw e;
    }
    if (mode !== undefined && !(mode & 0o200)) await chmod(path, mode).catch(() => {});
    return preimage ? { preimage } : {};
  } catch (e) {
    // Never leave the destination empty: if the new file did not land, put the previous one back.
    if (preimage && !(await exists(path))) await retry(() => rename(preimage!, path)).catch(() => {});
    if (!(e instanceof WorkspaceError && e.message.includes(tmp))) await unlink(tmp).catch(() => {});
    throw e;
  }
}
