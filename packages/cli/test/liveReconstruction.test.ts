// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { steadyReads } from "../src/liveReconstruction.js";

describe("globals read next to a native sample", () => {
  it("keeps values that stood still across the sample and refuses ones that moved or failed", () => {
    expect(steadyReads(['"A".x', '"B"'], [{ value: 1 }, { value: true }], [{ value: 1 }, { value: true }])).toEqual({ '"A".x': 1, '"B"': true });
    expect(() => steadyReads(['"A".x'], [{ value: 1 }], [{ value: 2 }])).toThrow(/changed while the sample/);
    expect(() => steadyReads(['"A".x'], [{ error: "Symbol not found in PLC." }], [{ value: 1 }])).toThrow(/Symbol not found/);
  });
});
