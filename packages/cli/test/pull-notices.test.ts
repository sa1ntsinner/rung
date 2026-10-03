// SPDX-License-Identifier: BUSL-1.1
// A crash while writing notices.json must not break future pulls.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "@rung/core";
import { main } from "../src/main.js";
vi.mock("../src/common.js", async (original) => ({
  ...await original<typeof import("../src/common.js")>(),
  bridgeFor: async () => ({ async close() {} }),
}));
vi.mock("@rung/sync", async (original) => ({
  ...await original<typeof import("@rung/sync")>(),
  pull: async () => ({ exported: 0, unchanged: 0, removed: 0, readOnly: 0, warnings: [], overwritten: [], collisions: [], tooLong: [] }),
}));
describe("rung pull: the notices it remembers", () => {
  for (const args of [["pull"], ["pull", "--verbose"]]) it(`ignores a truncated cache during ${args.join(" ")}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-notices-"));
    await saveConfig(root, defaultConfig("C:/fixture/project.ap20", "V20", "fake"));
    mkdirSync(join(root, ".rung"), { recursive: true });
    writeFileSync(join(root, ".rung/notices.json"), "[");
    await expect(main(args, { cwd: root, env: {}, stdout() {}, stderr() {} })).resolves.toBe(0);
  });
});
