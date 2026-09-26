// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { Args, describeDownload, downloadArgs, effectiveDownload, parseCompileOutput, parseInterfaces, parseNeedsAllow, parseOnlineState, parseRefused, type DownloadOptions } from "../src/core/args";
import { DOWNLOAD_DEFAULTS } from "../src/core/rungToml";

const base: DownloadOptions = { device: "PLC_1", hardware: "rungToml", software: true, allBlocks: false, startAfter: true, allow: [] };

describe("downloadArgs", () => {
  it("always passes --yes and the PLC, nothing else by default", () => {
    expect(downloadArgs(base)).toEqual(["download", "--yes", "--plc", "PLC_1"]);
  });

  it("maps every option to its flag", () => {
    expect(downloadArgs({ ...base, hardware: "include", allBlocks: true, startAfter: false, allow: ["stop-cpu"] })).toEqual([
      "download", "--yes", "--plc", "PLC_1", "--hw", "--all-blocks", "--no-start", "--allow", "stop-cpu",
    ]);
    expect(downloadArgs({ ...base, hardware: "exclude" })).toContain("--no-hw");
    expect(downloadArgs({ ...base, hardware: "include", software: false })).toEqual(["download", "--yes", "--plc", "PLC_1", "--hw", "--no-sw"]);
  });

  it("splits, lower-cases and dedupes --allow", () => {
    const a = downloadArgs({ ...base, allow: ["stop-cpu,reinit-db", "STOP-CPU", " "] });
    expect(a.slice(4)).toEqual(["--allow", "stop-cpu", "--allow", "reinit-db"]);
  });

  it("refuses odd --allow names and empty downloads", () => {
    expect(() => downloadArgs({ ...base, allow: ["stop-cpu; rm -rf"] })).toThrow(/invalid --allow/);
    expect(() => downloadArgs({ ...base, software: false, hardware: "exclude" })).toThrow(/nothing to download/);
    expect(() => downloadArgs({ ...base, device: "" })).toThrow();
  });
});

describe("effectiveDownload / describeDownload", () => {
  it("applies rung.toml defaults like the CLI", () => {
    const toml = { ...DOWNLOAD_DEFAULTS, hardware: true, startAfter: false, allow: ["reinit-db"] };
    expect(effectiveDownload(base, toml)).toMatchObject({ hardware: true, onlyChanges: true, startAfter: false, allow: ["reinit-db"] });
    expect(effectiveDownload({ ...base, hardware: "exclude", allBlocks: true, allow: ["stop-cpu"] }, toml)).toMatchObject({ hardware: false, onlyChanges: false, allow: ["reinit-db", "stop-cpu"] });
  });

  it("names the PLC, the payload and the connection", () => {
    const d = describeDownload({ ...base, hardware: "include" }, DOWNLOAD_DEFAULTS, { mode: "PN/IE", pcInterface: "Intel(R) Ethernet", pcInterfaceNumber: 1, targetInterface: "1 X1" });
    expect(d.message).toBe("Download to PLC_1?");
    expect(d.detail).toContain("software (changes only) + hardware configuration");
    expect(d.detail).toContain("Intel(R) Ethernet → 1 X1 (PN/IE)");
    expect(d.detail).toMatch(/answered "yes": none/);
  });
});

describe("CLI output parsers", () => {
  const cancelled = [
    "compile: ok",
    "",
    "Download software (changes) to PLC_1 via Intel / 1 X1.",
    "  ✓ pre  consistent-download        ConsistentDownload",
    "  ✗ pre  stop-cpu                   NoAction  (The modules are stopped for the download.)",
    "  ✗ pre  reinit-db                  NoAction",
    "",
    "TIA Portal cancelled the download: it asked questions rung may not answer on its own.",
    "If that is what you want, run again with --allow stop-cpu,reinit-db",
  ].join("\n");

  it("reads what to allow after a cancelled download", () => {
    expect(parseNeedsAllow(cancelled)).toEqual(["stop-cpu", "reinit-db"]);
    expect(parseNeedsAllow("download: Success (errors 0, warnings 0)")).toEqual([]);
    expect(parseRefused(cancelled)).toEqual([{ name: "stop-cpu", message: "The modules are stopped for the download." }, { name: "reinit-db" }]);
  });

  it("reads the online state", () => {
    expect(parseOnlineState("PLC_1: Online\n")).toEqual({ device: "PLC_1", state: "Online" });
    expect(parseOnlineState("rung: CONFIG_INVALID: x\nhint: y\n")).toBeUndefined();
  });

  it("reads compile messages with file lines", () => {
    const out = ["  error    plc/PLC_1/blocks/Main.scl:12 — Tag \"x\" is not defined", "  warning  plc:PLC_1/blocks/Other — unused", "  info     done", "compile: 1 error(s)"].join("\n");
    expect(parseCompileOutput(out)).toEqual([
      { severity: "error", file: "plc/PLC_1/blocks/Main.scl", line: 12, message: 'Tag "x" is not defined' },
      { severity: "warning", where: "plc:PLC_1/blocks/Other", message: "unused" },
      { severity: "info", message: "done" },
    ]);
  });

  it("reads interfaces with targets and reachable devices", () => {
    const out = [
      "PLC_1: a connection is configured in TIA Portal",
      "",
      'mode "PN/IE"',
      '  pc_interface "Intel(R) Ethernet" (number 1)  targets: "1 X1", "2 X2"',
      "      reachable: PLC_1 192.168.0.1 S7-1500",
      '  pc_interface "PLCSIM" (number 1)',
      "",
      'mode "MPI"',
      '  pc_interface "CP5711" (number 2)  targets: "MPI"',
    ].join("\n");
    expect(parseInterfaces(out)).toEqual([
      { mode: "PN/IE", pcInterface: "Intel(R) Ethernet", pcInterfaceNumber: 1, targetInterface: "1 X1", reachable: ["PLC_1 192.168.0.1 S7-1500"] },
      { mode: "PN/IE", pcInterface: "Intel(R) Ethernet", pcInterfaceNumber: 1, targetInterface: "2 X2", reachable: ["PLC_1 192.168.0.1 S7-1500"] },
      { mode: "MPI", pcInterface: "CP5711", pcInterfaceNumber: 2, targetInterface: "MPI", reachable: [] },
    ]);
  });
});

describe("Args", () => {
  it("builds the simple commands like the Zed tasks", () => {
    expect(Args.compileFile("plc/A/blocks/M.scl", "A")).toEqual(["compile", "--file", "plc/A/blocks/M.scl", "--plc", "A"]);
    expect(Args.compileHardware()).toEqual(["compile", "--hw"]);
    expect(Args.testBlock("Valve")).toEqual(["test", "--filter", "Valve"]);
    expect(Args.offline("A")).toEqual(["online", "--off", "--plc", "A"]);
    expect(Args.interfaces("A")).toEqual(["interfaces", "--scan", "--plc", "A"]);
    expect(Args.resolve("plc/A/blocks/M.scl.conflict", "ours")).toEqual(["resolve", "plc/A/blocks/M.scl", "--ours"]);
  });
});
