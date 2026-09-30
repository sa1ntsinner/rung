// SPDX-License-Identifier: MIT
// The site's playground: rung test's own simulator and runner, in the browser, on one block and one test file.
import { WorkspaceIndex } from "./lsp-lite.js";
import { runTestFile, testPositions, type FileResult } from "@rung/sim";

export interface PlayResult {
  result: FileResult;
  /** What rung test prints for it. */
  lines: { text: string; kind: "ok" | "fail" | "note" }[];
  /** The line of each case and of its steps in the test file (1-based), as the VS Code Testing view uses them. */
  positions: { line: number; steps: number[] }[];
  ms: number;
}

/** `file` is the block's file name in plc/PLC_1/blocks/ (its extension says how to read it: .scl, .awl, .s7dcl). */
export async function play(file: string, source: string, yaml: string): Promise<PlayResult> {
  const index = new WorkspaceIndex();
  index.set(`file:///work/plc/PLC_1/blocks/${encodeURIComponent(file)}`, source, 1);
  const t0 = performance.now();
  const result = await runTestFile(index, "tests/playground.test.yaml", yaml);
  const ms = performance.now() - t0;
  const lines: PlayResult["lines"] = [];
  if (result.error) lines.push({ text: `FAIL ${result.file}: ${result.error}`, kind: "fail" });
  for (const c of result.cases) {
    lines.push({ text: `${c.passed ? "ok  " : "FAIL"} ${result.block}: ${c.name}${c.error ? ` — ${c.errorStep ? `step ${c.errorStep}: ` : ""}${c.error}` : ""}`, kind: c.passed ? "ok" : "fail" });
    for (const x of c.failures) lines.push({ text: `       step ${x.step}: ${x.name} expected ${JSON.stringify(x.expected)} got ${JSON.stringify(x.actual)}`, kind: "fail" });
  }
  for (const w of result.warnings ?? []) lines.push({ text: `       warning: ${w}`, kind: "note" });
  const total = result.error ? 1 : result.cases.length;
  const failed = result.error ? 1 : result.cases.filter((c) => !c.passed).length;
  if (total) lines.push({ text: `\n${total - failed}/${total} passed (offline simulation — not a PLCSIM run)`, kind: "note" });
  return { result, lines, positions: testPositions(yaml), ms };
}
