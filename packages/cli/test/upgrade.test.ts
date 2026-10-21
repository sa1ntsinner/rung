// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { olderProjectHint, retrievePlan, unlistedBridge, upgradePlan } from "../src/upgrade.js";

describe("rung upgrade: an older project upgraded next to it", () => {
  it("upgrades a copy in a staging folder and puts the result next to the original, named as TIA Portal names it", () => {
    const file = join("D:", "plc", "Line", "Line.ap18");
    expect(upgradePlan(file, "V20", 7)).toEqual({ from: 18, to: "V20", folder: join("D:", "plc", "Line"), staging: join("D:", "plc", ".rung-upgrade-7"),
      file: join("D:", "plc", ".rung-upgrade-7", "Line", "Line.ap18"), target: join("D:", "plc", "Line_V20") });
  });
  it("refuses what needs no upgrade and what is no project file", () => {
    expect(() => upgradePlan("Line.ap20", "V20", 1)).toThrow(/already/);
    expect(() => upgradePlan("Line.ap21", "V20", 1)).toThrow(/already/);
    expect(() => upgradePlan("Line.zap18", "V20", 1)).toThrow(/rung retrieve/);
    expect(() => upgradePlan("Line.txt", "V20", 1)).toThrow(/project file/);
  });
  it("tells rung init what to do with a project older than V18, and opens V18 itself", () => {
    expect(olderProjectHint("D:/plc/Line/Line.ap17")).toMatch(/TIA Portal V17 project.*rung upgrade/s);
    expect(olderProjectHint("D:/plc/Line/Line.ap18")).toBeUndefined();
    expect(olderProjectHint("D:/plc/Line/Line.ap20")).toBeUndefined();
  });
  it("reads TIA Portal V15.1's .ap15_1 and .zap15_1 as version 15", () => {
    expect(olderProjectHint("D:/plc/Line/Line.ap15_1")).toMatch(/TIA Portal V15 project/);
    expect(retrievePlan(join("D:", "plc", "Line.zap15_1"), undefined)).toMatchObject({ from: 15, to: "V20", upgrade: true, target: join("D:", "plc", "Line") });
    expect(() => upgradePlan("Line.zap15_1", "V20", 1)).toThrow(/rung retrieve/);
  });
});

describe("the Openness access question a TIA Portal without window cannot show", () => {
  it("refuses an unlisted bridge at once, also one named by RUNG_BRIDGE", () => {
    expect(unlistedBridge("C:/x/rung-bridge-v20.exe", false, "missing")).toBe(true);
    expect(unlistedBridge("C:/x/rung-bridge-v20.exe", false, "ok")).toBe(false);
    expect(unlistedBridge("C:/dev/rung-bridge-v20.exe", true, "stale")).toBe(true);
    expect(unlistedBridge("C:/dev/rung-bridge-v20.exe", true, "ok")).toBe(false);
    expect(unlistedBridge("C:/dev/Rung.Bridge.V20.dll", true, "missing")).toBe(false);
  });
});
