// SPDX-License-Identifier: BUSL-1.1
// What TIA Portal V20 said compiling an open-source timer library: a TIME compared with 0 is refused; a TON_TIME in a
// structure called as #s.t.TON(...) compiles.
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, diagnostics } from "../src/index.js";

const fc = (body: string) =>
  `FUNCTION "Fx" : Void\nVAR_INPUT\n  i : Int;\nEND_VAR\nVAR_TEMP\n  t : Time;\n  start : Time;\n  n : DInt;\n  s : Struct\n    tm : TON_TIME;\n  END_STRUCT;\n  arr : Array[0..3] of Time;\nEND_VAR\nBEGIN\n${body}\nEND_FUNCTION\n`;
const found = (body: string) => {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/plc/PLC_1/blocks/Fx.scl", fc(body), 0);
  return diagnostics(idx, "file:///w/plc/PLC_1/blocks/Fx.scl").filter((d) => d.severity !== "hint").map((d) => d.code);
};

describe("TIME comparisons and timer calls", () => {
  it("refuses a TIME expression compared with a bare integer, not a duration or an integer variable", () => {
    expect(found("  IF #t - #start < 0 THEN #t := T#0ms; END_IF;")).toContain("TIME_COMPARE");
    expect(found("  IF #arr[#i] - #t >= 0 THEN #t := T#0ms; END_IF;")).toContain("TIME_COMPARE");
    expect(found("  IF #t - #start < T#0ms THEN #t := T#0ms; END_IF;")).not.toContain("TIME_COMPARE");
    expect(found("  IF #n < 0 THEN #n := 1; END_IF;")).not.toContain("TIME_COMPARE");
    expect(found("  IF #arr[1] > T#1s THEN #n := 1; END_IF;")).not.toContain("TIME_COMPARE");
  });
  it("knows #s.tm.TON(...) on a TON_TIME", () => {
    expect(found("  #s.tm.TON(IN := TRUE, PT := T#1s);")).not.toContain("UNKNOWN_MEMBER");
  });
});
