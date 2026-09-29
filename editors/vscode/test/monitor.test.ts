// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { formatValue, lineText } from "../src/core/monitorText";

describe("monitoring text", () => {
  it("reads like TIA Portal's monitoring: TRUE/FALSE, short reals, quoted strings", () => {
    expect([true, false, 42, 12.345678901, 1e-7, "on", undefined].map(formatValue)).toEqual(["TRUE", "FALSE", "42", "12.3457", "1e-7", "'on'", "…"]);
  });
  it("lists a line's values without the # and marks what could not be read", () => {
    expect(lineText(["#Lit", "#On", '"Plant".speed'], { "#Lit": true, "#On": false, '"Plant".speed': 2.5 }, { "#On": "2: Address does not exist" })).toBe('Lit = TRUE   On = ?   "Plant".speed = 2.5');
  });
});
