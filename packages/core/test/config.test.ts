// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, formatConfig, parseConfig, preflight, isContained, loadConfig, saveConfig } from "../src/index.js";

describe("config", () => {
  it("round-trips through TOML", () => {
    const c = defaultConfig("C:\\fx\\RungFixture.ap20", "V20", "C:\\tools\\rung-bridge-v20.exe", ["PLC_1"]);
    expect(parseConfig(formatConfig(c))).toEqual(c);
  });
  it("requires a bound project path", () => {
    expect(() => parseConfig('format = 1\n[project]\ntiaVersion = "V20"\n[bridge]\ncommand = "x"\n')).toThrow(/project.path/);
  });
  it("refuses to disable read-only protection", () => {
    const c = formatConfig(defaultConfig("p", "V20", "b")).replace("failsafe = true", "failsafe = false");
    expect(() => parseConfig(c)).toThrow(/readOnly.failsafe/);
  });
  it("reports a missing workspace", async () => {
    await expect(loadConfig(mkdtempSync(join(tmpdir(), "rung-cfg-")))).rejects.toMatchObject({ code: "NOT_A_WORKSPACE" });
  });
  it("saves and loads", async () => {
    const d = mkdtempSync(join(tmpdir(), "rung-cfg-"));
    const c = defaultConfig("C:\\p\\X.ap20", "V20", "bridge.exe");
    await saveConfig(d, c);
    expect(await loadConfig(d)).toEqual(c);
  });
});

describe("preflight", () => {
  it("drops every member of a case collision", () => {
    const r = preflight("C:\\w", [
      { address: "a", stem: "plc/P/blocks/Motor" },
      { address: "b", stem: "plc/P/blocks/MOTOR" },
      { address: "c", stem: "plc/P/blocks/Valve" },
    ]);
    expect(r.ok.map((p) => p.address)).toEqual(["c"]);
    expect(r.collisions).toHaveLength(1);
  });
  it.runIf(process.platform === "win32")("flags paths beyond MAX_PATH", () => {
    const r = preflight("C:\\w", [{ address: "a", stem: "plc/P/blocks/" + "x".repeat(250) }]);
    expect(r.tooLong).toHaveLength(1);
  });
});

describe("isContained", () => {
  it("accepts paths inside and rejects junction escapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-root-"));
    const outside = mkdtempSync(join(tmpdir(), "rung-out-"));
    mkdirSync(join(root, "plc"));
    expect(await isContained(root, join(root, "plc", "P", "x.scl"))).toBe(true);
    symlinkSync(outside, join(root, "plc", "evil"), "junction");
    expect(await isContained(root, join(root, "plc", "evil", "x.scl"))).toBe(false);
  });
});
