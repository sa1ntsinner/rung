// SPDX-License-Identifier: MIT
// "Compile · Test · Open in TIA Portal" above each block header. Never offers a download.
import * as vscode from "vscode";
import { findBlockHeaders } from "./core/headers";
import { readSettings } from "./settings";
import type { RungWorkspace } from "./workspace";

export class BlockCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly ws: RungWorkspace) {
    this.subs.push(
      vscode.languages.registerCodeLensProvider({ language: "scl", scheme: "file" }, this),
      ws.onDidChange(() => this.changed.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("rung.codeLens")) this.changed.fire();
      }),
    );
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!readSettings().codeLens || !this.ws.hasConfig || !this.ws.rel(doc.uri.fsPath)) return [];
    const lenses: vscode.CodeLens[] = [];
    const mirrored = !!this.ws.objectAt(doc.uri.fsPath);
    for (const h of findBlockHeaders(doc.getText())) {
      const range = new vscode.Range(h.line, h.column, h.line, h.column);
      if (mirrored) lenses.push(new vscode.CodeLens(range, { title: "Compile", tooltip: `rung compile --file (${h.name})`, command: "rung.compileFile", arguments: [doc.uri] }));
      if (h.keyword === "FUNCTION_BLOCK" || h.keyword === "FUNCTION")
        lenses.push(new vscode.CodeLens(range, { title: "Test", tooltip: `rung test --filter ${h.name} (offline simulator)`, command: "rung.testBlock", arguments: [doc.uri, h.name] }));
      if (mirrored) lenses.push(new vscode.CodeLens(range, { title: "Open in TIA Portal", tooltip: `Show ${h.name} in the TIA Portal editor`, command: "rung.openInTia", arguments: [doc.uri] }));
    }
    return lenses;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}
