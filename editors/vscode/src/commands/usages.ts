// SPDX-License-Identifier: MIT
// "Who Writes This?": the writers of the name under the cursor first, then its readers, each with its block and line,
// and for a writer where its block is called from. The language server finds them (rung/usages).
import * as vscode from "vscode";
import type { Lsp } from "../lsp";
import type { UsagesView } from "../views/usagesView";

interface Site {
  uri: string;
  range: vscode.Range;
  kind: "read" | "write";
  block?: string;
  text: string;
  calledFrom?: { block: string; uri: string; range: vscode.Range }[];
  /** Reached inside a block the structure holding it is handed to: that call. */
  through?: { block: string; param: string; uri: string; range: vscode.Range; text: string };
  whole?: boolean;
  /** A call that hands the value on to this block's in/out or output; what that block does with it is listed. */
  handedTo?: { block: string; param: string };
}

/** Who Writes This?: the uses of the name under the cursor, in the Usages view. */
export async function whoWrites(usages: UsagesView): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const word = editor.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active, /"[^"\n]+"|#?[A-Za-z_][\w]*/));
  await usages.show(editor.document.uri, editor.selection.active, word || "this");
}

/** The same uses in a quick pick, for keyboard users who want to jump and go on. */
export async function pickUsages(lsp: Lsp): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const word = editor.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active, /"[^"\n]+"|#?[A-Za-z_][\w]*/));
  const r = await lsp.request<{ writes: Site[]; reads: Site[]; handedOn?: Site[] }>("rung/usages", { textDocument: { uri: editor.document.uri.toString() }, position: editor.selection.active });
  if (!r) {
    void vscode.window.showWarningMessage("The rung language server is not running.");
    return;
  }
  if (!r.writes.length && !r.reads.length && !r.handedOn?.length) {
    void vscode.window.showInformationMessage(`rung finds no use of ${word || "this"} in the workspace.`);
    return;
  }
  type Item = vscode.QuickPickItem & { site?: Site; at?: { uri: string; range: vscode.Range } };
  const where = (s: { uri: string; range: vscode.Range }) => `${vscode.workspace.asRelativePath(vscode.Uri.parse(s.uri))}:${s.range.start.line + 1}`;
  const items: Item[] = [];
  items.push({ label: `writes (${r.writes.length})`, kind: vscode.QuickPickItemKind.Separator });
  if (!r.writes.length) items.push({ label: "$(info) nothing in the workspace writes it", description: "an HMI, a communication block or indirect access may" });
  const block = (s: Site) => `${s.block ?? ""}${s.whole ? " (the whole structure)" : ""}`;
  const through = (s: Site) => s.through ? [{ label: `      $(call-incoming) as ${s.through.param} from ${s.through.block}: ${s.through.text}`, detail: where(s.through), at: s.through }] : [];
  for (const s of r.writes) {
    items.push({ label: `$(edit) ${s.text}`, description: block(s), detail: where(s), site: s }, ...through(s));
    for (const c of s.calledFrom ?? []) items.push({ label: `      $(call-incoming) called from ${c.block}`, detail: where(c), at: c });
  }
  items.push({ label: `reads (${r.reads.length})`, kind: vscode.QuickPickItemKind.Separator });
  for (const s of r.reads) items.push({ label: `$(eye) ${s.text}`, description: block(s), detail: where(s), site: s }, ...through(s));
  if (r.handedOn?.length) items.push({ label: `handed on (${r.handedOn.length})`, kind: vscode.QuickPickItemKind.Separator });
  for (const s of r.handedOn ?? []) items.push({ label: `$(arrow-right) ${s.text}`, description: `${block(s)}, to ${s.handedTo!.block} as ${s.handedTo!.param}`, detail: where(s), site: s }, ...through(s));
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
