// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mergeText, mergeBundle } from "../src/index.js";

const base = "FUNCTION_BLOCK \"M\"\nBEGIN\n  #a := 1;\n  #b := 2;\n  #c := 3;\n  #d := 4;\nEND_FUNCTION_BLOCK\n";

describe("mergeText", () => {
  it("merges non-overlapping edits from both sides", () => {
    const file = base.replace("#a := 1;", "#a := 10;");
    const tia = base.replace("#d := 4;", "#d := 40;");
    const r = mergeText(base, file, tia);
    expect(r).toEqual({ kind: "clean", text: base.replace("#a := 1;", "#a := 10;").replace("#d := 4;", "#d := 40;") });
  });

  it("reports overlapping edits as a conflict with labelled markers", () => {
    const file = base.replace("#b := 2;", "#b := 20;");
    const tia = base.replace("#b := 2;", "#b := 200;");
    const r = mergeText(base, file, tia);
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") return;
    expect(r.conflicts).toBe(1);
    expect(r.text).toContain("<<<<<<< file\n  #b := 20;\n||||||| base\n  #b := 2;\n=======\n  #b := 200;\n>>>>>>> tia\n");
    expect(r.text.startsWith('FUNCTION_BLOCK "M"\nBEGIN\n  #a := 1;\n')).toBe(true);
  });

  it("accepts identical edits on both sides", () => {
    const both = base.replace("#c := 3;", "#c := 33;");
    expect(mergeText(base, both, both)).toEqual({ kind: "clean", text: both });
  });

  it("ignores CRLF and BOM differences", () => {
    const file = "﻿" + base.replace(/\n/g, "\r\n");
    expect(mergeText(base, file, base)).toEqual({ kind: "clean", text: base });
  });

  it("treats new-on-both-sides with different content as a conflict", () => {
    const r = mergeText(null, "A\n", "B\n");
    expect(r.kind).toBe("conflict");
  });

  it("accepts new-on-both-sides with identical content", () => {
    expect(mergeText(null, "A\n", "A\n")).toEqual({ kind: "clean", text: "A\n" });
  });

  it("keeps keyword casing and whitespace inside strings/comments as real changes", () => {
    const file = base.replace("#a := 1;", "#a := 1; // Kommentar");
    const tia = base.replace("#a := 1;", "#a := 1; // kommentar");
    expect(mergeText(base, file, tia).kind).toBe("conflict");
  });

  it("takes one side when only that side changed", () => {
    const tia = base.replace("#d := 4;", "#d := 5;");
    expect(mergeText(base, base, tia)).toEqual({ kind: "clean", text: tia });
    expect(mergeText(base, tia, base)).toEqual({ kind: "clean", text: tia });
  });
});

describe("mergeBundle", () => {
  const b = { primary: "x\n", ".s7res": "r\n" };
  it("merges source forms per file", () => {
    const r = mergeBundle("scl", { ".scl": base }, { ".scl": base.replace("#a := 1;", "#a := 9;") }, { ".scl": base.replace("#d := 4;", "#d := 8;") });
    expect(r.kind).toBe("clean");
  });
  it("conflicts conservatively on concurrent changes to SD/XML bundles", () => {
    const r = mergeBundle("s7dcl", b, { ...b, primary: "y\n" }, { ...b, ".s7res": "q\n" });
    expect(r.kind).toBe("conflict");
  });
  it("takes the only changed side of an SD bundle, including resource-only changes", () => {
    const r = mergeBundle("s7dcl", b, b, { ...b, ".s7res": "q\n" });
    expect(r).toEqual({ kind: "clean", files: { ...b, ".s7res": "q\n" } });
  });
});
