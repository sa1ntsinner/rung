// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { corpus, readRecording, compareSimulator, normalizeValue, recording, serializeRecording, validateRecording, type ConformanceSource } from "./conformance-helpers.js";

describe("CODESYS conformance", () => {
  it("compares recorded programs and reports refusals and missing recordings separately", async () => {
    const { index, sources } = await corpus();
    const counts = { match: 0, refused: 0, differ: 0, unrecorded: 0 };
    const differences: string[] = [];
    for (const source of sources) {
      const recorded = await readRecording(source);
      if (!recorded) {
        counts.unrecorded++;
        console.log(source.file + ": not recorded");
        continue;
      }
      const result = await compareSimulator(index, source, recorded.text, recorded.spec);
      counts[result.status]++;
      if (result.status === "refused") console.log(source.file + ": refused by rung: " + result.reason);
      if (result.status === "differ") differences.push(source.file + ": " + result.differences.join("; "));
    }
    console.log(`${counts.match} match CODESYS, ${counts.refused} refused by rung, ${counts.differ} differ, ${counts.unrecorded} not recorded (programs)`);
    expect(differences, differences.join("\n")).toEqual([]);
  });

  it("does not let the runner's tolerance hide an integer mismatch", async () => {
    const index = new WorkspaceIndex();
    const text = "PROGRAM PRG_Probe\nVAR\n  r_value : DINT;\n  done : BOOL;\n  cycle : UINT;\nEND_VAR\nr_value := 1000001;\ncycle := 1;\ndone := TRUE;\nEND_PROGRAM\n";
    index.set("file:///probe.st", text, 0);
    const source: ConformanceSource = { file: "probe.st", text, block: "PRG_Probe", cycles: 1, results: [{ name: "r_value", type: "DINT" }] };
    const spec = recording(source, { done: true, cycle: 1, r_value: 1000000 });
    const result = await compareSimulator(index, source, serializeRecording(spec), spec);
    expect(result.status).toBe("differ");
    expect(result.differences).toEqual(["r_value: expected 1000000, got 1000001"]);
  });

  it("distinguishes unsupported constructs from unexpected runner errors", async () => {
    const source: ConformanceSource = { file: "probe.st", text: "", block: "PRG_Probe", cycles: 1, results: [{ name: "r_value", type: "WORD" }] };
    const spec = recording(source, { done: true, cycle: 1, r_value: 2 });
    const index = new WorkspaceIndex();
    const program = (expression: string) => "PROGRAM PRG_Probe\nVAR\n  r_value : WORD;\n  done : BOOL;\n  cycle : UINT;\nEND_VAR\nr_value := " + expression + ";\ncycle := 1;\ndone := TRUE;\nEND_PROGRAM\n";
    index.set("file:///probe.st", program("LWORD_TO_WORD(LWORD#16#FFFF_FFFF_FFFF_FFFF)"), 0);
    expect((await compareSimulator(index, source, serializeRecording(spec), spec)).status).toBe("refused");
    index.set("file:///probe.st", program("missing"), 1);
    await expect(compareSimulator(index, source, serializeRecording(spec), spec)).rejects.toThrow(/unexpected runner error/);
  });

  it("rejects incomplete recordings and preserves exactly representable 64-bit values", () => {
    const source: ConformanceSource = { file: "probe.st", text: "", block: "PRG_Probe", cycles: 1, results: [{ name: "r_value", type: "LINT" }] };
    expect(() => recording(source, { done: true, cycle: 1 })).toThrow(/every result/);
    expect(() => normalizeValue("9007199254740993", "LINT")).toThrow(/exactly/);
    const spec = recording(source, { done: true, cycle: 1, r_value: normalizeValue("-9223372036854775808", "LINT") });
    expect(serializeRecording(spec)).toContain("-9223372036854775808");
    expect(() => validateRecording(source, spec)).not.toThrow();
  });
});
