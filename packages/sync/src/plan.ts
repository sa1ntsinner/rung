// SPDX-License-Identifier: BUSL-1.1
// rung sync --preview: what the next pass would do, decided by the pass itself on a copy of the state that it may
// change freely, with every write (imports, files, the state on disk, diagnostics) left out.
import { diffIndices } from "node-diff3";
import type { ObjectState, StateStore } from "@rung/core";

export interface PlanEntry {
  address: string;
  /** Workspace-relative primary file. */
  path: string;
  /**
   * create, update, merge: sent to TIA Portal (a merge with what changed there); export: TIA Portal's change comes
   * into the file; remove: deleted in TIA Portal, the file goes; restore: the file comes back from TIA Portal;
   * conflict: changed on both sides on the same lines, nothing is sent; pending-delete: deleted here, waits for
   * rung confirm-delete.
   */
  action: "create" | "update" | "merge" | "export" | "remove" | "restore" | "conflict" | "pending-delete";
  /** The side that changes, before and after (TIA Portal's version for what is sent, the file for what comes back). */
  before?: string;
  after?: string;
  detail?: string;
}

export interface Plan {
  entries: PlanEntry[];
  /** What would be compiled after the imports (objects' addresses). */
  compile: string[];
}

/** A copy of the state the pass may change as it decides; nothing reaches the disk. */
export function dryState(real: StateStore): StateStore {
  const map = new Map<string, ObjectState>(real.all().map((s) => [s.address, s]));
  const dry = {
    get: (address: string) => map.get(address),
    byPath: (path: string) => [...map.values()].find((s) => s.path === path),
    upsert: (o: ObjectState) => void map.set(o.address, o),
    remove: (address: string) => void map.delete(address),
    all: () => [...map.values()],
    flush: async () => {},
    close: async () => {},
  };
  return dry as unknown as StateStore;
}

/** A unified diff of two texts, line by line. */
export function unifiedDiff(a: string, b: string, labelA: string, labelB: string): string {
  const la = a.split("\n");
  const lb = b.split("\n");
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  for (const h of diffIndices(la, lb)) {
    const [aStart, aLen] = h.buffer1;
    const [bStart, bLen] = h.buffer2;
    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`);
    for (const l of la.slice(aStart, aStart + aLen)) out.push("-" + l);
    for (const l of lb.slice(bStart, bStart + bLen)) out.push("+" + l);
  }
  return out.length > 2 ? out.join("\n") : "(no changes)";
}
