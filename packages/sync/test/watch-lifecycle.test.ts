// SPDX-License-Identifier: BUSL-1.1
// rung watch restarting its bridge for writes: never under a pass in flight, with the rights it was started with.
import { it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig, type RungConfig } from "@rung/core";
import { BridgeError } from "@rung/bridge-client";
import { Watcher } from "../src/watch.js";
import { FakeBridge } from "./fake-bridge.js";

const address = "plc:PLC_1/blocks/A";
const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(r => resolve = r), resolve: () => resolve() }; };
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "rung-watch-edges-"));
  const config = defaultConfig("C:\\fx\\RungFixture\\RungFixture.ap20", "V20", "fake");
  config.sync.backup = "off";
  config.sync.compile = "none";
  const state = await StateStore.open(root, { projectPath: config.project.path, tiaVersion: "V20", devices: [] });
  return { root, config, state };
};
class Bridge extends FakeBridge {
  closed = false;
  imports: string[] = [];
  async close() { this.closed = true; }
  async compile() { return []; }
  async importObject(a: string, form: string, source: string) {
    if (this.closed) throw new BridgeError("BRIDGE_EXITED", "bridge closed during pass");
    this.imports.push(a);
    this.edit(a, { ["." + form]: readFileSync(source, "utf8") });
    return this.exportObject(a, form, mkdtempSync(join(tmpdir(), "rung-import-edges-")));
  }
}

it("does not close the active pass's bridge while an IPC refresh enables writes", async () => {
  const { root, config, state } = await fixture();
  let live: RungConfig = { ...config, writesOff: true as const, sync: { ...config.sync, import: "manual" as const } };
  const entered = deferred(), release = deferred();
  class Slow extends Bridge {
    block = false;
    override async projectInfo() {
      if (this.block) { entered.resolve(); await release.promise; }
      if (this.closed) throw new BridgeError("BRIDGE_EXITED", "bridge closed during pass");
      return super.projectInfo();
    }
  }
  const old = new Slow().add(address, { content: "a\n" });
  const replacement = new Bridge().add(address, { content: "a\n" });
  let factories = 0;
  const w = new Watcher(root, state, { config: live, reloadConfig: async () => live, bridgeFactory: async () => factories++ ? replacement : old });
  try {
    await w.syncNow();
    old.block = true;
    const pass = w.syncNow();
    await entered.promise;
    live = config;
    const refresh = w.refresh();
    await new Promise(r => setTimeout(r, 30));
    const closedDuringPass = old.closed;
    release.resolve();
    const report = await pass;
    await refresh;
    assert.equal(closedDuringPass, false, "refresh closed a bridge still serving the pass");
    assert.notEqual(report, null);
  } finally { release.resolve(); await w.stop(); await state.close(); }
});

it("records the rights captured when a slow bridge factory started", async () => {
  const { root, config, state } = await fixture();
  let live: RungConfig = { ...config, writesOff: true as const, sync: { ...config.sync, import: "manual" as const } };
  const entered = deferred(), release = deferred();
  class Rights extends Bridge {
    constructor(readonly mayImport: boolean) { super(); }
    override async importObject(a: string, form: string, source: string) {
      if (!this.mayImport) throw new BridgeError("READ_ONLY", "bridge was started without import rights");
      return super.importObject(a, form, source);
    }
  }
  const factories: Rights[] = [];
  const w = new Watcher(root, state, {
    config: live, reloadConfig: async () => live,
    bridgeFactory: async () => {
      const b = new Rights(live.sync.import === "auto" && !live.writesOff).add(address, { content: "a\n" });
      factories.push(b);
      if (factories.length === 1) { entered.resolve(); await release.promise; }
      return b;
    },
  });
  try {
    const first = w.syncNow();
    await entered.promise;
    live = config;
    const refreshed = w.refresh(); // IPC refresh while no bridge has finished its handshake yet (it waits for the pass)
    release.resolve();
    await first;
    await refreshed;
    writeFileSync(join(root, "plc/PLC_1/blocks/A.scl"), "edited\n");
    await w.syncNow();
    assert.equal(factories.length, 2, "the read-only bridge should be replaced after writes turn on");
    assert.equal(factories.flatMap(b => b.imports).length, 1);
  } finally { release.resolve(); await w.stop(); await state.close(); }
});


it("a pass that failed on a TIA Portal that went away does not hold the next try back; only the backoff does", async () => {
  const { root, config, state } = await fixture();
  class Dying extends Bridge {
    dead = false;
    override async projectInfo() {
      if (this.dead) { await new Promise(r => setTimeout(r, 60)); throw new BridgeError("BRIDGE_EXITED", "TIA Portal ended"); }
      return super.projectInfo();
    }
  }
  const b = new Dying().add(address, { content: "a\n" });
  const w = new Watcher(root, state, { config, bridgeFactory: async () => b });
  await w.syncNow();
  b.dead = true;
  assert.equal(await w.syncNow(), null);
  // idle polling waits twice the last pass; a pass that hung on a dead TIA Portal must not make the reconnect wait
  assert.equal(w.lastPassMs, 0);
});
it("an Openness access refusal waits for the person instead of retrying every few seconds", async () => {
  const { root, config, state } = await fixture();
  let made = 0;
  const errors: number[] = [];
  const w = new Watcher(root, state, {
    config,
    bridgeFactory: async () => {
      made++;
      throw new BridgeError("ACCESS_DENIED", "Openness registration is missing");
    },
    onError: (_e, wait) => errors.push(wait),
    now: () => 10_000_000 + made * 60_000, // well past any backoff
  });
  assert.equal(await w.syncNow(), null);
  assert.equal(await w.syncNow(), null);
  assert.equal(await w.syncNow(), null);
  assert.equal(made, 1); // asked once, then waits
  assert.deepEqual(errors, [-1]); // told once, without a retry time
  assert.equal(w.blocked?.message, "Openness registration is missing");
  await w.syncNow(true); // the person fixed it and asked again
  assert.equal(made, 2);
});