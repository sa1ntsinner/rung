// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, it, vi } from "vitest";
import { defaultConfig } from "@rung/core";
import { S7CommPlusClient, selectLiveTarget, validateLiveAddress, WebApiClient, plainHttpRefusal } from "../src/index.js";
import { MutationPolicy } from "../src/policy.js";

afterEach(() => vi.unstubAllEnvs());
it("the shared mutation policy refuses preparation and commitment under the environment lock", async () => {
  const current = vi.fn(async () => ({ workspace: "fixture", device: "P", address: "192.168.250.1", certificateSha256: "A".repeat(64), cpu: "CPU", serial: "fixture", plcName: "Fixture", epoch: 1, programRevision: "program", configRevision: "config", allowWrites: true }));
  const send = vi.fn(), policy = new MutationPolicy(current, send);
  const prepared = await policy.prepare({ action: "run" });
  current.mockClear(); vi.stubEnv("RUNG_READ_ONLY", "1");
  await expect(policy.prepare({ action: "stop" })).rejects.toMatchObject({ code: "PLC_READ_ONLY" });
  await expect(policy.commit(prepared.operationId, prepared.preview, true)).rejects.toMatchObject({ code: "PLC_READ_ONLY" });
  expect(current).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});
it("admits any canonical address for reads, and the lock refuses mutations", async () => {
  expect(() => validateLiveAddress("192.168.1.1")).not.toThrow();
  expect(() => validateLiveAddress("192.168.1.1", { mutation: true })).not.toThrow();
  vi.stubEnv("RUNG_READ_ONLY", "1");
  expect(() => validateLiveAddress("192.168.1.1")).not.toThrow();
  expect(() => validateLiveAddress("192.168.1.1", { mutation: true })).toThrowError(expect.objectContaining({ code: "PLC_READ_ONLY" }));
  const request = vi.fn(async () => ({}));
  await new S7CommPlusClient({ request }).connect({ device: "P", address: "192.168.1.1", certificateSha256: "A".repeat(64) });
  expect(request).toHaveBeenCalledOnce();
});
it.each(["192.168.01.001", "::ffff:192.168.1.1", "192.168.001.1"])("refuses the non-canonical address %s", address => {
  vi.stubEnv("RUNG_READ_ONLY", "1");
  expect(() => validateLiveAddress(address)).toThrow();
});
it("admits a locked PLC selected from either table", () => {
  const config = defaultConfig("scratch.ap20", "V20", "", ["P"]);
  config.plc.P = { mode: "PN/IE", pcInterface: "fixture", pcInterfaceNumber: 1, readOnly: true };
  config.live = { plc: { P: { transport: "s7commplus", address: "192.168.1.1", allowWrites: true } } };
  expect(selectLiveTarget(config).target.readOnly).toBe(true);
  config.live.plc!.P!.webapi = { url: "https://3232235777", user: "fixture" };
  expect(() => selectLiveTarget(config)).toThrow();
});
it.each([{ url: "https://192.168.250.1", insecure: true }, { url: "http://192.168.250.1" }])("refuses unsafe Web API transport before any request: %j", opts => {
  vi.stubEnv("RUNG_READ_ONLY", "1"); vi.stubEnv("RUNG_WEBAPI_ALLOW_HTTP", "1");
  expect(() => new WebApiClient({ ...opts, user: "fixture", password: "fixture" })).toThrowError(expect.objectContaining({ code: "PLC_READ_ONLY" }));
});
it("the HTTP override cannot bypass the lock, while loopback remains available", () => {
  expect(plainHttpRefusal("http://192.168.250.1", { RUNG_READ_ONLY: "1", RUNG_WEBAPI_ALLOW_HTTP: "1" })).toMatch(/RUNG_READ_ONLY/);
  vi.stubEnv("RUNG_READ_ONLY", "1");
  expect(plainHttpRefusal("http://192.168.250.1", { RUNG_READ_ONLY: "0", RUNG_WEBAPI_ALLOW_HTTP: "1" })).toMatch(/RUNG_READ_ONLY/);
  expect(plainHttpRefusal("http://127.0.0.1", {})).toBeUndefined();
});
