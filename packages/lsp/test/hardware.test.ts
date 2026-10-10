// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { hardwarePatchText } from "../src/hardware.js";

it("normalizes YAML hardware patches without losing JSON duplicate-key refusals", () => {
  const json = '{"version":1,"version":1,"changes":[]}';
  expect(hardwarePatchText(json)).toBe(json);
  expect(JSON.parse(hardwarePatchText('version: 1\nexpectedRevision: revision\nchanges:\n  - device: PLC_1\n    positions: [1]\n    field: Comment\n    before: ""\n    after: |\n      Проверка\n'))).toEqual({ version: 1, expectedRevision: "revision", changes: [{ device: "PLC_1", positions: [1], field: "Comment", before: "", after: "Проверка\n" }] });
  for (const bad of ['version: 1\nversion: 2', 'version: &v 1\nchanges: [*v]', 'version: !unknown 1', '---\nversion: 1\n---\nversion: 2', 'bad json', '[]', 'changes: [', 'x'.repeat(1048577)])
    expect(() => hardwarePatchText(bad), bad.slice(0, 60)).toThrow();
});
