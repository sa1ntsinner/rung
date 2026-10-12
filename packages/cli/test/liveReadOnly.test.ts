// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "@rung/core";
import { BridgeClient } from "@rung/bridge-client";
import { cmdLive, webApiFor } from "../src/live.js";
import { onlineHost } from "../src/liveTrust.js";
import * as broker from "../src/liveServer.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture(url = "https://192.168.1.1", readOnly = false) {
  const root = await mkdtemp(join(tmpdir(), "rung-live-lock-"));
  const config = defaultConfig("scratch.ap20", "V20", "", ["P"]);
  config.plc.P = { mode: "PN/IE", pcInterface: "fixture", pcInterfaceNumber: 1, readOnly };
  config.live = { webapi: { url, user: "fixture" } };
  await saveConfig(root, config);
  return { root, config };
}
it("validates the legacy Web API target, admitting protected reads only while locked", async () => {
  const { root, config } = await fixture();
  await expect(broker.liveSelection(root, {})).rejects.toMatchObject({ code: "TARGET_REFUSED" });
  config.plc.P!.readOnly = true; await saveConfig(root, config);
  expect((await broker.liveSelection(root, {})).target).toMatchObject({ address: "192.168.1.1", readOnly: true });
});
it("checks legacy diagnostic targets before creating the Web API client", async () => {
  const { root } = await fixture();
  await expect(webApiFor(root, { RUNG_WEBAPI_PASSWORD: "fixture" })).rejects.toMatchObject({ code: "TARGET_REFUSED" });
});
it.each(["192.168.001.001", "3232235777", "0xc0a80101"])("refuses legacy URL normalization of %s even under the lock", async address => {
  const { root } = await fixture(`https://${address}`, true);
  await expect(broker.liveSelection(root, {})).rejects.toBeInstanceOf(Error);
});
it("refuses per-PLC insecure TLS and HTTP before creating broker processes", async () => {
  const { root, config } = await fixture("https://192.168.250.1", true);
  config.live!.webapi!.insecure = true; await saveConfig(root, config);
  await expect(broker.brokerReader(root, { RUNG_WEBAPI_PASSWORD: "fixture" }, {})).rejects.toMatchObject({ code: "PLC_READ_ONLY" });
  config.live!.webapi = { url: "http://192.168.250.1", user: "fixture" }; await saveConfig(root, config);
  await expect(broker.brokerReader(root, { RUNG_WEBAPI_PASSWORD: "fixture", RUNG_WEBAPI_ALLOW_HTTP: "1" }, {})).rejects.toMatchObject({ code: "PLC_READ_ONLY" });
});
it("refuses direct writer host startup before spawning", async () => {
  const spawn = vi.spyOn(BridgeClient, "spawn").mockRejectedValue(new Error("spawned"));
  await expect(onlineHost({ RUNG_READ_ONLY: "1" }, {} as any)).rejects.toMatchObject({ code: "PLC_READ_ONLY" });
  expect(spawn).not.toHaveBeenCalled();
});
it.each(["modify", "run", "stop"])("guards direct cmdLive %s before the broker, including editor stdin", async sub => {
  const { root } = await fixture("https://192.168.250.1", true);
  const read = vi.spyOn(broker, "brokerReader").mockRejectedValue(new Error("broker started"));
  await expect(cmdLive(root, sub, sub === "modify" ? ["Tag", "1"] : [], { cwd: root, env: {}, stdout() {}, stderr() {} }, { confirmStdin: true, json: true })).rejects.toMatchObject({ code: "PLC_READ_ONLY", message: expect.stringMatching(/read.only lock/) });
  expect(read).not.toHaveBeenCalled();
});
it.each(["env", "plc"])("FB monitoring under the %s lock never automatically captures program status", async lock => {
  const { root } = await fixture("https://192.168.250.1", lock === "plc");
  const dir = join(root, "plc", "P", "blocks"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Motor.scl"), 'FUNCTION_BLOCK "Motor"\nVAR_OUTPUT\nCount : Int;\nEND_VAR\nBEGIN\n#Count := #Count + 1;\nEND_FUNCTION_BLOCK');
  await writeFile(join(dir, "Motor_DB.db"), 'DATA_BLOCK "Motor_DB"\n"Motor"\nBEGIN\nEND_DATA_BLOCK');
  let stop!: () => void;
  const stopSignal = new Promise<void>(resolve => { stop = resolve; });
  const capture = vi.fn(async () => { stop(); throw new Error("automatic capture"); });
  const scope = { device: "P", address: "192.168.250.1", transport: "s7commplus" as const, epoch: 1 };
  vi.spyOn(broker, "brokerReader").mockResolvedValue({ read: async () => [], close: async () => {}, capture,
    subscribe: async (_labels, _cycle, push) => { push({ at: 1, scope, values: { Count: 5 }, errors: {}, observedAt: {}, state: "live" }); return { close: async () => {} }; } });
  const timer = setTimeout(stop, 60);
  try {
    expect(await cmdLive(root, "watch", [], { cwd: root, env: lock === "env" ? { RUNG_READ_ONLY: "1" } : {}, stdout() {}, stderr() {}, stopSignal }, { file: "plc/P/blocks/Motor.scl", json: true })).toBe(0);
    expect(capture).not.toHaveBeenCalled();
  } finally { clearTimeout(timer); }
});
