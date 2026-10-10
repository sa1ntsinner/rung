// SPDX-License-Identifier: BUSL-1.1
// The write right is read again for every rename or delete a running watch is asked for.
import { describe, it, expect, vi } from "vitest";
import { defaultConfig, type RungConfig } from "@rung/core";
import { cmdWatch } from "../src/twoway.js";

const control = vi.hoisted(() => ({
  config: undefined as RungConfig | undefined,
  started: false,
  opts: undefined as undefined | { onReport(r: unknown): void; onError(e: Error, wait: number): void },
  handlers: {} as Record<string, (p: Record<string, unknown>) => Promise<unknown>>,
  rename: vi.fn(async () => ({})),
  remove: vi.fn(async () => ({ users: [] })),
}));
vi.mock("@rung/core", async (original) => ({
  ...await original<typeof import("@rung/core")>(),
  loadConfig: async () => structuredClone(control.config),
}));
vi.mock("@rung/sync", async (original) => ({
  ...await original<typeof import("@rung/sync")>(),
  OwnerServer: { start: async (_root: string, handlers: typeof control.handlers) => { control.handlers = handlers; return { emit() {}, async close() {} }; } },
  Watcher: class { bridgeForTools = {}; constructor(_d: unknown, _s: unknown, o: typeof control.opts) { control.opts = o; } start() { control.started = true; } async stop() {} },
  renameObject: control.rename,
  confirmDelete: control.remove,
}));
vi.mock("../src/common.js", () => ({
  openState: async () => ({ async close() {}, get() {} }),
  importFlags: () => [],
  bridgeFor: async () => ({}),
}));

describe("rung watch: requests over IPC check the write right as it is now", () => {
  for (const method of ["rename", "confirmDelete"] as const) it(`reloads the write right before IPC ${method}`, async () => {
    control.config = defaultConfig("C:/fixture/project.ap20", "V20", "fake");
    control.started = false;
    control.rename.mockClear();
    control.remove.mockClear();
    let stop!: () => void;
    const running = cmdWatch("/workspace", { cwd: "/workspace", env: {}, stdout() {}, stderr() {}, stopSignal: new Promise<void>((r) => { stop = r; }) });
    // Let startup finish; the watch is idle and no sync pass is in flight.
    for (let i = 0; !control.started && i < 100; i++) await new Promise((r) => setTimeout(r, 1));
    try {
      expect(control.started).toBe(true);
      control.config = { ...control.config!, writesOff: true, sync: { ...control.config!.sync, import: "manual" } };
      await expect(control.handlers[method]!({ address: "plc:PLC_1/blocks/A", newName: "B" })).rejects.toMatchObject({ code: "WRITES_OFF" });
      expect(control.rename).not.toHaveBeenCalled();
      expect(control.remove).not.toHaveBeenCalled();
    } finally { stop(); await running; }
  });
});

describe("rung watch: the terminal says when it reached TIA Portal", () => {
  it("prints the first quiet pass, and the first after an error, once", async () => {
    control.config = defaultConfig("C:/fixture/project.ap20", "V20", "fake");
    control.started = false;
    const out: string[] = [];
    let stop!: () => void;
    const running = cmdWatch("/workspace", { cwd: "/workspace", env: {}, stdout: (s: string) => out.push(s), stderr() {}, stopSignal: new Promise<void>((r) => { stop = r; }) });
    for (let i = 0; !control.started && i < 100; i++) await new Promise((r) => setTimeout(r, 1));
    try {
      const quiet = { exported: 0, imported: 0, created: 0, merged: 0, unchanged: 49, conflicts: 0, removed: 0, pendingDeletes: 0, warnings: [], diagnostics: [] };
      control.opts!.onReport(quiet);
      control.opts!.onReport(quiet);
      control.opts!.onError(Object.assign(new Error("lost"), { code: "TIA_GONE" }), 5000);
      control.opts!.onReport(quiet);
      expect(out.filter((s) => s.includes("connected to TIA Portal"))).toEqual([
        "rung watch: connected to TIA Portal; files and TIA Portal agree (49 objects)\n",
        "rung watch: connected to TIA Portal; files and TIA Portal agree (49 objects)\n",
      ]);
    } finally { stop(); await running; }
  });
});
