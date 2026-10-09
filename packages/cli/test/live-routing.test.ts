// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "@rung/core";
import { main } from "../src/main.js";
import * as broker from "../src/liveServer.js";
import * as trust from "../src/liveTrust.js";
import { PassThrough } from "node:stream";

afterEach(() => vi.restoreAllMocks());

it("releases the editor subscription on parent stdin EOF without stopping the shared broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-parent-watch-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["P"]);
  config.live = { plc: { P: { transport: "s7commplus", address: "192.168.250.1", certificateSha256: "a".repeat(64) } } };
  await saveConfig(root, config);
  const input = new PassThrough(); vi.spyOn(process, "stdin", "get").mockReturnValue(input as typeof process.stdin);
  const release = vi.fn(async () => {}), close = vi.fn(async () => {});
  vi.spyOn(broker, "brokerReader").mockResolvedValue({ read: async () => [], close,
    subscribe: async () => { input.end(); return { close: release }; },
  });
  const errors: string[] = [];
  expect(await main(["live", "watch", '"DB".x', "--json", "--parent-stdio"], { cwd: root, env: {}, stdout() {}, stderr: s => errors.push(s) })).toBe(0);
  expect(errors).toEqual([]); expect(release).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});
it("rebuilds the table subscription after an XML edit without saving or importing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-live-table-edit-")), dir = join(root, "plc", "P", "watch");
  await saveConfig(root, defaultConfig("fixture.ap20", "V20", "", ["P"]));
  await mkdir(dir, { recursive: true });
  const file = join(dir, "Watch.xml"); await writeFile(file, "first");
  vi.spyOn(trust, "onlineHost").mockResolvedValue({ async request(method: string, params: { xml: string }) {
    expect(method).toBe("online.watchTable");
    return { name: "Watch", rows: [{ key: "row:1", name: params.xml, comments: {} }] };
  }, close: async () => {} } as never);
  let stop!: () => void; const stopSignal = new Promise<void>(r => { stop = r; });
  const close = vi.fn(async () => {}), subscribed: string[] = [];
  vi.spyOn(broker, "brokerReader").mockResolvedValue({ read: async () => [], close: async () => {},
    subscribe: async labels => { subscribed.push(labels["row:1"]!);
      if (subscribed.length === 1) await writeFile(file, "second"); else stop();
      return { close };
    },
  });
  expect(await main(["live", "watch", "--table", "plc/P/watch/Watch.xml", "--json"], { cwd: root, env: {}, stdout() {}, stderr() {}, stopSignal })).toBe(0);
  expect(subscribed).toEqual(["first", "second"]);
  expect(close).toHaveBeenCalledTimes(2);
});
it("watches a table with duplicate symbols and row errors without applying its modify values", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-live-table-")), dir = join(root, "plc", "P", "watch");
  await saveConfig(root, defaultConfig("fixture.ap20", "V20", "", ["P"]));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Watch.xml"), "xml");
  const requests: string[] = [], out: string[] = [];
  vi.spyOn(trust, "onlineHost").mockResolvedValue({ async request(method: string) {
    requests.push(method);
    return { name: "Watch", rows: [{ key: "row:1", name: '"DB".x', modifyValue: "17", comments: {} }, { key: "row:2", name: '"DB".x', comments: {} }, { key: "row:3", address: "%MW2", comments: {} }] };
  }, close: async () => {} } as never);
  let stop!: () => void;
  const stopSignal = new Promise<void>(r => { stop = r; });
  const subscribe = vi.fn(async (labels, _cycle, callback) => {
    callback({ at: 1, values: { "row:1": 4, "row:2": 4 }, errors: {}, observedAt: { "row:1": 1, "row:2": 1 }, scope: { device: "P", address: "192.168.250.1", transport: "s7commplus", epoch: 1 }, state: "live" });
    stop(); return { close: async () => {} };
  });
  vi.spyOn(broker, "brokerReader").mockResolvedValue({ read: async () => [], subscribe, close: async () => {} });
  const errors: string[] = [];
  const code = await main(["live", "watch", "--table", "plc/P/watch/Watch.xml", "--device", "P", "--json"], { cwd: root, env: {}, stdout: s => out.push(s), stderr: s => errors.push(s), stopSignal });
  expect(errors).toEqual([]);
  expect(code).toBe(0);
  expect(requests).toEqual(["online.watchTable"]);
  expect(subscribe.mock.calls[0][0]).toEqual({ "row:1": '"DB".x', "row:2": '"DB".x' });
  expect(JSON.parse(out[1]!)).toMatchObject({ values: { "row:1": 4, "row:2": 4 }, errors: { "row:3": expect.stringContaining("verified mapping") } });
});
it("emits structured instance choices before opening a PLC connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-live-instance-")), dir = join(root, "plc", "P", "blocks");
  await saveConfig(root, defaultConfig("fixture.ap20", "V20", "", ["P"]));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Motor.scl"), 'FUNCTION_BLOCK "Motor"\nVAR_INPUT\nRun : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n');
  for (const name of ["A", "B"]) await writeFile(join(dir, `${name}.db`), `DATA_BLOCK "${name}"\n"Motor"\nBEGIN\nEND_DATA_BLOCK\n`);
  const open = vi.spyOn(broker, "brokerReader"), out: string[] = [];
  const code = await main(["live", "watch", "--file", "plc/P/blocks/Motor.scl", "--json"], { cwd: root, env: {}, stdout: s => out.push(s), stderr() {} });
  expect(code).toBe(1);
  expect(JSON.parse(out.join(""))).toMatchObject({ error: { code: "NO_INSTANCE", details: { instances: ["A", "B"] } } });
  expect(open).not.toHaveBeenCalled();
});
it("routes selected native reads and preserves typed display in text and scoped JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-live-route-"));
  await saveConfig(root, defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]));
  const frame = { at: 1, scope: { device: "PLC_1", address: "192.168.250.1", transport: "s7commplus" as const, epoch: 3 }, items: [{ name: "x", value: 0, type: "REAL", display: "0.0", observedAt: 1 }] };
  const close = vi.fn(async () => {});
  const open = vi.spyOn(broker, "brokerReader").mockResolvedValue({ read: async () => frame.items, readFrame: async () => frame, close });
  const out: string[] = [], errors: string[] = [];
  const io = { cwd: root, env: {}, stdout: (s: string) => out.push(s), stderr: (s: string) => errors.push(s) };
  expect(await main(["live", "read", "x", "--device", "PLC_1", "--transport", "s7commplus"], io)).toBe(0);
  expect(open).toHaveBeenCalledWith(root, {}, expect.objectContaining({ device: "PLC_1", transport: "s7commplus" }));
  expect(out.join("")).toBe("x  0.0\n");
  out.length = 0;
  expect(await main(["live", "read", "x", "--json"], io)).toBe(0);
  expect(JSON.parse(out.join(""))).toEqual(frame);
  expect(errors).toEqual([]);
  expect(close).toHaveBeenCalledTimes(2);
});
