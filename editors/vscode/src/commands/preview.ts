// SPDX-License-Identifier: MIT
// "Preview Sync": what the next sync would send to TIA Portal and bring into the files, before anything is written.
// The CLI decides (rung sync --preview --json, the sync engine itself); this shows the list and opens each change as
// a diff of the side it lands on.
import * as vscode from "vscode";
import { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";
import { ICON, SENT, describe, parsePreview, type PlanEntry } from "../core/preview";

/** Virtual documents for the diffs: rung-preview:/<n>/<side>/<file>. */
class PreviewDocs implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  set(key: string, text: string): vscode.Uri {
    this.texts.set(key, text);
    return vscode.Uri.from({ scheme: "rung-preview", path: "/" + key });
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.path.slice(1)) ?? "";
  }
}

export function registerPreview(context: vscode.ExtensionContext, ws: RungWorkspace, cli: RungCli): () => Promise<void> {
  const docs = new PreviewDocs();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("rung-preview", docs));
  let run = 0;
  return async () => {
    const r = await cli.capture(["sync", "--preview", "--json"], { progress: "rung: what would the next sync do?", cancellable: true });
    if (r.error || r.code === null) return;
    const report = r.code === 0 ? parsePreview(r.output) : undefined;
    if (!report?.plan) {
      void vscode.window.showErrorMessage(`rung sync --preview failed: ${RungCli.summary(r.output)}`);
      return;
    }
    const { entries, compile } = report.plan;
    if (!entries.length) {
      void vscode.window.showInformationMessage("Files and TIA Portal agree: the next sync has nothing to do.");
      return;
    }
    const n = ++run;
    type Item = vscode.QuickPickItem & { entry?: PlanEntry; command?: string };
    const items: Item[] = entries.map((e) => {
      const d = describe(e);
      return { label: `$(${ICON[e.action]}) ${d.label}`, description: d.description, detail: e.path, entry: e };
    });
    const sends = entries.some((e) => SENT.has(e.action));
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    if (sends && report.writesOff) items.push({ label: "$(unlock) Turn on writes to TIA Portal", description: "then these go with the next sync", command: "rung.writes.on" });
    else items.push({ label: "$(sync) Sync now", description: compile.length ? `then compiles ${compile.length} object${compile.length > 1 ? "s" : ""}` : "", command: "rung.sync" });
    const pick = await vscode.window.showQuickPick(items, {
      title: `Next sync: ${entries.length} change${entries.length > 1 ? "s" : ""}${report.writesOff && sends ? " (writes to TIA Portal are off)" : ""}`,
      placeHolder: "Pick one to see its lines",
      matchOnDetail: true,
    });
    if (!pick) return;
    if (pick.command) {
      await vscode.commands.executeCommand(pick.command);
      return;
    }
    const e = pick.entry!;
    const file = e.path.split("/").pop() ?? e.path;
    if (e.before !== undefined && e.after !== undefined) {
      const left = docs.set(`${n}/before/${e.path}`, e.before);
      const right = docs.set(`${n}/after/${e.path}`, e.after);
      const side = SENT.has(e.action) ? "TIA Portal" : "file";
      await vscode.commands.executeCommand("vscode.diff", left, right, `${file}: ${side} now ↔ after the sync`);
    } else if (ws.root) await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(ws.root), ...e.path.split("/")));
  };
}
