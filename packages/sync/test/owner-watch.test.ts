// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig } from "@rung/core";
import { BridgeError } from "@rung/bridge-client";
import { OwnerServer, OwnerClient, Watcher, type ClosableBridge } from "../src/index.js";
import { FakeBridge } from "./fake-bridge.js";

const ws = () => mkdtempSync(join(tmpdir(), "rung-owner-"));
const until = async (cond: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  // replaceGuarded briefly moves the target aside, so a read can hit ENOENT: treat throws as "not yet"
  const ok = () => {
    try {
      return cond();
    } catch {
      return false;
    }
  };
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("owner IPC", () => {
  it("answers authenticated requests and pushes events to subscribers", async () => {
    const root = ws();
    const server = await OwnerServer.start(root, { status: async () => ({ objects: 3 }), echo: async (p) => p });
    const client = (await OwnerClient.connect(root))!;
    expect(await client.request("status")).toEqual({ objects: 3 });
    expect(await client.request("echo", { a: 1 })).toEqual({ a: 1 });
    const events: unknown[] = [];
    await client.subscribe((e, p) => events.push([e, p]));
    server.emit("diagnostics", { seq: 7 });
    await until(() => events.length > 0);
    expect(events[0]).toEqual(["diagnostics", { seq: 7 }]);
    client.close();
    await server.close();
    expect(existsSync(join(root, ".rung", "owner.json"))).toBe(false);
  });

  it("rejects a wrong token", async () => {
    const root = ws();
    const server = await OwnerServer.start(root, { status: async () => ({}) });
    const bad = await OwnerClient.withTokenForTest(root, "nope");
    await expect(bad.request("status")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await server.close();
  });

  it("reports unknown methods and handler errors with codes", async () => {
    const root = ws();
    const server = await OwnerServer.start(root, {
      boom: async () => {
        throw Object.assign(new Error("nope"), { code: "LOCAL_CHANGES" });
      },
    });
    const c = (await OwnerClient.connect(root))!;
    await expect(c.request("missing")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(c.request("boom")).rejects.toMatchObject({ code: "LOCAL_CHANGES" });
    c.close();
    await server.close();
  });

  it("returns null when no owner runs or the recorded owner is dead", async () => {
    const root = ws();
    expect(await OwnerClient.connect(root)).toBeNull();
    const server = await OwnerServer.start(root, {});
    await server.close();
    writeFileSync(join(root, ".rung", "owner.json"), JSON.stringify({ protocol: 1, pid: 999999, pipe: "x", token: "t", startedAt: 0 }));
    expect(await OwnerClient.connect(root)).toBeNull();
  });
});

class ClosableFake extends FakeBridge implements ClosableBridge {
  closed = false;
  async importObject(): Promise<never> {
    throw new BridgeError("READ_ONLY", "not in this test");
  }
  async compile() {
    return [];
  }
  async close() {
    this.closed = true;
  }
}

describe("Watcher", () => {
  it("syncs on start, on file changes, and restarts a dead bridge with backoff", async () => {
    const root = ws();
    const config = defaultConfig("C:\\fx\\RungFixture\\RungFixture.ap20", "V20", "fake");
    config.sync.pollMs = 60_000;
    const state = await StateStore.open(root, { projectPath: config.project.path, tiaVersion: "V20", devices: [] });
    const bridges: ClosableFake[] = [];
    let failNext = false;
    const errors: number[] = [];
    const reports: number[] = [];
    const w = new Watcher(root, state, {
      config,
      debounceMs: 50,
      maxBackoffMs: 100,
      bridgeFactory: async () => {
        const b = new ClosableFake();
        b.add("plc:PLC_1/blocks/Fx_A", { content: "a\n" });
        if (failNext) {
          failNext = false;
          b.failList = true; // listObjects → PORTAL_DISPOSED
        }
        bridges.push(b);
        return b;
      },
      onReport: (r) => reports.push(r.exported),
      onError: (_e, wait) => errors.push(wait),
    });
    w.start();
    await until(() => existsSync(join(root, "plc/PLC_1/blocks/Fx_A.scl")));
    // bridge dies: next pass fails, the bridge is dropped and recreated after backoff
    bridges[0]!.failList = true;
    await w.syncNow();
    expect(errors.length).toBe(1);
    expect(bridges[0]!.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    const r = await w.syncNow();
    expect(r).not.toBeNull();
    expect(bridges.length).toBe(2);
    // a TIA-side change shows up after a file event poke
    bridges[1]!.edit("plc:PLC_1/blocks/Fx_A", { ".scl": "a2\n" });
    writeFileSync(join(root, "plc/PLC_1/blocks/unrelated.txt"), "x");
    await until(() => readFileSync(join(root, "plc/PLC_1/blocks/Fx_A.scl"), "utf8") === "a2\n");
    await w.stop();
    await state.close();
    expect(reports.length).toBeGreaterThanOrEqual(2);
  });

  it("polls at most every other pass length and never queues ticks behind a running pass", async () => {
    const root = ws();
    const config = defaultConfig("C:\\fx\\RungFixture\\RungFixture.ap20", "V20", "fake");
    config.sync.pollMs = 60_000; // ticks are driven by hand below
    const state = await StateStore.open(root, { projectPath: config.project.path, tiaVersion: "V20", devices: [] });
    let passes = 0;
    class Slow extends ClosableFake {
      override async projectInfo() {
        passes++;
        await new Promise((r) => setTimeout(r, 150));
        return super.projectInfo();
      }
    }
    const w = new Watcher(root, state, { config, bridgeFactory: async () => new Slow() });
    await w.syncNow();
    expect(passes).toBe(1);
    w.tick(); // right after a 150 ms pass: too early
    expect(passes).toBe(1);
    expect(w.lastError).toBeNull();
    expect(w.lastPassMs).toBeGreaterThanOrEqual(150);
    await new Promise((r) => setTimeout(r, w.lastPassMs + 50));
    w.tick();
    w.tick(); // a second tick while the first runs must not queue another pass
    await new Promise((r) => setTimeout(r, w.lastPassMs + 400));
    expect(passes).toBe(2);
    await w.stop();
    await state.close();
  });
});
