// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { testKeyEdits } from "../src/index.js";

describe("a renamed parameter in the block's tests", () => {
  it("resolves a parameter through TIA-quoted member names", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-testkeys-"));
    mkdirSync(join(root, "tests"));
    const file = join(root, "tests", "motor.test.yaml");
    const text = `block: Motor\ncases:\n  - name: quoted\n    steps:\n      - set: { 'Pid."idb_PI-Control".Value': 2 }\n`;
    writeFileSync(file, text);
    const edits = (await testKeyEdits(root, "Motor", "Pid", "Loop")).get(file);
    expect(edits).toHaveLength(1);
    expect(edits?.[0]?.newText).toBe("Loop");
  });
  it("renames set: and expect: keys of that block's tests, flow and block style, not values or other blocks' stubs", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-testkeys-"));
    mkdirSync(join(root, "tests"));
    const motor = [
      "block: FB_Motor",
      "stubs:",
      "  FB_Other: { Start: true }",
      "cases:",
      "  - name: starts",
      "    steps:",
      '      - set: { Stop: true, Start: true, "Start.Bit": 1 }',
      "        expect: { Run: true }",
      "      - set:",
      "          Start: false",
      "        expect:",
      "          Run: Start",
      "",
    ].join("\n");
    writeFileSync(join(root, "tests", "motor.test.yaml"), motor);
    writeFileSync(join(root, "tests", "other.test.yaml"), "block: FB_Other\ncases:\n  - name: x\n    steps:\n      - set: { Start: true }\n");
    const edits = await testKeyEdits(root, "FB_Motor", "Start", "StartPb");
    expect([...edits.keys()].map((p) => basename(p))).toEqual(["motor.test.yaml"]);
    const lines = motor.split("\n");
    const at = [...edits.values()][0]!.map((e) => [e.range.start.line, lines[e.range.start.line]!.slice(e.range.start.character, e.range.end.character)]);
    expect(at).toEqual([[6, "Start"], [6, "Start"], [9, "Start"]]);
  });
});
