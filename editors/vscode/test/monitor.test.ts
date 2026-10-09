// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { formatValue, lineText, readError, rowValues } from "../src/core/monitorText";

describe("monitoring text", () => {
  it("reads like TIA Portal's monitoring: TRUE/FALSE, short reals, quoted strings", () => {
    expect([true, false, 42, 12.345678901, 1e-7, "on", undefined].map(formatValue)).toEqual(["TRUE", "FALSE", "42", "12.3457", "1e-7", "'on'", "…"]);
  });
  it("lists a line's values without the # and marks what could not be read", () => {
    expect(lineText(["#Lit", "#On", '"Plant".speed'], { "#Lit": true, "#On": false, '"Plant".speed': 2.5 }, { "#On": "2: Address does not exist" })).toBe('Lit = TRUE   On = ?   "Plant".speed = 2.5');
  });
  it("says a read error in words, without the Web API's code number", () => {
    expect(readError("200: Address does not exist: not a variable name")).toBe("not in the PLC's program (a typo, or not downloaded yet): not a variable name");
    expect(readError("2: Permission denied")).toBe("Permission denied");
  });
  it("gives each declaration row its value by its path of names, … until read, ? when unreadable", () => {
    const sections = [{ rows: [{ id: "s/Ready", name: "Ready" }, { id: "s/Motor", name: "Motor", children: [{ id: "s/Motor/Speed", name: "Speed" }, { id: "s/Motor/Set", name: "Set" }] }, { id: "s/Big", name: "Big" }] }];
    const plan = { vars: { Ready: "x", "Motor.Speed": "y", "Motor.Set": "z" } };
    expect(rowValues(sections, plan, { Ready: true, "Motor.Speed": 7 }, { "Motor.Set": "unreadable" })).toEqual({ "s/Ready": "TRUE", "s/Motor/Speed": "7", "s/Motor/Set": "?" });
    expect(rowValues(sections, plan, {}, {})).toEqual({ "s/Ready": "…", "s/Motor/Speed": "…", "s/Motor/Set": "…" });
    // an array row: its page of elements
    expect(rowValues([{ rows: [{ id: "s/Small", name: "Small" }] }], { vars: { "Small[1]": "", "Small[2]": "" } }, { "Small[1]": 4, "Small[2]": 5 }, {})).toEqual({ "s/Small": "[4, 5]" });
  });
});
