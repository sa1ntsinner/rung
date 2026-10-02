// SPDX-License-Identifier: MIT
// "Who Writes This?": the writers of the name under the cursor first, then its readers, each with its block and line,
// and for a writer where its block is called from. The language server finds them (rung/usages).
import * as vscode from "vscode";
import type { Lsp } from "../lsp";

interface Site {
  uri: string;
  range: vscode.Range;
  kind: "read" | "write";
  block?: string;
  text: string;
  calledFrom?: { block: string; uri: string; range: vscode.Range }[];
}

export async function whoWrites(lsp: Lsp): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const word = editor.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active, /"[^"\n]+"|#?[A-Za-z_][\w]*/));
  const r = await lsp.request<{ writes: Site[]; reads: Site[] }>("rung/usages", { textDocument: { uri: editor.document.uri.toString() }, position: editor.selection.active });
  if (!r) {
    void vscode.window.showWarningMessage("The rung language server is not running.");
    return;
  }
  if (!r.writes.length && !r.reads.length) {
    void vscode.window.showInformationMessage(`rung finds no use of ${word || "this"} in the workspace.`);
    return;
  }
  type Item = vscode.QuickPickItem & { site?: Site; at?: { uri: string; range: vscode.Range } };
  const where = (s: Site) => `${vscode.workspace.asRelativePath(vscode.Uri.parse(s.uri))}:${s.range.start.line + 1}`;
  const items: Item[] = [];
  items.push({ label: `writes (${r.writes.length})`, kind: vscode.QuickPickItemKind.Separator });
  if (!r.writes.length) items.push({ label: "$(info) nothing in the workspace writes it", description: "an HMI, a communication block or indirect access may" });
  for (const s of r.writes) {
    items.push({ label: `$(edit) ${s.text}`, description: s.block ?? "", detail: where(s), site: s });
    for (const c of s.calledFrom ?? []) items.push({ label: `      $(call-incoming) called from ${c.block}`, detail: `${vscode.workspace.asRelativePath(vscode.Uri.parse(c.uri))}:${c.range.start.line + 1}`, at: c });
  }
  items.push({ label: `reads (${r.reads.length})`, kind: vscode.QuickPickItemKind.Separator });
  for (const s of r.reads) items.push({ label: `$(eye) ${s.text}`, description: s.block ?? "", detail: where(s), site: s });
  const pick = await vscode.window.showQuickPick(items, {
    title: `Who writes ${word}? (HMI, communication and indirect access are not seen)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  const to = pick?.site ?? pick?.at;
  if (!to) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(to.uri));
  const range = new vscode.Range(to.range.start.line, to.range.start.character, to.range.end.line, to.range.end.character);
  await vscode.window.showTextDocument(doc, { selection: range });
}
