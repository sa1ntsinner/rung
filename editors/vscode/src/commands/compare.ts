// SPDX-License-Identifier: MIT
// Compare with PLC (TIA's online/offline comparison) and Rename in TIA Portal.
import * as vscode from "vscode";
import { Args, parseCompare, parseRenamed, type CompareItem } from "../core/args";
import { parseNoTarget } from "../core/connect";
import type { Output } from "../output";
import { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";
import type { Connector } from "./connect";
import { deviceTarget, fileTarget } from "./targets";

const LABEL: Record<string, string> = { Different: "differs", OnlyInProject: "only in the project", OnlyOnPlc: "only on the PLC" };
const ICON: Record<string, string> = { Different: "$(diff)", OnlyInProject: "$(file-add)", OnlyOnPlc: "$(cloud)" };

export async function compareCommand(ws: RungWorkspace, cli: RungCli, out: Output, connector: Connector, arg: unknown): Promise<void> {
  const d = await deviceTarget(ws, arg, "Compare with PLC");
  if (!d) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await cli.capture(Args.compare(d), { progress: `rung: comparing ${d} with the PLC…`, cancellable: true });
    if (r.error || r.code === null) return;
    const noTarget = parseNoTarget(r.output);
    if (noTarget) {
      if (!(await connector.choose(d, noTarget))) return;
      continue;
    }
    const result = parseCompare(r.output);
    if (!result) {
      const pick = await vscode.window.showErrorMessage(`Comparing ${d} failed: ${RungCli.summary(r.output)}`, "Show output");
      if (pick) out.show();
      return;
    }
    await ws.reload();
    if (!result.items.length) {
      void vscode.window.showInformationMessage(`${d} runs what the project has (${result.identical} objects compared).`);
      return;
    }
    await showDifferences(ws, d, result.items, result.identical);
    return;
  }
}

async function showDifferences(ws: RungWorkspace, device: string, items: CompareItem[], identical: number): Promise<void> {
  type Pick = vscode.QuickPickItem & { item: CompareItem };
  const picks: Pick[] = items.map((item) => ({
    label: `${ICON[item.state] ?? "$(question)"} ${item.name.replace(/ \[[^\]]*\]$/, "")}`,
    description: LABEL[item.state] ?? item.state,
    detail: item.file ?? item.path,
    item,
  }));
  const pick = await vscode.window.showQuickPick(picks, {
    title: `${device}: ${items.length} object${items.length > 1 ? "s" : ""} not as in the project (${identical} identical)`,
    placeHolder: "Open a file to see what the project has; download to make the PLC match",
    matchOnDetail: true,
  });
  if (!pick?.item.file || !ws.root) return;
  await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(ws.root), pick.item.file));
}

export async function renameCommand(ws: RungWorkspace, cli: RungCli, out: Output, arg: unknown): Promise<void> {
  const t = await fileTarget(ws, arg, undefined, "a block, PLC data type or tag table file");
  if (!t?.name) return;
  if (!ws.objectAt(t.uri.fsPath)) {
    void vscode.window.showWarningMessage(`${t.rel} is not a mirrored object yet. Run rung sync first.`);
    return;
  }
  const current = t.name;
  const next = await vscode.window.showInputBox({
    title: `Rename ${current} in TIA Portal`,
    prompt: "TIA Portal keeps every call, instance DB and access; the files and tests that use it are updated.",
    value: current,
    validateInput: (v) => (!v.trim() ? "Enter a name" : v.includes('"') ? "Names cannot contain quotes" : undefined),
  });
  if (!next || next.trim() === current) return;
  const doc = vscode.workspace.textDocuments.find((x) => x.uri.toString() === t.uri.toString());
  if (doc?.isDirty) await doc.save();
  const r = await cli.capture(Args.rename(t.rel, next.trim()), { progress: `rung: renaming ${current} in TIA Portal…` });
  if (r.error || r.code === null) return;
  if (r.code !== 0) {
    const pick = await vscode.window.showErrorMessage(`Renaming ${current} failed: ${RungCli.summary(r.output)}`, "Show output");
    if (pick) out.show();
    return;
  }
  await ws.reload();
  const file = parseRenamed(r.output);
  if (file && ws.root) await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(ws.root), file));
  void vscode.window.setStatusBarMessage(`rung: renamed ${current} to ${next.trim()}`, 5000);
}
