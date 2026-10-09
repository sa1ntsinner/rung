// SPDX-License-Identifier: MIT
// Interface Impact: what the block's interface change breaks against the version TIA Portal has, before a sync.
// Calls that pass a parameter that went, instance DBs reinitialised on download, tests naming it. The language server
// answers (rung/impact) from the editor's text, saved or not: saving would sync it while rung watch runs.
import * as vscode from "vscode";
import type { Lsp } from "../lsp";

interface Site {
  block: string;
  uri: string;
  line: number;
  problems: string[];
}
interface Impact {
  block: string;
  kind: string;
  changes: { kind: string; section: string; name: string; to?: string; before?: string; after?: string }[];
  reinit: boolean;
  calls: Site[];
  instances: { name: string; uri: string; via?: string }[];
  tests: Site[];
}

export async function interfaceImpact(lsp: Lsp, arg?: unknown): Promise<Impact | undefined> {
  const uri = arg instanceof vscode.Uri ? arg : arg && typeof arg === "object" && "resourceUri" in arg ? (arg as { resourceUri?: vscode.Uri }).resourceUri : vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    void vscode.window.showWarningMessage("Open an FB, FC or data type of the workspace first.");
    return undefined;
  }
  const r = await lsp.request<Impact | { reason: string }>("rung/impact", { textDocument: { uri: uri.toString() } });
  if (!r || "reason" in r) {
    void vscode.window.showWarningMessage(r ? r.reason : "The rung language server is not running.");
    return undefined;
  }
  const impact = r;
  if (!impact.changes.length) {
    void vscode.window.showInformationMessage(`${impact.block}: the interface is the one TIA Portal has; nothing outside the block is affected.`);
    return impact;
  }
  type Item = vscode.QuickPickItem & { at?: { uri: string; line: number } };
  const items: Item[] = [{ label: "Changed against TIA Portal", kind: vscode.QuickPickItemKind.Separator }];
  for (const c of impact.changes)
    items.push({ label: c.kind === "renamed" ? `${c.name} → ${c.to}` : c.name, description: `${c.kind} · ${c.section}${c.before && c.after ? ` · ${c.before} → ${c.after}` : ` · ${c.after ?? c.before ?? ""}`}` });
  const site = (s: Site, icon: string): Item => ({ label: s.block || vscode.workspace.asRelativePath(vscode.Uri.parse(s.uri)), description: s.problems.length ? s.problems.join("; ") : "compiles again, unchanged", iconPath: new vscode.ThemeIcon(s.problems.length ? "error" : icon), at: { uri: s.uri, line: s.line } });
  if (impact.calls.length) items.push({ label: `Calls (${impact.calls.length})`, kind: vscode.QuickPickItemKind.Separator }, ...impact.calls.map((c) => site(c, "pass")));
  if (impact.instances.length) {
    items.push({ label: "Starts over from start values on download (reinitialised)", kind: vscode.QuickPickItemKind.Separator });
    for (const i of impact.instances) items.push({ label: i.name, description: i.via && !i.name.startsWith(`${i.via}.`) ? `through ${i.via}` : "", iconPath: new vscode.ThemeIcon("database"), at: { uri: i.uri, line: 1 } });
  }
  if (impact.tests.length) items.push({ label: "Tests", kind: vscode.QuickPickItemKind.Separator }, ...impact.tests.map((t) => site(t, "beaker")));
  const breaks = [...impact.calls, ...impact.tests].filter((s) => s.problems.length).length;
  const pick = await vscode.window.showQuickPick(items, { title: `${impact.block}: interface impact${breaks ? ` (${breaks} to fix)` : ""}`, placeHolder: "Pick a place to open it", matchOnDescription: true });
  if (pick?.at) {
    const line = Math.max(0, pick.at.line - 1);
    await vscode.window.showTextDocument(vscode.Uri.parse(pick.at.uri), { selection: new vscode.Range(line, 0, line, 0) });
  }
  return impact;
}
