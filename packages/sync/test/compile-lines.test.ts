// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { fileLineOf, placeCompileMessages } from "../src/compile-lines.js";

// Cases measured live on TIA Portal V20.
const C2 = 'FUNCTION "Probe_C2" : Void\nVERSION : 0.1\n   VAR_INPUT\n      A : Bool;\n   END_VAR\nBEGIN\n\t// one\n\t// two\n\n\tIF #A THEN\n\t    #X2 := 1;\n\tEND_IF;\n\t#Y2 := 2;\nEND_FUNCTION\n';
const C3 = 'FUNCTION_BLOCK "Probe_C3"\nVERSION : 0.1\n   VAR\n      t : NoSuchType;\n   END_VAR\nBEGIN\n\t;\nEND_FUNCTION_BLOCK\n';

describe("compile message lines", () => {
  it("drops compile summaries before file placement", async () => {
    const msgs = await placeCompileMessages("root", () => "Valve.scl", [
      { address: "plc:PLC_1/blocks/Valve", severity: "error", description: "Compiling finished (errors: 1; warnings: 0)" },
      { address: "plc:PLC_1/blocks/Valve", severity: "warning", description: "  Compiling finished (errors: 0; warnings: 1)" },
      { address: "plc:PLC_1/blocks/Valve", severity: "error", description: "Tag #X2 not defined.", bodyLine: 5, section: "body" },
    ], async () => C2);
    expect(msgs).toEqual([expect.objectContaining({ description: "Tag #X2 not defined.", file: "Valve.scl", line: 11 })]);
  });

  it("deduplicates PLC messages and removes legacy file attribution for the hardware warning", async () => {
    const description = "Inputs or outputs are used that do not exist in the configured hardware.";
    const msgs = await placeCompileMessages("root", () => "Valve.scl", [
      { address: "plc:PLC_1/blocks/Valve", severity: "warning", description },
      { address: "plc:PLC_1/blocks/Other", severity: "warning", description },
      { severity: "warning", description: "PLC configuration needs attention" },
      { severity: "warning", description: "PLC configuration needs attention" },
    ], async () => C2);
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => !m.address && !(m as { file?: string }).file && !(m as { line?: number }).line)).toBe(true);
  });

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
