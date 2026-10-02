// SPDX-License-Identifier: BUSL-1.1
import { it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile } from "@rung/sim";
import { githubAnnotations } from "../src/annotate.js";

it("B25 places YAML syntax and unknown case keys on their parser line and column", async () => {
  const idx = new WorkspaceIndex();
  for (const yaml of ["block: Unit\ncases:\n  - name: bad\n    stpes: []\n", "block: Unit\ncases:\n  - name: bad\n    steps:\n      - set: { Raw: 1\n"]) {
    const r = await runTestFile(idx, "tests/bad.test.yaml", yaml);
    const a = githubAnnotations([r], "C:/w", "C:/w")[0]!;
    expect(a).toContain(`file=tests/bad.test.yaml,line=${r.errorLine},col=${r.errorColumn},`);
    expect(a).toContain("::error");
  }
});
