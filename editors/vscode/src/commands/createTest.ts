// SPDX-License-Identifier: MIT
// Create test: a block's first test file, drafted by the language server (rung/testSkeleton) from the block's
// interface. A test that already exists is opened, never overwritten.
import { join } from "node:path";
import * as vscode from "vscode";
import type { Lsp } from "../lsp";
import type { RungWorkspace } from "../workspace";
import { createNew } from "./newObject";

interface Skeleton {
  path: string;
  text: string;
  existing: string[];
}

export async function createTest(lsp: Lsp, ws: RungWorkspace, uri?: vscode.Uri, position?: vscode.Position): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  const target = uri ?? editor?.document.uri;
  if (!target || !ws.root) return undefined;
  const at = position ?? (editor && editor.document.uri.toString() === target.toString() ? editor.selection.active : undefined);
  const s = await lsp.request<Skeleton | null>("rung/testSkeleton", { textDocument: { uri: target.toString() }, ...(at ? { position: at } : {}) }).catch(() => undefined);
  if (s === undefined) {
    void vscode.window.showWarningMessage("The rung language server is not running.");
    return undefined;
  }
  if (!s) {
    void vscode.window.showWarningMessage("There is no block here to test.");
    return undefined;
  }
  const root = ws.root;
  const open = async (rel: string, line?: number) => {
    const file = vscode.Uri.file(join(root, rel));
    const doc = await vscode.workspace.openTextDocument(file);
    const sel = line !== undefined ? new vscode.Range(line, 0, line, 0) : undefined;
    await vscode.window.showTextDocument(doc, { preview: false, ...(sel ? { selection: sel } : {}) });
    return file;
  };
  // the block has tests: open them (one, or the one picked)
  if (s.existing.length) {
    const pick = s.existing.length === 1 ? s.existing[0] : (await vscode.window.showQuickPick(s.existing, { title: "Tests of this block", placeHolder: "Open…" }));
    return pick ? open(pick) : undefined;
  }
  const file = vscode.Uri.file(join(root, s.path));
  // created in one step that refuses a file already there: a file by that name tests something else
  if (!(await createNew(file, s.text))) {
    void vscode.window.showWarningMessage(`${s.path} exists and tests another block. Rename it or add a case to it.`);
    return open(s.path);
  }
  // the cursor on the values to change: the expect line, else the case's name
  const lines = s.text.split("\n");
  const expectLine = lines.findIndex((l) => /^\s*- expect:/.test(l));
  return open(s.path, expectLine >= 0 ? expectLine : lines.findIndex((l) => /name:/.test(l)));
}
