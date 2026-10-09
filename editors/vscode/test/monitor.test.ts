// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { formatValue, lineText, readError, rowValues, reconstructedLines } from "../src/core/monitorText";

describe("monitoring text", () => {
  it("labels native samples as reconstructed and keeps execution unverified", () => {
    const rows = reconstructedLines({ kind: "reconstructed", exact: false, freshness: "native-sample", trace: [
      { uri: "file:///C:/a", line: 3, kind: "statement" }, { uri: "file:///C:/a", line: 3, kind: "expression", value: 3 },
    ], divergences: [] }, "file:///C:/a");
    expect(rows[0]).toMatch(/native sample.*PLC execution unverified/i);
    expect(rows[2]).toBe("reconstructed: executed · 3");
  });
  it("labels captured execution and divergence separately and excludes another source", () => {
    const rows = reconstructedLines({ kind: "reconstructed", exact: false, freshness: "capture-only", trace: [
      { uri: "file:///C:/a", line: 3, kind: "statement" }, { uri: "file:///C:/a", line: 3, kind: "expression", value: false },
      { uri: "file:///C:/b", line: 3, kind: "expression", value: 99 },
    ], divergences: [{ path: "COUNT", reconstructed: 5, observed: 6 }] }, "file:///C%3A/a");
    expect(rows[2]).toBe("reconstructed: executed · FALSE");
    expect(rows[0]).toMatch(/historical capture.*1 divergence/i);
    expect(JSON.stringify(rows)).not.toContain("99");
    expect(() => reconstructedLines({ kind: "unavailable", reason: "missing state" }, "file:///a")).toThrow(/missing state/);
  });
  it("preserves typed REAL zero in inline and declaration values while integers stay integers", () => {
    const values = { speed: 0, count: 0, "samples[0]": 0 };
    const display = { speed: "0.0", "samples[0]": "0.0" };
    expect(lineText(["speed", "count"], values, {}, display)).toBe("speed = 0.0   count = 0");
    expect(lineText(["speed"], values, { speed: "unreadable" }, display)).toBe("speed = ?");
    expect(rowValues([{ rows: [{ id: "s", name: "speed" }, { id: "c", name: "count" }, { id: "a", name: "samples" }] }],
      { vars: { speed: "x", count: "y", "samples[0]": "z" } }, values, {}, display)).toEqual({ s: "0.0", c: "0", a: "[0.0]" });
  });
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
