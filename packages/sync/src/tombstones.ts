// SPDX-License-Identifier: BUSL-1.1
// What rung renamed or deleted in TIA Portal, remembered: a file git brings back unchanged (a branch switch, a stash,
// an old commit checked out) is that old object, not a new block to create next to the renamed one.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@rung/core";

export interface Tombstone {
  address: string;
  path: string;
  /** The object's primary file as rung last had it (a blob in .rung/base). */
  hash: string;
  /** Where it went when it was renamed; absent when it was deleted. */
  to?: string;
  /** Gone from TIA Portal by someone else's hand (another workspace, TIA Portal itself): renamed or deleted there. */
  by?: "tia";
  at: number;
  /** Every file of the object (the primary and companions such as a LAD block's .s7res), by suffix after the stem. */
  files?: { suffix: string; hash: string }[];
}

/** The tombstone of an object as the state has it: its primary file's hash and all its files. */
export function tombstoneOf(st: { address: string; path: string; form: string; files: { path: string; hash: string; role: string }[] }, rest: Pick<Tombstone, "to" | "by">): Tombstone | undefined {
  const primary = st.files.find((f) => f.role === "primary") ?? st.files[0];
  if (!primary) return undefined;
  const stem = st.path.slice(0, -(st.form.length + 1));
  return { address: st.address, path: st.path, hash: primary.hash, ...rest, at: Date.now(), files: st.files.map((f) => ({ suffix: f.path.slice(stem.length), hash: f.hash })) };
}

/**
 * Whether files brought back are the object's old ones, unchanged: every file of the tombstone with its text (line
 * endings aside) and no other. `text(hash)` reads an old file; an older tombstone knows only the primary.
 */
export async function sameAsTombstone(t: Tombstone, primarySuffix: string, bundle: Record<string, string>, text: (hash: string) => Promise<string | undefined>): Promise<boolean> {
  const files = t.files ?? [{ suffix: primarySuffix, hash: t.hash }];
  if (t.files && Object.keys(bundle).length !== files.length) return false;
  for (const f of files) {
    const now = bundle[f.suffix];
    if (now === undefined || (await text(f.hash)) !== now) return false;
  }
  return true;
}

const file = (root: string) => join(root, ".rung", "tombstones.json");
/** Long enough for an old branch to come back, short enough that a reused name is free again. */
const KEEP_MS = 180 * 24 * 3600 * 1000;

export async function readTombstones(root: string, now = Date.now()): Promise<Tombstone[]> {
  try {
    const all = JSON.parse(await readFile(file(root), "utf8")) as Tombstone[];
    return Array.isArray(all) ? all.filter((t) => t && typeof t.address === "string" && now - t.at < KEEP_MS) : [];
  } catch {
    return [];
  }
}

export async function recordTombstone(root: string, t: Tombstone): Promise<void> {
  const all = (await readTombstones(root, t.at)).filter((x) => x.address !== t.address);
  await writeFileAtomic(file(root), JSON.stringify([...all, t], null, 1) + "\n");
}
