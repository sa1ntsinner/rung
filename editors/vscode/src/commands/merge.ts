// SPDX-License-Identifier: MIT
// "Merge in Editor…": a conflict opens in VS Code's merge editor (your file, TIA Portal's version, their common base,
// from the .conflict file's markers); the result goes into the .conflict file, and saving it without markers hands
// it to rung resolve --merged, which makes it the file and sends it on the next sync.
import * as vscode from "vscode";
import { hasMarkers, splitConflict } from "../core/conflict";
import type { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";

class MergeDocs implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  set(key: string, text: string): vscode.Uri {
    this.texts.set(key, text);
    return vscode.Uri.from({ scheme: "rung-merge", path: "/" + key });
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.path.slice(1)) ?? "";
  }
}

export function registerMerge(context: vscode.ExtensionContext, ws: RungWorkspace, cli: RungCli): (uri: vscode.Uri, rel: string) => Promise<void> {
  const docs = new MergeDocs();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("rung-merge", docs));
  /** .conflict files waiting for their merge to be saved */
  const waiting = new Map<string, string>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const rel = waiting.get(doc.uri.toString());
      if (!rel || hasMarkers(doc.getText())) return;
      waiting.delete(doc.uri.toString());
      const r = await cli.run(["resolve", rel, "--merged"]);
      await ws.reload();
      if (!r.error && r.code === 0) void vscode.window.showInformationMessage(`${rel}: merged. The merged version goes to TIA Portal with the next sync.`);
    }),
  );

  return async (fileUri: vscode.Uri, rel: string) => {
    const conflictUri = fileUri.with({ path: fileUri.path + ".conflict" });
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(conflictUri)).toString("utf8");
    } catch {
      void vscode.window.showWarningMessage(`${rel} has no .conflict file to merge in. Keep your file or take TIA Portal's version.`);
      return;
    }
    const parts = splitConflict(text);
    if (!parts) {
      // already merged by hand, or markers rung did not write: the file itself, to finish there
      await vscode.window.showTextDocument(conflictUri);
      void vscode.window.showInformationMessage(`${rel}.conflict has no complete markers. Edit it, save, then Resolve with the merged version.`);
      return;
    }
    const name = rel.split("/").pop() ?? rel;
    const key = `${Date.now()}/${rel}`;
    try {
      await vscode.commands.executeCommand("_open.mergeEditor", {
        base: docs.set(`${key}/base/${name}`, parts.base),
        input1: { uri: docs.set(`${key}/file/${name}`, parts.file), title: "Your file", description: name },
        input2: { uri: docs.set(`${key}/tia/${name}`, parts.tia), title: "TIA Portal", description: name },
        output: conflictUri,
      });
    } catch {
      // the merge editor is VS Code's own command: if it is not there, the markers in the file itself
      await vscode.window.showTextDocument(conflictUri);
    }
    waiting.set(conflictUri.toString(), rel);
  };
}
