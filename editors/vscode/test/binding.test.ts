// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { retarget } from "../src/core/binding";

describe("declarations panel binding", () => {
  it("unpinned follows SCL editors", () => {
    expect(retarget({ pinned: false, uri: "a.scl" }, { uri: "b.scl", languageId: "scl" })).toEqual({ pinned: false, uri: "b.scl" });
  });

  it("binding keeps its target when no SCL editor is active", () => {
    expect(retarget({ pinned: false, uri: "a.scl" }, undefined)).toEqual({ pinned: false, uri: "a.scl" });
    expect(retarget({ pinned: false, uri: "a.scl" }, { uri: "x.md", languageId: "markdown" })).toEqual({ pinned: false, uri: "a.scl" });
  });

  it("pinned never moves", () => {
    expect(retarget({ pinned: true, uri: "a.scl" }, { uri: "b.scl", languageId: "scl" })).toEqual({ pinned: true, uri: "a.scl" });
  });
});
