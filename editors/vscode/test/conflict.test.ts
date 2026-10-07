// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { hasMarkers, splitConflict } from "../src/core/conflict";

const MARKED = [
  'DATA_BLOCK "Station_DB"',
  "BEGIN",
  "   Recipe.FillA_Level := 40.0;",
  "<<<<<<< file",
  "   Recipe.MixTime := T#6S;",
  "||||||| base",
  "   Recipe.MixTime := T#8S;",
  "   Recipe.SettleTime := T#4S;",
  "=======",
  "   Recipe.MixTime := T#8S;",
  ">>>>>>> tia",
  "   Recipe.DrainLevel := 5.0;",
  "END_DATA_BLOCK",
  "",
].join("\n");

describe("a .conflict file, as the three versions the merge editor needs", () => {
  it("splits rung's diff3 markers into base, your file and TIA Portal's version", () => {
    const s = splitConflict(MARKED)!;
    expect(s.file).toContain("Recipe.MixTime := T#6S;\n   Recipe.DrainLevel");
    expect(s.base).toContain("Recipe.MixTime := T#8S;\n   Recipe.SettleTime := T#4S;\n   Recipe.DrainLevel");
    expect(s.tia).toContain("Recipe.MixTime := T#8S;\n   Recipe.DrainLevel");
    for (const v of [s.file, s.base, s.tia]) {
      expect(v.startsWith('DATA_BLOCK "Station_DB"\nBEGIN\n   Recipe.FillA_Level := 40.0;\n')).toBe(true);
      expect(v.endsWith("END_DATA_BLOCK\n")).toBe(true);
      expect(hasMarkers(v)).toBe(false);
    }
    expect(hasMarkers(MARKED)).toBe(true);
  });

  it("keeps CRLF files CRLF, and returns nothing for a file without markers or with broken ones", () => {
    const s = splitConflict(MARKED.replace(/\n/g, "\r\n"))!;
    expect(s.file).toContain("T#6S;\r\n");
    expect(splitConflict("no markers here\n")).toBeUndefined();
    expect(splitConflict("<<<<<<< file\nx\n=======\ny\n")).toBeUndefined();
  });

  it("reads two-way markers (no base section) as an empty base", () => {
    const s = splitConflict("a\n<<<<<<< file\nx\n=======\ny\n>>>>>>> tia\nb\n")!;
    expect([s.file, s.base, s.tia]).toEqual(["a\nx\nb\n", "a\nb\n", "a\ny\nb\n"]);
  });
});
