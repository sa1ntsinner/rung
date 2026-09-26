// SPDX-License-Identifier: BUSL-1.1
// The steps every sync pass starts with: binding check, journal recovery, complete inventory, path preflight.
import {
  AddressError,
  WorkspaceError,
  addressToStem,
  parseAddress,
  preflight,
  recoverJournal,
  sweepTempFiles,
  type Address,
  type RungConfig,
  type StateStore,
} from "@rung/core";
import type { ObjectEntry, ProjectInfo } from "@rung/bridge-client";
import type { BridgeLike } from "./objects.js";

export interface Warning {
  address: string;
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

export async function takeInventory(root: string, bridge: BridgeLike, state: StateStore, config: RungConfig, warn: (w: Warning) => void): Promise<Inventory> {
  const w = (address: string, code: string, message?: string) => warn(message ? { address, code, message } : { address, code });

  const info = await bridge.projectInfo();
  if (!samePath(info.path, config.project.path) || info.tiaVersion !== config.project.tiaVersion)
    throw new WorkspaceError("BINDING_MISMATCH", `bridge is attached to ${info.path} (${info.tiaVersion}); workspace is bound to ${config.project.path}`);
  const devices = config.devices.length ? config.devices : info.devices;
  for (const d of devices) if (!info.devices.includes(d)) throw new WorkspaceError("BINDING_MISMATCH", `device ${d} not found in project`);
  for (const u of info.units ?? []) {
    const [dev, unit] = u.split("/");
    if (dev && unit && devices.includes(dev)) w(`plc:${dev}/units/${unit}`, "UNSUPPORTED_UNIT", "software units are mirrored from M5 on");
  }

  await sweepTempFiles(root);
  const recovery = await recoverJournal(root);
  for (const s of recovery.completed) state.upsert(s);
  const blocked = new Set(recovery.recoveryRequired);
  for (const a of blocked) w(a, "RECOVERY_REQUIRED", "interrupted publication left foreign content; see .rung/journal and .rung/recovery");

  const found: { entry: ObjectEntry; address: Address }[] = [];
  const skipped = new Set<string>();
  for (const device of devices) {
    for (const entry of await bridge.listObjects(device)) {
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
      if (address.unit !== undefined) {
        w(entry.address, "UNSUPPORTED_UNIT", "software units are mirrored from M5 on");
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
