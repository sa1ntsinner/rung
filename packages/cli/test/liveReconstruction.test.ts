// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { reconstructNativeSample, steadyReads } from "../src/liveReconstruction.js";

describe("globals read next to a native sample", () => {
  it("keeps values that stood still across the sample and refuses ones that moved or failed", () => {
    expect(steadyReads(['"A".x', '"B"'], [{ value: 1 }, { value: true }], [{ value: 1 }, { value: true }])).toEqual({ '"A".x': 1, '"B"': true });
    expect(() => steadyReads(['"A".x'], [{ value: 1 }], [{ value: 2 }])).toThrow(/changed while the sample/);
    expect(() => steadyReads(['"A".x'], [{ error: "Symbol not found in PLC." }], [{ value: 1 }])).toThrow(/Symbol not found/);
  });
});

describe("a native sample of an FB that calls a user FC", () => {
  const uri = "file:///w/plc/PLC_1/blocks/F.scl";
  const index = new WorkspaceIndex();
  index.set(uri, 'FUNCTION_BLOCK "F"\nVAR_OUTPUT\n n : Int;\nEND_VAR\nBEGIN\n#n := "Add"(a := #n);\nEND_FUNCTION_BLOCK', 0);
  index.set(uri.replace("/F.scl", "/Add.scl"), 'FUNCTION "Add" : Int\nVAR_INPUT\n a : Int;\nEND_VAR\nBEGIN\n#Add := #a + 2;\nEND_FUNCTION', 0);
  const scope = { device: "PLC_1", address: "192.168.0.1", transport: "s7plus", epoch: 1 } as never;
  const capture = (functions?: unknown) => ({ coherence: "subscription-sample", scope, capture: {
    bodies: [{ compilationUnit: "1", text: '#n := "Add"(a := #n);' }], scalars: [{ name: "N", bitOffset: 32, bits: 16, type: '{Scalar"33554437"Int}' }],
    constants: [], functions, route: { instance: "F_DB" }, codeSignature: "x",
    samples: [1, 2, 3].map(i => ({ observedAt: i, sequence: i, state: { before: { N: 5 }, after: { N: 7 } } })) } }) as never;
  it("replays the FC when the PLC's FC code is the mirrored one", () => {
    const add = [{ name: "Add", bodies: [{ compilationUnit: "1", text: "#Add := #a + 2;" }], constants: [] }];
    expect(reconstructNativeSample(index, uri, capture(add), scope, "F_DB").divergences).toEqual([]);
    expect(() => reconstructNativeSample(index, uri, capture(), scope, "F_DB")).toThrow(/Add/);
  });
});
