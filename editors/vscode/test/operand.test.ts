// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { lastDot, splitPath } from "../src/core/operand";

describe("operands as TIA Portal writes them", () => {
  it("finds the dots quotes do not hide", () => {
    expect(lastDot('"Line.DB".Pos.x')).toBe(13);
    expect(lastDot('"Line.DB"')).toBe(-1);
    expect(lastDot('"Line_DB".')).toBe(9);
    expect(splitPath('"Line.DB".Pos')).toEqual(["Line.DB", "Pos"]);
    expect(splitPath("Start_PB")).toEqual(["Start_PB"]);
  });
});
