// SPDX-License-Identifier: BUSL-1.1
// Test keys of an array parameter ("Points[2]") follow its rename.
import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testKeyEdits } from "../src/testkeys.js";

it("renames the root parameter in array-element set and expect keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-edges-array-"));
  try {
    await mkdir(join(root, "tests"));
    const file = join(root, "tests", "motor.test.yaml");
    const text = 'block: Motor\ncases:\n  - name: sample\n    steps:\n      - set: { "Points[2]": 5 }\n        expect: { "Points[2]": 5 }\n';
    await writeFile(file, text);
    const edits = (await testKeyEdits(root, "Motor", "Points", "Samples")).get(file) ?? [];
    const lines = text.split("\n");
    for (const e of [...edits].reverse()) {
      const n = e.range.start.line;
      lines[n] = lines[n]!.slice(0, e.range.start.character) + e.newText + lines[n]!.slice(e.range.end.character);
    }
    expect(lines[4]).toBe('      - set: { "Samples[2]": 5 }');
    expect(lines[5]).toBe('        expect: { "Samples[2]": 5 }');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
