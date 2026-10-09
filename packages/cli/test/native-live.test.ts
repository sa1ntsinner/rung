// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "@rung/core";
import type { OnlineNativeCapture } from "@rung/bridge-client";
import { main } from "../src/main.js";
import * as broker from "../src/liveServer.js";

afterEach(() => vi.restoreAllMocks());
const scope = { device: "P", address: "192.168.250.1", transport: "s7commplus" as const, epoch: 2 };
const frame = { at: 12, scope, values: { Count: 5 }, errors: {}, observedAt: { Count: 10 }, state: "live" as const };
const native: OnlineNativeCapture = { scope, coherence: "subscription-sample", capture: {
  bodies: [{ compilationUnit: "1", text: "#Count := #Count + 1;" }], scalars: [{ name: "COUNT", bitOffset: 32, bits: 16, type: '{Scalar"33554437"Int}' }],
  route: { instance: "Motor_DB", database: 4, functionBlock: 4, sac: 118, compilationUnit: "1", element: "258" }, codeSignature: "GNvs4SJibzA=",
  samples: [1, 2, 3].map(sequence => ({ observedAt: 20, sequence, state: { before: { COUNT: 2 }, after: { COUNT: 3 } } })),
} };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rung-native-live-")), dir = join(root, "plc", "P", "blocks");
  await saveConfig(root, defaultConfig("fixture.ap20", "V20", "", ["P"])); await mkdir(dir, { recursive: true });
  const file = join(dir, "Motor.scl");
  await writeFile(file, 'FUNCTION_BLOCK "Motor"\nVAR_OUTPUT\nCount : Int;\nEND_VAR\nBEGIN\n#Count := #Count + 1;\nEND_FUNCTION_BLOCK');
  await writeFile(join(dir, "Motor_DB.db"), 'DATA_BLOCK "Motor_DB"\n"Motor"\nBEGIN\nEND_DATA_BLOCK');
  return { root, file };
}
it("replays native prestate and retains its own timestamp and recorded Why", async () => {
  const { root } = await fixture(); let stop!: () => void;
  const stopSignal = new Promise<void>(resolve => { stop = resolve; }), output: any[] = [];
  setTimeout(stop, 1000).unref();
  const release = vi.fn(async () => {}), capture = vi.fn(async () => native);
  vi.spyOn(broker, "brokerReader").mockResolvedValue({ read: async () => [], close: async () => {}, capture,
    subscribe: async (_labels, _cycle, callback) => { callback(frame); return { close: release }; } });
  expect(await main(["live", "watch", "--file", "plc/P/blocks/Motor.scl", "--json"], { cwd: root, env: {}, stderr() {}, stopSignal,
    stdout: line => { const item = JSON.parse(line); output.push(item); if (item.programStatus?.kind === "reconstructed") stop(); } })).toBe(0);
  expect(output.at(-1)).toMatchObject({ values: { Count: 5 }, observedAt: { Count: 10 }, programStatus: { kind: "reconstructed", exact: false,
    freshness: "native-sample", coherence: "subscription-sample", observedAt: 20, after: { COUNT: 3 }, divergences: [], why: { COUNT: { value: "3" } } } });
  expect(capture).toHaveBeenCalledWith("Motor", "Motor_DB", scope); expect(release).toHaveBeenCalledOnce();
});
it("drops a native result after the value subscription moves to another epoch", async () => {
  const { root } = await fixture(); let stop!: () => void, push!: (value: typeof frame) => void;
  const stopSignal = new Promise<void>(resolve => { stop = resolve; }), output: any[] = [];
  setTimeout(stop, 1000).unref();
  const capture = vi.fn(async () => { push({ ...frame, scope: { ...scope, epoch: 3 } }); setTimeout(stop, 30); return native; });
  vi.spyOn(broker, "brokerReader").mockResolvedValue({ read: async () => [], close: async () => {}, capture,
    subscribe: async (_labels, _cycle, callback) => { push = callback; callback(frame); return { close: async () => {} }; } });
  expect(await main(["live", "watch", "--file", "plc/P/blocks/Motor.scl", "--json"], { cwd: root, env: {}, stderr() {}, stopSignal, stdout: line => output.push(JSON.parse(line)) })).toBe(0);
  expect(capture).toHaveBeenCalledOnce(); expect(output.some(item => item.programStatus?.kind === "reconstructed")).toBe(false);
  expect(output.at(-1).scope.epoch).toBe(3);
});
it("invalidates a cached native reconstruction as soon as a mirrored source changes", async () => {
  const { root, file } = await fixture(); let stop!: () => void, edited = false;
  const stopSignal = new Promise<void>(resolve => { stop = resolve; }), output: any[] = [];
  setTimeout(stop, 1500).unref();
  const capture = vi.fn(async () => native);
  vi.spyOn(broker, "brokerReader").mockResolvedValue({ read: async () => [], close: async () => {}, capture,
    subscribe: async (_labels, _cycle, callback) => { callback(frame); return { close: async () => {} }; } });
  expect(await main(["live", "watch", "--file", "plc/P/blocks/Motor.scl", "--json"], { cwd: root, env: {}, stderr() {}, stopSignal,
    stdout: line => { const item = JSON.parse(line); output.push(item);
      if (item.programStatus?.kind === "reconstructed" && !edited) { edited = true; void writeFile(file, 'FUNCTION_BLOCK "Motor"\nVAR_OUTPUT\nCount : Int;\nEND_VAR\nBEGIN\n#Count := #Count + 2;\nEND_FUNCTION_BLOCK'); }
      if (/source changed/i.test(item.programStatus?.reason ?? "")) stop();
    } })).toBe(0);
  expect(edited).toBe(true); expect(output.at(-1).programStatus).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/source changed/i) });
  expect(capture).toHaveBeenCalledOnce();
});
