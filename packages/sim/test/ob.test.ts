// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile } from "../src/index.js";

it("runs an OB body each explicit cycle with persistent DB memory and fresh TEMP, isolated by case", async () => {
  const index = new WorkspaceIndex();
  index.set("file:///w/plc/P/blocks/Plant.db", 'DATA_BLOCK "Plant"\nVAR\nRun : Bool;\nCount : Int;\nTempSeen : Int;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK', 0);
  index.set("file:///w/plc/P/blocks/Main.scl", `ORGANIZATION_BLOCK "Main"
VAR_TEMP
  scratch : Int;
END_VAR
BEGIN
  #scratch := #scratch + 1;
  "Plant".TempSeen := #scratch;
  IF "Plant".Run THEN "Plant".Count := "Plant".Count + 1; END_IF;
END_ORGANIZATION_BLOCK`, 0);
  const result = await runTestFile(index, "tests/main.test.yaml", `block: Main
cases:
  - name: cycles
    steps:
      - set: { '"Plant".Run': true }
      - cycle: 3
      - expect: { '"Plant".Count': 3, '"Plant".TempSeen': 1 }
      - set: { '"Plant".Run': false }
      - cycle: 1
      - expect: { '"Plant".Count': 3 }
  - name: fresh case
    steps:
      - cycle: 1
      - expect: { '"Plant".Count': 0, '"Plant".Run': false, '"Plant".TempSeen': 1 }
`);
  expect(result.error).toBeUndefined();
  expect(result.cases.map(c => ({ passed: c.passed, error: c.error, failures: c.failures }))).toEqual([
    { passed: true, error: undefined, failures: [] }, { passed: true, error: undefined, failures: [] },
  ]);
});
