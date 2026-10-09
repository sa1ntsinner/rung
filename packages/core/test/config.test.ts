// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, formatConfig, parseConfig, preflight, isContained, loadConfig, saveConfig, grantWrites, revokeWrites } from "../src/index.js";

describe("config", () => {
  const liveBase = () => formatConfig(defaultConfig("p", "V20", "", ["PLC_1"]));
  const online = '\n[live.plc.PLC_1]\ntransport = "s7commplus"\naddress = "192.168.250.1"\n';
  it("round trips per-PLC live configuration and defaults to read-only", () => {
    const c = parseConfig(liveBase() + online + 'certificate_sha256 = "' + "AB".repeat(32) + '"\n[live.plc.PLC_1.webapi]\nurl = "https://192.168.250.1"\nuser = "monitor"\n');
    expect(c.live?.plc?.PLC_1).toMatchObject({ transport: "s7commplus", address: "192.168.250.1", allowWrites: false, certificateSha256: "AB".repeat(32) });
    expect(parseConfig(formatConfig(c))).toEqual(c);
  });
  it("keeps legacy Web API and simulator configuration", () => {
    const c = parseConfig(liveBase() + '\n[live.webapi]\nurl = "http://127.0.0.1:8000"\nuser = "sim"\ninsecure = true\n');
    expect(parseConfig(formatConfig(c))).toEqual(c);
  });
  it.each([
    'address = "0192.168.250.1"', 'address = "plc.local"', 'address = "::ffff:192.168.250.1"',
    'allow_writes = "false"', 'certificate_sha256 = "123"', 'transport = "auto"', 'password = "secret"',
    'webapi = { url = "https://192.168.250.2", user = "m" }',
    'webapi = { url = "https://192.168.250.1", user = "m", password = "secret" }',
    'webapi = { url = "https://192.168.250.1", user = "m", insecure = "true" }',
  ])("rejects invalid live configuration: %s", (line) => {
    const initial = online.replace(/\n(address|transport) = [^\n]+/g, (text, key) => line.startsWith(key + " =") ? "" : text);
    expect(() => parseConfig(liveBase() + initial + line + "\n")).toThrow();
  });
  it("rejects an unbound legacy fallback in a multi-PLC workspace", () => {
    const c = defaultConfig("p", "V20", "", ["PLC_1", "PLC_2"]);
    expect(() => parseConfig(formatConfig(c) + '\n[live.webapi]\nurl = "https://192.168.250.1"\nuser = "m"\n')).toThrow(/bind|PLC/i);
  });
  it("round trips an online address", () => {
    const c = defaultConfig("C:/p/Plant.ap21", "V21");
    c.plc.PLC_1 = { mode: "PN/IE", pcInterface: "Ethernet", pcInterfaceNumber: 1, address: "10.0.0.7" };
    expect(parseConfig(formatConfig(c))).toEqual(c);
    expect(() => parseConfig(formatConfig(c).replace('10.0.0.7', '999.0.0.7'))).toThrow(/address/);
  });
  it("round-trips through TOML", () => {
    const c = defaultConfig("C:\\fx\\RungFixture.ap20", "V20", "C:\\tools\\rung-bridge-v20.exe", ["PLC_1"]);
    expect(parseConfig(formatConfig(c))).toEqual(c);
  });
  it("finds the bridge that comes with rung when rung.toml names none", () => {
    const c = defaultConfig("C:\\p\\X.ap20", "V20");
    const text = formatConfig(c);
    expect(text).not.toContain("[bridge]");
    expect(parseConfig(text).bridge).toEqual({ command: "", args: [] });
  });
  it("requires a bound project path", () => {
    expect(() => parseConfig('format = 1\n[project]\ntiaVersion = "V20"\n[bridge]\ncommand = "x"\n')).toThrow(/project.path/);
  });
  it("refuses to disable read-only protection", () => {
    const c = formatConfig(defaultConfig("p", "V20", "b")).replace("failsafe = true", "failsafe = false");
    expect(() => parseConfig(c)).toThrow(/readOnly.failsafe/);
  });
  it("rejects unknown sync modes instead of failing later", () => {
    const c = formatConfig(defaultConfig("p", "V20", "b"));
    expect(() => parseConfig(c.replace('import = "auto"', 'import = "yes"'))).toThrow(/sync.import must be auto or manual/);
    expect(() => parseConfig(c.replace('save = "after-import"', 'save = "sometimes"'))).toThrow(/sync.save/);
    expect(parseConfig(c.replace('save = "after-import"', 'save = "never"')).sync.save).toBe("never");
  });
  it("reports a missing workspace", async () => {
    await expect(loadConfig(mkdtempSync(join(tmpdir(), "rung-cfg-")))).rejects.toMatchObject({ code: "NOT_A_WORKSPACE" });
  });
  it("saves and loads", async () => {
    const d = mkdtempSync(join(tmpdir(), "rung-cfg-"));
    const c = defaultConfig("C:\\p\\X.ap20", "V20", "bridge.exe");
    await saveConfig(d, c);
    expect(await loadConfig(d, { raw: true })).toEqual(c);
  });

  it("reads sync.import as manual until this copy may write into exactly its project", async () => {
    const d = mkdtempSync(join(tmpdir(), "rung-cfg-"));
    const c = defaultConfig("C:\\p\\X.ap20", "V20");
    await saveConfig(d, c);
    // after rung init, and in a fresh clone: .rung/writes.json is not there
    expect((await loadConfig(d)).sync.import).toBe("manual");
    expect((await loadConfig(d)).writesOff).toBe(true);
    await grantWrites(d, c);
    expect(await loadConfig(d)).toEqual(c);
    // the same project in other letter case is the same file on Windows
    await saveConfig(d, { ...c, project: { ...c.project, path: "c:\\P\\x.ap20" } });
    expect((await loadConfig(d)).sync.import).toBe("auto");
    // another project, or the same path on another PC over ssh: not the project the right was given for
    await saveConfig(d, { ...c, project: { ...c.project, path: "C:\\p\\Y.ap20" } });
    expect((await loadConfig(d)).writesOff).toBe(true);
    await saveConfig(d, { ...c, bridge: { ...c.bridge, host: "elmir@tia-pc" } });
    expect((await loadConfig(d)).writesOff).toBe(true);
    // manual in rung.toml stays manual for everyone, without the mark
    await saveConfig(d, { ...c, sync: { ...c.sync, import: "manual" } });
    expect((await loadConfig(d)).writesOff).toBeUndefined();
    await saveConfig(d, c);
    await revokeWrites(d);
    expect((await loadConfig(d)).writesOff).toBe(true);
    // a damaged grant counts as none
    writeFileSync(join(d, ".rung", "writes.json"), "{");
    expect((await loadConfig(d)).writesOff).toBe(true);
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

describe("live config", () => {
  it("accepts a Web API source and refuses stored passwords", () => {
    const base = formatConfig(defaultConfig("C:\\p\\X.ap20", "V20", "b"));
    const withLive = base + '\n[live.webapi]\nurl = "https://192.168.0.1"\nuser = "Administrator"\ninsecure = true\n';
    expect(parseConfig(withLive).live).toEqual({ webapi: { url: "https://192.168.0.1", user: "Administrator", insecure: true } });
    expect(parseConfig(formatConfig(parseConfig(withLive))).live).toEqual(parseConfig(withLive).live);
    expect(() => parseConfig(withLive + 'password = "x"\n')).toThrow(/RUNG_WEBAPI_PASSWORD/);
    expect(() => parseConfig(base + '\n[live.webapi]\nurl = "ftp://x"\nuser = "a"\n')).toThrow(/http/);
  });
});
