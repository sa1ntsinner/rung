// SPDX-License-Identifier: MIT
// Compare with PLC (TIA's online/offline comparison) and Rename in TIA Portal.
import * as vscode from "vscode";
import { Args, parseCompare, parseRenamed } from "../core/args";
import { parseNoTarget } from "../core/connect";
import type { Output } from "../output";
import { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";
import type { ChangesView } from "../views/changesView";
import type { Connector } from "./connect";
import { deviceTarget, fileTarget } from "./targets";


export async function compareCommand(ws: RungWorkspace, cli: RungCli, out: Output, connector: Connector, changes: ChangesView, arg: unknown): Promise<void> {
  const d = await deviceTarget(ws, arg, "Compare with PLC");
  if (!d) return;
  let env = await connector.passwordEnv(d);
  let trustCertificate = false;
  let tlsRetried = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const args = Args.compare(d);
    if (trustCertificate) args.push("--trust-certificate");
    const r = await cli.capture(args, { progress: `rung: comparing ${d} with the PLC…`, cancellable: true, env });
    if (r.error || r.code === null) return;
    if (r.code !== 0 && /TLS_UNTRUSTED/.test(r.output) && !tlsRetried) {
      const pick = await vscode.window.showWarningMessage(
        `${d} shows a certificate TIA Portal does not trust.`,
        { modal: true, detail: `${r.output.trim()}\n\nTrust the certificate TIA Portal shows for this connection? This decision is not remembered.` },
        "Trust for This Connection",
      );
      if (pick !== "Trust for This Connection") return;
      tlsRetried = trustCertificate = true;
      attempt--; // the single certificate retry is in addition to connection/password retries
      continue;
    }
    if (r.code !== 0 && /PASSWORD_REQUIRED/.test(r.output)) {
      if (attempt === 2) {
        const pick = await vscode.window.showErrorMessage(`Comparing ${d} failed: ${RungCli.summary(r.output)}`, "Show output");
        if (pick) out.show();
        return;
      }
      const next = await connector.askPassword(d, r.output);
      if (!next) return;
      env = next;
      continue;
    }
    const noTarget = parseNoTarget(r.output);
    if (noTarget) {
      if (attempt === 2) {
        void vscode.window.showErrorMessage(`Comparing ${d} failed: ${RungCli.summary(r.output)}`);
        return;
      }
      if (!(await connector.choose(d, noTarget))) return;
      trustCertificate = tlsRetried = false;
      continue;
    }
    const result = parseCompare(r.output);
    if (!result) {
      const pick = await vscode.window.showErrorMessage(`Comparing ${d} failed: ${RungCli.summary(r.output)}`, "Show output");
      if (pick) out.show();
      return;
    }
    await ws.reload();
    // kept in the Changes view, next to what the next sync does
    changes.setComparison(d, result.identical, result.items);
    if (!result.items.length) {
      void vscode.window.showInformationMessage(`${d} runs what the project has (${result.identical} objects compared).`);
      return;
    }
    await vscode.commands.executeCommand("rung.changes.focus");
    return;
  }
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
