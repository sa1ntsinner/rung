// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { olderProjectHint, upgradePlan } from "../src/upgrade.js";

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
  it("tells rung init what to do with a project older than V19", () => {
    expect(olderProjectHint("D:/plc/Line/Line.ap18")).toMatch(/TIA Portal V18 project.*rung upgrade/s);
    expect(olderProjectHint("D:/plc/Line/Line.ap20")).toBeUndefined();
  });
});
