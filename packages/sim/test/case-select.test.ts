// SPDX-License-Identifier: BUSL-1.1
// rung test --case tests/x.test.yaml#1 runs exactly that case: the others of the file never run, the result keeps
// the case's place in the file, and a selector that names nothing is an error, never "all cases".
import { expect, it, describe } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceIndex } from "@rung/lsp";
import { runTests } from "../src/index.js";

const FB = 'FUNCTION_BLOCK "Latch"\n   VAR_INPUT\n      s : Bool;\n   END_VAR\n   VAR_OUTPUT\n      q : Bool;\n   END_VAR\nBEGIN\n\t#q := #s;\nEND_FUNCTION_BLOCK\n';
// case 0 would stop with an error if it ran (a name that does not exist); case 1 passes; case 2 fails
const TEST = [
  "block: Latch",
  "cases:",
  "  - name: start",
  "    steps:",
  "      - set: { nope: true }",
  "  - name: restart",
  "    steps:",
  "      - set: { s: true }",
  "      - cycle: 1",
  "      - expect: { q: true }",
  "  - name: stops",
  "    steps:",
  "      - cycle: 1",
  "      - expect: { q: true }",
  "",
].join("\n");

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "rung-case-"));
  await mkdir(join(root, "plc", "PLC_1", "blocks"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "plc", "PLC_1", "blocks", "Latch.scl"), FB);
  await writeFile(join(root, "tests", "latch.test.yaml"), TEST);
  const index = new WorkspaceIndex();
  await index.load(root);
  return { root, index };
}

describe("runTests with a case selector", () => {
  it("runs only the selected case and says which one it was", async () => {
    const { root, index } = await workspace();
    try {
      const r = await runTests(root, index, undefined, { file: "tests/latch.test.yaml", index: 1 });
      expect(r).toHaveLength(1);
      expect(r[0]!.cases.map((c) => [c.name, c.index, c.passed, c.error])).toEqual([["restart", 1, true, undefined]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("every result carries its case's index, also without a selector", async () => {
    const { root, index } = await workspace();
    try {
      const r = await runTests(root, index);
      expect(r[0]!.cases.map((c) => c.index)).toEqual([0, 1, 2]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a selector past the cases or for a file that is not there is an error", async () => {
    const { root, index } = await workspace();
    try {
      await expect(runTests(root, index, undefined, { file: "tests/latch.test.yaml", index: 3 })).rejects.toThrow(/has 3 cases/);
      await expect(runTests(root, index, undefined, { file: "tests/none.test.yaml", index: 0 })).rejects.toThrow(/no test file/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
