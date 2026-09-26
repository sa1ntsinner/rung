// SPDX-License-Identifier: BUSL-1.1
// rung doctor: measures whether export → import → export reaches a fixed point per object.
// It imports over objects, so it is only ever run against a generated fixture project.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { normalizeText } from "@rung/core";
import type { BridgeClient, ExportResult } from "@rung/bridge-client";
import { isReadOnlyEntry, STAGED_STEM, type BridgeLike } from "./pull.js";

export type DoctorBridge = BridgeLike & Pick<BridgeClient, "importObject">;

export interface DoctorRow {
  address: string;
  form: string;
  pass1Equal: boolean;
  pass2Equal: boolean;
  diffSample?: string;
  error?: string;
  skipped?: "read-only" | "unit" | "system" | "no-import";
}

interface Snapshot {
  result: ExportResult;
  primary: string;
  /** suffix → normalized text */
  files: Map<string, string>;
}

async function snapshot(bridge: DoctorBridge, address: string, dir: string): Promise<Snapshot> {
  await mkdir(dir, { recursive: true });
  const result = await bridge.exportObject(address, "auto", dir);
  const files = new Map<string, string>();
  let primary = "";
  for (const f of result.files) {
    const suffix = basename(f.path).slice(STAGED_STEM.length);
    files.set(suffix, normalizeText(await readFile(f.path, "utf8")));
    if (f.role === "primary") primary = f.path;
  }
  return { result, primary, files };
}

function equal(a: Snapshot, b: Snapshot): boolean {
  if (a.files.size !== b.files.size) return false;
  for (const [k, v] of a.files) if (b.files.get(k) !== v) return false;
  return true;
}

/** First differing line pair, for the fact sheet. */
function diffSample(a: Snapshot, b: Snapshot): string {
  for (const [k, v] of a.files) {
    const w = b.files.get(k) ?? "";
    const la = v.split("\n");
    const lb = w.split("\n");
    for (let i = 0; i < Math.max(la.length, lb.length); i++)
      if (la[i] !== lb[i]) return `${k}:${i + 1}\n- ${la[i] ?? "<eof>"}\n+ ${lb[i] ?? "<eof>"}`;
  }
  return "(file set differs)";
}

export async function doctor(
  root: string,
  bridge: DoctorBridge,
  opts: { devices?: string[]; addresses?: string[]; onProgress?: (done: number, total: number, address: string) => void } = {},
): Promise<DoctorRow[]> {
  const work = join(root, ".rung", "doctor", randomUUID());
  const devices = opts.devices ?? (await bridge.projectInfo()).devices;
  const rows: DoctorRow[] = [];
  try {
    for (const device of devices) {
      const entries = (await bridge.listObjects(device)).filter((e) => !opts.addresses || opts.addresses.includes(e.address));
      for (const [i, entry] of entries.entries()) {
        opts.onProgress?.(i + 1, entries.length, entry.address);
        const row: DoctorRow = { address: entry.address, form: "", pass1Equal: false, pass2Equal: false };
        rows.push(row);
        if (entry.unit) { row.skipped = "unit"; continue; }
        if (entry.isSystem) { row.skipped = "system"; continue; }
        if (isReadOnlyEntry(entry)) { row.skipped = "read-only"; continue; }
        const dir = join(work, String(rows.length));
        try {
          const a = await snapshot(bridge, entry.address, join(dir, "a"));
          row.form = a.result.form;
          await bridge.importObject(entry.address, a.result.form, a.primary, a.result.fingerprint, randomUUID());
          const b = await snapshot(bridge, entry.address, join(dir, "b"));
          row.pass1Equal = equal(a, b);
          if (row.pass1Equal) {
            row.pass2Equal = true;
            continue;
          }
          row.diffSample = diffSample(a, b);
          await bridge.importObject(entry.address, b.result.form, b.primary, b.result.fingerprint, randomUUID());
          const c = await snapshot(bridge, entry.address, join(dir, "c"));
          row.pass2Equal = equal(b, c);
        } catch (e) {
          const code = (e as { code?: string }).code;
          // watch/force tables and other export-only objects: nothing to round-trip
          if (code === "UNSUPPORTED_OBJECT" && !row.pass1Equal && row.form) { row.skipped = "no-import"; continue; }
          row.error = code ? `${code}: ${(e as Error).message}` : String(e);
        }
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return rows;
}

export type DoctorSummary = Record<string, { pass1: number; pass2: number; never: number; errors: number }>;

export function summarize(rows: readonly DoctorRow[]): DoctorSummary {
  const out: DoctorSummary = {};
  for (const r of rows) {
    if (r.skipped || !r.form) continue;
    const s = (out[r.form] ??= { pass1: 0, pass2: 0, never: 0, errors: 0 });
    if (r.error) s.errors++;
    else if (r.pass1Equal) s.pass1++;
    else if (r.pass2Equal) s.pass2++;
    else s.never++;
  }
  return out;
}
