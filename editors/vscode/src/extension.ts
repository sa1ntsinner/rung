// SPDX-License-Identifier: MIT
// VS Code client for rung: starts `rung lsp --stdio` and exposes the rung CLI as commands.
import * as vscode from "vscode";
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let watchTerminal: vscode.Terminal | undefined;

function rungCommand(): string[] {
  const cmd = vscode.workspace.getConfiguration("rung").get<string[]>("command") ?? ["rung"];
  return cmd.length ? cmd : ["rung"];
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function quote(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Runs a rung CLI command in a terminal so the user sees progress and hints. */
function runInTerminal(args: string[], name = "rung"): vscode.Terminal {
  const t = vscode.window.createTerminal({ name, cwd: workspaceRoot() });
  t.show(true);
  t.sendText([...rungCommand(), ...args].map(quote).join(" "));
  return t;
}

async function startClient(context: vscode.ExtensionContext) {
  const [command, ...prefix] = rungCommand();
  const serverOptions: ServerOptions = {
    command: command!,
    args: [...prefix, "lsp", "--stdio"],
    transport: TransportKind.stdio,
    options: { cwd: workspaceRoot() },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "scl" }],
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/plc/**/*.{scl,db,udt,awl,s7dcl,xml}") },
    outputChannelName: "rung",
  };
  client = new LanguageClient("rung", "rung language server", serverOptions, clientOptions);
  context.subscriptions.push(client);
  await client.start();
}

export async function activate(context: vscode.ExtensionContext) {
  const reg = (id: string, fn: () => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg("rung.pull", () => runInTerminal(["pull"]));
  reg("rung.sync", () => runInTerminal(["sync"]));
  reg("rung.status", () => runInTerminal(["status"]));
  reg("rung.watch", () => {
    if (watchTerminal && vscode.window.terminals.includes(watchTerminal)) watchTerminal.show();
    else watchTerminal = runInTerminal(["watch"], "rung watch");
  });
  const resolve = (mode: "--ours" | "--theirs") => {
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file) return vscode.window.showWarningMessage("Open the conflicted file first.");
    return runInTerminal(["resolve", file.replace(/\.(conflict|tia)$/, ""), mode]);
  };
  reg("rung.resolveOurs", () => resolve("--ours"));
  reg("rung.resolveTheirs", () => resolve("--theirs"));
  reg("rung.restartServer", async () => {
    await client?.stop();
    await startClient(context);
  });
  try {
    await startClient(context);
  } catch (e) {
    void vscode.window.showErrorMessage(`rung language server did not start (${String(e)}). Set "rung.command" to the rung executable.`);
  }
}

export async function deactivate() {
  await client?.stop();
}
