// SPDX-License-Identifier: BUSL-1.1
// The right of one copy of a workspace to write into its project. rung init leaves it off: rung pull mirrors the
// project and edits stay in the files until the person turns writes on. It lives in .rung/ (never in git) and names
// the project it was given for, so a clone, a rebind to another project or another host starts without it.
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import type { RungConfig } from "./config.js";

export const WRITES_FILE = join(".rung", "writes.json");

export interface WritesGrant {
  project: string;
  host?: string;
  since: string;
}

export async function readWrites(root: string): Promise<WritesGrant | undefined> {
  try {
    const g = JSON.parse(await readFile(join(root, WRITES_FILE), "utf8")) as Partial<WritesGrant>;
    return typeof g.project === "string" && typeof g.since === "string" ? { project: g.project, since: g.since, ...(typeof g.host === "string" ? { host: g.host } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** Windows paths compare without letter case; the path is the one rung init recorded from TIA Portal. */
const samePath = (a: string, b: string) => (/^([a-z]:|\\\\)/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);

export function writesGranted(grant: WritesGrant | undefined, config: Pick<RungConfig, "project" | "bridge">): boolean {
  return !!grant && samePath(grant.project, config.project.path) && (grant.host ?? "") === (config.bridge.host ?? "");
}

export async function grantWrites(root: string, config: Pick<RungConfig, "project" | "bridge">, now = new Date()): Promise<void> {
  await mkdir(join(root, ".rung"), { recursive: true });
  const grant: WritesGrant = { project: config.project.path, ...(config.bridge.host ? { host: config.bridge.host } : {}), since: now.toISOString() };
  await writeFileAtomic(join(root, WRITES_FILE), JSON.stringify(grant, null, 2) + "\n");
}

export async function revokeWrites(root: string): Promise<void> {
  await rm(join(root, WRITES_FILE), { force: true });
}
