// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPlcWritable, defaultConfig, formatConfig, grantWrites, loadConfig, parseConfig, plcReadOnly, saveConfig } from "../src/index.js";

afterEach(() => vi.unstubAllEnvs());
it.each(["plc", "live.plc"])("round trips and enforces [%s.P].read_only", section => {
  const base = formatConfig(defaultConfig("scratch.ap20", "V20", "", ["P"]));
  const fields = section === "plc" ? 'mode = "PN/IE"\npc_interface = "fixture"' : 'transport = "s7commplus"\naddress = "192.168.1.1"\nallow_writes = true';
  const config = parseConfig(base + `\n[${section}.P]\n${fields}\nread_only = true\n`);
  expect(plcReadOnly(config, "P")).toMatch(/P.*read_only/);
  expect(() => assertPlcWritable(config, "P")).toThrowError(expect.objectContaining({ code: "PLC_READ_ONLY" }));
  expect(parseConfig(formatConfig(config))).toEqual(config);
  expect(() => parseConfig(base + `\n[${section}.P]\n${fields}\nread_only = "true"\n`)).toThrow(/read_only/);
});
it("the process lock cannot be cleared by supplied env or workspace permissions", async () => {
  vi.stubEnv("RUNG_READ_ONLY", "1");
  const root = await mkdtemp(join(tmpdir(), "rung-lock-"));
  const config = defaultConfig("scratch.ap20", "V20", "", ["P"]);
  config.plc.P = { mode: "PN/IE", pcInterface: "fixture", pcInterfaceNumber: 1, readOnly: false };
  await saveConfig(root, config); await grantWrites(root, config);
  expect(plcReadOnly(config, "P", { RUNG_READ_ONLY: "0" })).toBe("RUNG_READ_ONLY=1");
  expect((await loadConfig(root)).sync.import).toBe("manual");
  expect(() => assertPlcWritable(config, "P", {})).toThrowError(expect.objectContaining({ code: "PLC_READ_ONLY" }));
});
it("a lock in either PLC table wins over false in the other", () => {
  const config = defaultConfig("scratch.ap20", "V20", "", ["P", "Q"]);
  config.plc.P = { mode: "PN/IE", pcInterface: "fixture", pcInterfaceNumber: 1, readOnly: true };
  config.live = { plc: { P: { transport: "s7commplus", address: "192.168.1.1", allowWrites: true, readOnly: false } } };
  expect(plcReadOnly(config, "P", {})).toMatch(/read_only/);
  expect(plcReadOnly(config, undefined, {})).toMatch(/read_only/);
  expect(plcReadOnly(config, "Q", {})).toBeUndefined();
});
