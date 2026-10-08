// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { sparkline } from "../src/core/sparkline";

describe("sparkline", () => {
  it("scales numbers between their extremes, shows booleans low and high, and needs two plain values", () => {
    expect(sparkline([0, 50, 100])).toBe("▁▅█");
    expect(sparkline([false, true, false])).toBe("▁█▁");
    expect(sparkline([7, 7])).toBe("▁▁");
    expect(sparkline([1])).toBe("");
    expect(sparkline([1, "x"])).toBe("");
  });
});
