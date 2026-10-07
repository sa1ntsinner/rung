// SPDX-License-Identifier: MIT
// Record expectations: run the case under the cursor, show the block's values after the step there, and write
// the ones the engineer picks into that step's expect: (edits planned by the language server, undone as text).
// Nothing becomes an assertion without being picked.
import { relative, sep } from "node:path";
import * as vscode from "vscode";
import type { Lsp } from "../lsp";
import type { TCase, TestFileModel } from "../protocol/tests";
import { RungCli } from "../runner/cli";
import { applyTestOp } from "../tests/testEditor";
import type { RungWorkspace } from "../workspace";

interface Observed {
  step: number;
  values: Record<string, boolean | number | string>;
  statics?: string[];
}

/** The value as a test file writes it (true, 1200, T#2s). */
const shown = (v: boolean | number | string) => String(v);

export async function recordExpectations(ws: RungWorkspace, cli: RungCli, lsp: Lsp, uri?: vscode.Uri, caseIndex?: number, stepIndex?: number): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
  if (!doc || !ws.root || !/\.test\.ya?ml$/i.test(doc.uri.fsPath)) {
    void vscode.window.showWarningMessage("Open a test file (tests/….test.yaml) and put the cursor on a step that runs cycles.");
    return false;
  }
  if (doc.isDirty) {
    const go = await vscode.window.showWarningMessage(`${relative(ws.root, doc.uri.fsPath)} has unsaved changes. The case runs from the saved file.`, { modal: true }, "Save and Record");
    if (go !== "Save and Record" || !(await doc.save())) return false;
  }
  const file = await lsp.request<TestFileModel | null>("rung/testModel", { textDocument: { uri: doc.uri.toString() } }).catch(() => undefined);
  if (!file) {
    void vscode.window.showWarningMessage("The rung language server is not running.");
    return false;
  }
  const offset = editor?.document === doc ? doc.offsetAt(editor.selection.active) : 0;
  const c: TCase | undefined = caseIndex !== undefined ? file.model.cases[caseIndex] : file.model.cases.find((x) => offset >= x.range.start && offset <= x.range.end) ?? file.model.cases[file.model.cases.length - 1];
  if (!c) {
    void vscode.window.showWarningMessage("This file has no cases yet.");
    return false;
  }
  // the step at the cursor, or the last one before it that runs cycles: values exist only after cycles
  const at = stepIndex ?? Math.max(0, c.steps.filter((s) => s.range.start <= offset).length - 1);
  const step = [...c.steps.slice(0, at + 1)].reverse().find((s) => s.cycle || s.advance);
  // a step of only expect: after it is where its values go; otherwise the step that ran the cycles
  const here = c.steps[at];
  const into = here && step && here.index > step.index && !here.cycle && !here.advance && !here.set ? here : step;
  if (!step || !into) {
    void vscode.window.showWarningMessage("Put the cursor on a step that runs cycles (cycle: or advance:): the block has values only after it ran.");
    return false;
  }
  const rel = relative(ws.root, doc.uri.fsPath).split(sep).join("/");
  const r = await cli.capture(["test", "--json", "--observe", "--case", `${rel}#${c.index}`], { quiet: true });
  let observed: Observed[] | undefined;
  let error: string | undefined;
  try {
    const f = (JSON.parse(r.output) as { files: { error?: string; cases: { error?: string; observed?: Observed[] }[] }[] }).files[0];
    observed = f?.cases[0]?.observed;
    error = f?.error ?? f?.cases[0]?.error;
  } catch {
    error = RungCli.summary(r.output) || "rung test did not answer";
  }
  const seen = observed?.find((o) => o.step === step.index + 1);
  const values = seen?.values;
  const statics = new Set(seen?.statics ?? []);
  if (!values) {
    void vscode.window.showWarningMessage(`The case did not get to step ${step.index + 1}${error ? `: ${error}` : "."}`);
    return false;
  }
  const expected = new Map((into.expect?.entries ?? []).map((e) => [e.key.toUpperCase(), e.text]));
  type Item = vscode.QuickPickItem & { key: string; value: string };
  const items: Item[] = Object.entries(values).map(([key, v]) => {
    const now = expected.get(key.toUpperCase());
    // statics are the block's memory, not its results: offered, not picked
    const note = now !== undefined ? (now === shown(v) ? "expected already" : `expected now: ${now}`) : statics.has(key) ? "static" : undefined;
    return { key, value: shown(v), label: `${key} = ${shown(v)}`, ...(note ? { description: note } : {}), picked: now !== undefined ? now !== shown(v) : !statics.has(key) };
  });
  if (!items.length) {
    void vscode.window.showInformationMessage("The block has no outputs or statics with plain values to expect.");
    return false;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: `Expect after step ${step.index + 1} of "${c.name?.value ?? `case ${c.index + 1}`}"${into !== step ? `, written into step ${into.index + 1}` : ""}`,
    placeHolder: "The values the block has after this step. Pick the ones the test should expect.",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picked?.length) return false;
  for (const p of picked) {
    const has = into.expect?.entries.find((e) => e.key.toUpperCase() === p.key.toUpperCase());
    if (has && has.text === p.value) continue;
    const op = has ? { op: "setValue" as const, case: c.index, step: into.index, part: "expect" as const, key: has.key, value: p.value } : { op: "addEntry" as const, case: c.index, step: into.index, part: "expect" as const, key: p.key, value: p.value };
    const done = await applyTestOp(lsp, doc, op);
    if (!done.ok) {
      void vscode.window.showWarningMessage(`${p.key} was not written: ${done.reason ?? "the file changed"}`);
      return false;
    }
  }
  return true;
}
