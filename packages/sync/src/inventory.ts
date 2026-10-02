// SPDX-License-Identifier: BUSL-1.1
// The steps every sync pass starts with: binding check, journal recovery, complete inventory, path preflight.
import {
  AddressError,
  WorkspaceError,
  addressToStem,
  escapeSegment,
  parseAddress,
  preflight,
  recoverJournal,
  sweepTempFiles,
  type Address,
  type RungConfig,
  type StateStore,
  writeFileAtomic,
} from "@rung/core";
import type { KnownRevision, ObjectEntry, ProjectInfo } from "@rung/bridge-client";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeLike } from "./objects.js";

export interface Warning {
  address: string;
  path?: string;
  code: string;
  message?: string;
}

export interface Inventory {
  info: ProjectInfo;
  devices: string[];
  /** Mirrorable objects of the bound devices, complete (a failed listing throws). */
  items: { entry: ObjectEntry; address: Address; stem: string | undefined }[];
  /** Addresses whose interrupted publication needs a human (journal kept). */
  blocked: Set<string>;
  /** Addresses skipped on purpose (units, system, bad metadata): never deleted from state. */
  skipped: Set<string>;
  collisions: [string, string][];
  tooLong: string[];
}

const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/**
 * What the bridge read of each object in earlier passes: the fingerprint for its modification dates. A new bridge
 * (every rung sync starts one) reads again only what changed since, instead of every fingerprint of the project.
 */
const revisionsFile = (root: string) => join(root, ".rung", "revisions.json");

async function loadRevisions(root: string): Promise<{ text: string; objects: Record<string, KnownRevision> }> {
  try {
    const text = await readFile(revisionsFile(root), "utf8");
    const f = JSON.parse(text) as { version?: unknown; objects?: unknown };
    if (f.version === 1 && f.objects && typeof f.objects === "object") return { text, objects: f.objects as Record<string, KnownRevision> };
  } catch {
    // none yet, or unreadable: the bridge reads every fingerprint once
  }
  return { text: "", objects: {} };
}

/** What every pass checks before it touches anything: the binding, then finishing or flagging interrupted write-backs. */
export async function preparePass(
  root: string,
  bridge: BridgeLike,
  state: StateStore,
  config: RungConfig,
  warn: (w: Warning) => void,
  readOnly = false,
): Promise<{ info: ProjectInfo; devices: string[]; blocked: Set<string> }> {
  const w = (address: string, code: string, message?: string) => warn(message ? { address, code, message } : { address, code });
  const info = await bridge.projectInfo();
  if (!samePath(info.path, config.project.path))
    throw new WorkspaceError("BINDING_MISMATCH", `TIA Portal has ${info.path} open; this workspace is bound to ${config.project.path} (rung init --rebind binds it to another project)`);
  if (info.tiaVersion !== config.project.tiaVersion)
    throw new WorkspaceError("BINDING_MISMATCH", `${info.path} is open in TIA Portal ${info.tiaVersion}; rung.toml says tiaVersion = "${config.project.tiaVersion}"`);
  const devices = config.devices.length ? config.devices : info.devices;
  for (const d of devices) if (!info.devices.includes(d)) throw new WorkspaceError("BINDING_MISMATCH", `device ${d} not found in project`);

  // a preview finishes nothing: an interrupted write-back is the next real pass's to finish
  if (readOnly) return { info, devices, blocked: new Set() };
  await sweepTempFiles(root);
  const recovery = await recoverJournal(root);
  for (const s of recovery.completed) state.upsert(s);
  const blocked = new Set(recovery.recoveryRequired);
  for (const a of blocked) w(a, "RECOVERY_REQUIRED", "an interrupted write-back could not be finished; see .rung/journal and .rung/recovery");
  for (const a of recovery.dropped) w(a, "WRITE_BACK_DROPPED", "the file was edited after an interrupted write-back of TIA Portal's version; it is compared with TIA Portal again");
  return { info, devices, blocked };
}

export async function takeInventory(root: string, bridge: BridgeLike, state: StateStore, config: RungConfig, warn: (w: Warning) => void, readOnly = false): Promise<Inventory> {
  const w = (address: string, code: string, message?: string) => warn(message ? { address, code, message } : { address, code });
  const { info, devices, blocked } = await preparePass(root, bridge, state, config, warn, readOnly);

  const found: { entry: ObjectEntry; address: Address }[] = [];
  const skipped = new Set<string>();
  const known = await loadRevisions(root);
  const revisions: Record<string, KnownRevision> = {};
  for (const device of devices) {
    const prefix = `plc:${escapeSegment(device)}/`;
    const entries = await bridge.listObjects(device, Object.fromEntries(Object.entries(known.objects).filter(([a]) => a.startsWith(prefix))));
    for (const e of entries)
      if (e.revisionKey && e.revisionAt) revisions[e.address] = { key: e.revisionKey, fingerprint: e.fingerprint, at: e.revisionAt, ...(e.libraryType ? { libraryType: e.libraryType } : {}) };
    for (const entry of entries) {
      let address: Address;
      try {
        address = parseAddress(entry.address);
      } catch (e) {
        if (!(e instanceof AddressError)) throw e;
        w(entry.address, "BAD_ADDRESS", "bridge returned a non-canonical address");
        skipped.add(entry.address);
        continue;
      }
      if ((entry.namespace ?? undefined) !== address.namespace || (entry.unit ?? undefined) !== address.unit) {
        w(entry.address, "BAD_ADDRESS", "namespace/unit metadata does not match the address");
        skipped.add(entry.address);
        continue;
      }
      if (entry.isSystem) {
        w(entry.address, "UNSUPPORTED_OBJECT", "system blocks are not mirrored");
        skipped.add(entry.address);
        continue;
      }
      found.push({ entry, address });
    }
  }
  const text = JSON.stringify({ version: 1, objects: revisions });
  if (text !== known.text && !readOnly) await writeFileAtomic(revisionsFile(root), text);

  const pre = preflight(root, found.map((i) => ({ address: i.entry.address, stem: addressToStem(i.address) })));
  for (const [a, b] of pre.collisions) w(a, "PATH_COLLISION", `collides with ${b}`);
  for (const s of pre.tooLong) w(s, "PATH_TOO_LONG");
  const writable = new Map(pre.ok.map((p) => [p.address, p.stem]));
  return {
    info,
    devices,
    items: found.map((i) => ({ ...i, stem: writable.get(i.entry.address) })),
    blocked,
    skipped,
    collisions: pre.collisions,
    tooLong: pre.tooLong,
  };
}
