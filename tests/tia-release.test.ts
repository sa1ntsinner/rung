// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("discovers optional adapters at the installed Openness framework paths", async () => {
  const { installedTiaVersions } = await import("../tools/release/bridges.mjs");
  const programs = mkdtempSync(join(tmpdir(), "rung-tia-api-"));
  expect(installedTiaVersions(programs)).toEqual(["V20"]);
  for (const [version, framework] of [["V19", ""], ["V21", "net48"]]) {
    const api = join(programs, "Siemens", "Automation", `Portal ${version}`, "PublicAPI", version!, framework!);
    mkdirSync(api, { recursive: true });
    writeFileSync(join(api, version === "V21" ? "Siemens.Engineering.Base.dll" : "Siemens.Engineering.dll"), "installed API");
  }
  expect(installedTiaVersions(programs)).toEqual(["V20", "V19", "V21"]);
});

it("stages each selected TIA adapter, its config and shared dependencies", async () => {
  const { stageBridges } = await import("../tools/release/bridges.mjs");
  const root = mkdtempSync(join(tmpdir(), "rung-tia-release-"));
  const stage = join(root, "stage");
  mkdirSync(join(stage, "bridge"), { recursive: true });
  for (const version of ["V19", "V20", "V21"]) {
    const bin = join(root, "bridge", "src", `Rung.Bridge.${version}`, "bin", "Release", "net48");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, `rung-bridge-${version.toLowerCase()}.exe`), version);
    writeFileSync(join(bin, `rung-bridge-${version.toLowerCase()}.exe.config`), "config");
    writeFileSync(join(bin, "Rung.Bridge.Core.dll"), "shared");
    writeFileSync(join(bin, "debug.pdb"), "debug");
  }
  stageBridges(root, stage, ["V19", "V20", "V21"]);
  for (const version of ["V19", "V20", "V21"]) expect(readFileSync(join(stage, "bridge", `rung-bridge-${version.toLowerCase()}.exe`), "utf8")).toBe(version);
  expect(existsSync(join(stage, "bridge", "debug.pdb"))).toBe(false);
  expect(() => stageBridges(root, stage, ["V18"])).toThrow(/adapter/);
});
