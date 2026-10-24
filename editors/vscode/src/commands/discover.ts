// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import * as vscode from "vscode";
import type { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";

type Outcome = { block: string; status: "found" | "not-found" | "unavailable"; summary: string; directory?: string };

/**
 * The open block against its previous version, or every changed block when no SCL file is open.
 * No revision to type: the CLI picks HEAD, or the version before the file's last commit when it is unchanged.
 */
export async function discoverBehaviour(context: vscode.ExtensionContext, ws: RungWorkspace, cli: RungCli): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document, root = ws.root;
  if (!root) { void vscode.window.showWarningMessage("Open a rung workspace to find a behavioural change."); return; }
  const single = !!doc && doc.uri.scheme === "file" && /\.(scl|st)$/i.test(doc.uri.fsPath);
  if (single && doc.isDirty) { void vscode.window.showWarningMessage("Save the file first: discovery compares the saved file with its previous version."); return; }
  const args = ["discover", ...(single ? ["--file", doc.uri.fsPath] : []), "--json"];
  const result = await cli.capture(args, { quiet: true, progress: single ? "Searching for an input sequence your change answers differently…" : "Searching every changed block…", cancellable: true });
  if (root !== ws.root) return;
  let reply: { version?: number; status?: string; directory?: string; reason?: string; referenceTest?: string; results?: Outcome[] };
  try { reply = JSON.parse(result.output) as typeof reply; }
  catch { void vscode.window.showErrorMessage("Discovery did not return evidence. See rung Output for the error."); return; }
  if (![0, 2].includes(result.code ?? -1) || reply.version !== 1) { void vscode.window.showErrorMessage(reply.reason ?? "Discovery is unavailable for this block. See rung Output."); return; }
  if (reply.results) {
    const found = reply.results.filter(r => r.status === "found");
    if (!found.length) { void vscode.window.showInformationMessage(`No behavioural difference found in ${reply.results.length} changed block${reply.results.length === 1 ? "" : "s"}. That does not prove they behave the same.`); return; }
    const pick = found.length === 1 ? found[0] : (await vscode.window.showQuickPick(reply.results.map(r => ({ label: `${r.status === "found" ? "$(diff)" : r.status === "not-found" ? "$(check)" : "$(question)"} ${r.block}`, description: r.summary, outcome: r })), { title: "Behavioural differences in changed blocks" }))?.outcome;
    if (pick?.directory) await open(context, root, pick.directory, ws);
    return;
  }
  if (typeof reply.directory === "string") await open(context, root, reply.directory, ws);
}

async function open(context: vscode.ExtensionContext, root: string, directory: string, ws: RungWorkspace): Promise<void> {
  const under = relative(join(root, ".rung", "discover"), directory);
  if (!under || under.startsWith("..") || isAbsolute(under)) { void vscode.window.showErrorMessage("Discovery returned a report outside its workspace evidence folder."); return; }
  const html = await readFile(join(directory, "report.html"), "utf8");
  const evidence = JSON.parse(await readFile(join(directory, "evidence.json"), "utf8")) as { config: { block: string }; referenceTest?: string };
  if (root !== ws.root) return;
  const panel = vscode.window.createWebviewPanel("rung.discovery", `Discovery: ${evidence.config.block}`, vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [] });
  panel.webview.html = html;
  context.subscriptions.push(panel);
  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const command = (message as { command?: unknown }).command;
    if (command !== "save-reference" && command !== "save-evidence") return;
    const test = command === "save-reference";
    if (test && !evidence.referenceTest) return;
    const destination = await vscode.window.showSaveDialog({ title: test ? "Save the behaviour before your change as a test: review its expectations" : "Save discovery evidence", defaultUri: vscode.Uri.file(join(root, test ? `tests/${evidence.config.block}.discovered.test.yaml` : "discovery-evidence.json")), filters: test ? { "rung test": ["yaml"] } : { JSON: ["json"] } });
    if (!destination) return;
    const text = test ? evidence.referenceTest! : await readFile(join(directory, "evidence.json"), "utf8");
    await vscode.workspace.fs.writeFile(destination, Buffer.from(text));
    if (test) await vscode.window.showTextDocument(destination);
  });
}
