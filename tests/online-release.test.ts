// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { auditOnlineRelease } from "../tools/release/online.mjs";

it("requires explicit fixture and mutation flags before hardware acceptance", () => {
  for (const [args, message] of [[[], /Pass --fixture/], [["--fixture", "--restart"], /requires --mutate/]] as const) {
    const result = spawnSync(process.execPath, ["tools/online/hardware.mjs", ...args], {
      encoding: "utf8", env: { ...process.env, RUNG_TEST_CERT_SHA256: "0".repeat(64) }, windowsHide: true,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
  }
});

it.skipIf(process.platform !== "win32")("refuses non-fixture identities before loading the PLCSIM API", () => {
  for (const args of [["-Address", "192.168.1.1"], ["-Name", "Other"], ["-Address", "192.168.250.2"]]) {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-File", "tools/online/plcsim-check.ps1", ...args, "-Api", "missing-api.dll"], { encoding: "utf8", windowsHide: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Only local RungProve/);
    expect(result.stderr).not.toMatch(/Add-Type/);
  }
  // three powershell starts: a busy CI runner takes well over the default 20 s
}, 120_000);

it("rejects forbidden binaries, missing licenses and altered corresponding driver source", () => {
  const root = mkdtempSync(join(tmpdir(), "rung-release-test-"));
  const source = join(root, "source", "S7CommPlusDriver"); mkdirSync(join(root, "bridge"), { recursive: true }); mkdirSync(source, { recursive: true });
  cpSync("LICENSES", join(root, "LICENSES"), { recursive: true });
  writeFileSync(join(root, "bridge", "rung-online.exe"), "host");
  writeFileSync(join(root, "bridge", "S7CommPlusDriver.dll"), "driver");
  writeFileSync(join(source, "S7CommPlusDriver.csproj"), "project");
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  writeFileSync(join(source, "MANIFEST.json"), JSON.stringify({ driverSha256: hash("driver"), files: { "S7CommPlusDriver.csproj": hash("project") } }));
  try {
    expect(() => auditOnlineRelease(root)).not.toThrow();
    writeFileSync(join(root, "bridge", "HarpoS7.dll"), "forbidden"); expect(() => auditOnlineRelease(root)).toThrow(/forbidden/i); rmSync(join(root, "bridge", "HarpoS7.dll"));
    writeFileSync(join(root, "bridge", "Siemens.Engineering.dll"), "forbidden"); expect(() => auditOnlineRelease(root)).toThrow(/forbidden/i); rmSync(join(root, "bridge", "Siemens.Engineering.dll"));
    writeFileSync(join(source, "S7CommPlusDriver.csproj"), "changed"); expect(() => auditOnlineRelease(root)).toThrow(/source/i); writeFileSync(join(source, "S7CommPlusDriver.csproj"), "project");
    rmSync(join(root, "LICENSES", "LGPL-3.0.txt")); expect(() => auditOnlineRelease(root)).toThrow(/license/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
