// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { fileLineOf } from "../src/compile-lines.js";

// Cases measured live on TIA Portal V20.
const C2 = 'FUNCTION "Probe_C2" : Void\nVERSION : 0.1\n   VAR_INPUT\n      A : Bool;\n   END_VAR\nBEGIN\n\t// one\n\t// two\n\n\tIF #A THEN\n\t    #X2 := 1;\n\tEND_IF;\n\t#Y2 := 2;\nEND_FUNCTION\n';
const C3 = 'FUNCTION_BLOCK "Probe_C3"\nVERSION : 0.1\n   VAR\n      t : NoSuchType;\n   END_VAR\nBEGIN\n\t;\nEND_FUNCTION_BLOCK\n';

describe("compile message lines", () => {
  it("counts body lines from the line after BEGIN", () => {
    expect(fileLineOf(C2, { description: "Tag #X2 not defined.", bodyLine: 5, section: "body" })).toBe(11);
    expect(fileLineOf(C2, { description: "Tag #Y2 not defined.", bodyLine: 7, section: "body" })).toBe(13);
  });

  it("puts interface errors on the declaration the message names", () => {
    expect(fileLineOf(C3, { description: "Data type NoSuchType is unknown.", section: "interface" })).toBe(4);
  });

  it("falls back to the first declaration section for other interface messages", () => {
    expect(fileLineOf(C3, { description: "Something is wrong.", section: "interface" })).toBe(3);
  });

  it("keeps a line the bridge already knows", () => {
    expect(fileLineOf(C2, { description: "x", line: 2 })).toBe(2);
  });

  it("gives up on unknown positions and out-of-range lines", () => {
    expect(fileLineOf(C2, { description: "x" })).toBeUndefined();
    expect(fileLineOf(C2, { description: "x", bodyLine: 99, section: "body" })).toBeUndefined();
    expect(fileLineOf("no begin here\n", { description: "x", bodyLine: 1, section: "body" })).toBeUndefined();
  });

  it("ignores BEGIN inside comments and strings", () => {
    const src = 'FUNCTION "F" : Void\n// BEGIN is not here\n   VAR_TEMP\n      s : String := \'BEGIN\';\n   END_VAR\nBEGIN\n\t#x := 1;\nEND_FUNCTION\n';
    expect(fileLineOf(src, { description: "Tag #x not defined.", bodyLine: 1, section: "body" })).toBe(7);
  });
});
