// SPDX-License-Identifier: BUSL-1.1
// rung test --filter by a case's name still reports a file that cannot run.
import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceIndex } from "@rung/lsp";
import { runTests } from "../src/index.js";

it("preserves validation errors for a case selected by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-edges-filter-"));
  try {
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests", "drive.test.yaml"), "block: Motor\ncases:\n  - name: starts\n    step:\n      - cycle: 1\n");
    const result = await runTests(root, new WorkspaceIndex(), "starts");
    expect(result).toHaveLength(1);
    expect(result[0]!.error).toContain("unknown key step");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
