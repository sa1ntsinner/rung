// SPDX-License-Identifier: MIT
// TIA Portal compile messages from `rung compile` output → Problems panel ("rung compile" source).
// While rung watch runs, the language server also reports compile results of syncs.
import { join } from "node:path";
import * as vscode from "vscode";
import { isCompileSummary, parseCompileOutput } from "./core/args";
import type { RungWorkspace } from "./workspace";

export class CompileProblems implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("rung compile");

  constructor(private readonly ws: RungWorkspace) {}

  /** Replaces the problems of the last compile (a file compile only replaces that file's). */
  set(output: string, onlyFile?: string): void {
    const root = this.ws.root;
    if (!root) return;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const m of parseCompileOutput(output)) {
      // "Compiling finished (errors: 1; warnings: 0)" is TIA's summary, not a problem of its own
      if (!m.file || m.severity === "info" || isCompileSummary(m.message)) continue;
      const line = Math.max(0, (m.line ?? 1) - 1);
      const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), m.message, m.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = "TIA Portal";
      const list = byFile.get(m.file) ?? [];
      list.push(d);
      byFile.set(m.file, list);
    }
    if (onlyFile) {
      this.collection.set(vscode.Uri.file(join(root, onlyFile)), byFile.get(onlyFile) ?? []);
      for (const [f, list] of byFile) if (f !== onlyFile) this.collection.set(vscode.Uri.file(join(root, f)), list);
    } else {
      this.collection.clear();
      for (const [f, list] of byFile) this.collection.set(vscode.Uri.file(join(root, f)), list);
    }
  }

  dispose(): void {
    this.collection.dispose();
  }
}
