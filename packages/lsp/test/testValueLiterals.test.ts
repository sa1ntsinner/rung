// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { valueProblem } from "../src/index.js";

describe("values in a test, as TIA Portal writes them", () => {
  it("takes 16#, 2# and typed literals for whole numbers, as rung test reads them", () => {
    expect([valueProblem("Word", "16#00F3"), valueProblem("Byte", "2#0000_0101"), valueProblem("Int", "INT#16#7F"), valueProblem("Int", "-5")]).toEqual([undefined, undefined, undefined, undefined]);
    expect(valueProblem("Byte", "16#100")).toBe("16#100 does not fit an Byte (0 to 255).");
    expect(valueProblem("Int", "12A")).toBe("Int takes a whole number.");
  });
});
