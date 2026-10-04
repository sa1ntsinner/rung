// SPDX-License-Identifier: MIT
// "Declarations · Compile · Test · Open in TIA Portal" above each block header ("Create test" for a block no test
// file names yet). Never offers a download.
import * as vscode from "vscode";
import { findBlockHeaders } from "./core/headers";
import { readSettings } from "./settings";
import type { RungWorkspace } from "./workspace";

export class BlockCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  private tests: { hasTests(block: string): boolean } | undefined;

  constructor(private readonly ws: RungWorkspace) {
    this.subs.push(
      vscode.languages.registerCodeLensProvider({ language: "scl", scheme: "file" }, this),
      ws.onDidChange(() => this.changed.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("rung.codeLens")) this.changed.fire();
      }),
    );
  }

  /** The workspace's tests: a block without any gets "Create test". */
  useTests(tests: { hasTests(block: string): boolean; onDidChangeBlocks: vscode.Event<void> }): void {
    this.tests = tests;
    this.subs.push(tests.onDidChangeBlocks(() => this.changed.fire()));
    this.changed.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!readSettings().codeLens) return [];
    // the declarations table needs only the language server; the rest needs a rung workspace
    const inWorkspace = this.ws.hasConfig && !!this.ws.rel(doc.uri.fsPath);
    const lenses: vscode.CodeLens[] = [];
    const mirrored = inWorkspace && !!this.ws.objectAt(doc.uri.fsPath);
    for (const h of findBlockHeaders(doc.getText())) {
      const range = new vscode.Range(h.line, h.column, h.line, h.column);
      lenses.push(new vscode.CodeLens(range, { title: "Declarations", tooltip: `The interface of ${h.name} as a table`, command: "rung.declarations.open", arguments: [doc.uri, new vscode.Position(h.line, h.column)] }));
      if (!inWorkspace) continue;
      if (mirrored) lenses.push(new vscode.CodeLens(range, { title: "Compile", tooltip: `rung compile --file (${h.name})`, command: "rung.compileFile", arguments: [doc.uri] }));
      if (h.keyword === "FUNCTION_BLOCK" || h.keyword === "FUNCTION")
        lenses.push(
          this.tests && !this.tests.hasTests(h.name)
            ? new vscode.CodeLens(range, { title: "Create test", tooltip: `A first test of ${h.name}: its inputs, one cycle, its outputs`, command: "rung.test.create", arguments: [doc.uri, new vscode.Position(h.line, h.column)] })
            : new vscode.CodeLens(range, { title: "Test", tooltip: `rung test --filter ${h.name} (offline simulator)`, command: "rung.testBlock", arguments: [doc.uri, h.name] }),
        );
      if (mirrored) lenses.push(new vscode.CodeLens(range, { title: "Open in TIA Portal", tooltip: `Show ${h.name} in the TIA Portal editor`, command: "rung.openInTia", arguments: [doc.uri] }));
    }
    return lenses;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}
