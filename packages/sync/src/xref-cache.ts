// SPDX-License-Identifier: BUSL-1.1
// TIA Portal's cross-reference answers kept by the revision of what rung mirrors: asking again while no block, DB,
// type or tag table changed in TIA Portal (as the last pull or sync saw it) needs no TIA Portal. HMI screens and
// alarms are not mirrored, so a cached answer says when TIA Portal gave it.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { XRefEntry } from "@rung/bridge-client";

interface Cache {
  rev: string;
  answers: Record<string, { at: number; entries: XRefEntry[] }>;
}

async function revision(root: string): Promise<string> {
  const doc = JSON.parse(await readFile(join(root, ".rung", "state.json"), "utf8")) as { binding?: unknown; objects: Record<string, { address: string; tiaFingerprint: string }> };
  const rows = Object.values(doc.objects).map((o) => `${o.address}\t${o.tiaFingerprint}`).sort();
  // the project the workspace is bound to as well: another project's HMI may use the same names
  return createHash("sha256").update(JSON.stringify(doc.binding ?? null)).update(rows.join("\n")).digest("hex");
}

/** The cross-reference of `address`: kept from an earlier answer while nothing mirrored changed, else asked (and kept). */
export async function cachedXref(root: string, address: string, ask: () => Promise<XRefEntry[]>, opts: { fresh?: boolean; now?: () => number } = {}): Promise<{ entries: XRefEntry[]; at?: number }> {
  const file = join(root, ".rung", "xref.json");
  const rev = await revision(root).catch(() => "");
  let cache: Cache = { rev, answers: {} };
  try {
    const c = JSON.parse(await readFile(file, "utf8")) as Cache;
    if (c.rev === rev && rev) cache = c;
  } catch {
    /* none yet */
  }
  const kept = cache.answers[address];
  if (kept && !opts.fresh) return kept;
  const entries = await ask();
  cache.answers[address] = { at: (opts.now ?? Date.now)(), entries };
  // a cache, nothing more: when it cannot be written, the next question asks TIA Portal again
  if (rev) await writeFile(file, JSON.stringify(cache)).catch(() => undefined);
  return { entries };
}
