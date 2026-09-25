// SPDX-License-Identifier: BUSL-1.1
// Preflight checks that run before any workspace file is written.
import { realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { findCaseCollisions } from "./address.js";

/** Longest suffix rung may append to a leaf ("protected.yaml", companion roles stay below this). */
export const LONGEST_SUFFIX = ".protected.yaml".length + 16;
/** Classic Windows MAX_PATH minus a margin for temp names (".<name>.rung-tmp-xxxxxxxxxxxx"). */
export const MAX_ABSOLUTE_PATH = 259 - 32;

export interface PlannedPath {
  address: string;
  /** Primary path without the form extension, e.g. plc/PLC_1/blocks/A/Fx_Motor */
  stem: string;
}

export interface PreflightResult {
  ok: PlannedPath[];
  collisions: [string, string][];
  tooLong: string[];
}

/** Rejects stems that would collide on case-insensitive/normalizing filesystems or exceed path limits. */
export function preflight(root: string, planned: readonly PlannedPath[]): PreflightResult {
  const collisions = findCaseCollisions(planned.map((p) => p.stem));
  const colliding = new Set(collisions.flat());
  const tooLong: string[] = [];
  const ok: PlannedPath[] = [];
  const absRoot = resolve(root);
  for (const p of planned) {
    if (colliding.has(p.stem)) continue;
    if (join(absRoot, ...p.stem.split("/")).length + LONGEST_SUFFIX > MAX_ABSOLUTE_PATH && process.platform === "win32") {
      tooLong.push(p.stem);
      continue;
    }
    ok.push(p);
  }
  return { ok, collisions, tooLong };
}

/** True if the nearest existing ancestor of `target` resolves (through junctions/symlinks) inside `root`. */
export async function isContained(root: string, target: string): Promise<boolean> {
  const realRoot = await realpath(root);
  let probe = resolve(target);
  for (;;) {
    try {
      const real = await realpath(probe);
      return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
    } catch {
      const up = dirname(probe);
      if (up === probe) return false;
      probe = up;
    }
  }
}
