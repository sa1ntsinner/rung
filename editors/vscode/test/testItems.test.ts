// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { casesIn, failureText, noTestsHint, parseResults } from "../src/core/testItems";

describe("test explorer model", () => {
  it("shows the no-tests hint from the CLI exit code, with both filter match rules", () => {
    expect(noTestsHint("Plant_DB", 3)).toBe("No tests for Plant_DB. --filter matches a test path substring or the exact block name. Add tests/Plant_DB.test.yaml with block: Plant_DB.");
    for (const code of [0, 1, 2, null]) expect(noTestsHint("Plant_DB", code)).toBeUndefined();
  });
  it("finds the cases of a test file, block and flow style, with their lines", () => {
    const text = [
      "block: Fx_Motor # the FB",
      "cycle: 10ms",
      "cases:",
      "  - name: starts, latches and stops",
      "    steps:",
      "      - set: { Start: true }",
      "      - { cycle: 1, expect: { Running: true } }",
      "  - { name: 'clamps', steps: [{ cycle: 1 }] }",
      "  - steps:",
      "      - cycle: 1",
      '  - name: "quoted # not a comment"  # a comment',
      "plc: PLC_1",
      "  - name: not a case",
    ].join("\n");
    expect(casesIn(text)).toEqual([
      { name: "starts, latches and stops", line: 3 },
      { name: "clamps", line: 7 },
      { name: "case 3", line: 8 },
      { name: "quoted # not a comment", line: 10 },
    ]);
    expect(casesIn("block: X\n")).toEqual([]);
  });

  it("reads rung test --json out of the process output, warnings before it included", () => {
    const json = JSON.stringify({ files: [{ file: "tests/a.test.yaml", block: "A", cases: [{ name: "x", passed: true, failures: [], ms: 1, line: 4 }] }] }, null, 2);
    expect(parseResults(`rung: note: something\n${json}\n`)?.[0]?.cases[0]?.line).toBe(4);
    expect(parseResults("FAIL something")).toBeUndefined();
    expect(parseResults("{ not json }")).toBeUndefined();
  });

  it("shows a failure like the terminal does, with both values for the diff", () => {
    expect(failureText({ step: 3, name: "Running", expected: false, actual: true })).toEqual({ message: "step 3: Running expected false got true", expected: "false", actual: "true" });
    expect(failureText({ step: 1, name: "Runing", expected: false, actual: "<Runing does not exist>" }).message).toBe("step 1: Runing expected false got <Runing does not exist>");
  });
});
