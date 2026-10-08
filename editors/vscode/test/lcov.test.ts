// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { addLcov } from "../src/core/lcov";

describe("lcov", () => {
  it("sums line counts by file over several runs", () => {
    const a = "SF:blocks/A.scl\nDA:3,1\nDA:4,0\nLH:1\nLF:2\nend_of_record\nSF:blocks/B.scl\nDA:1,0\nend_of_record\n";
    const b = "SF:blocks/A.scl\r\nDA:4,2\r\nend_of_record\r\n";
    const all = addLcov(b, addLcov(a));
    expect([...all.get("blocks/A.scl")!]).toEqual([[3, 1], [4, 2]]);
    expect([...all.get("blocks/B.scl")!]).toEqual([[1, 0]]);
  });
});
