// SPDX-License-Identifier: MIT
// VS Code extension for rung: language client, rung sidebar (Project, PLC), status bar, CodeLens and commands.
// Every action runs the rung CLI (setting rung.command); workspace files are only read here.
import * as vscode from "vscode";
import { BlockCodeLens } from "./codelens";
import { registerCommands } from "./commands";
import { Args } from "./core/args";
import { Lsp } from "./lsp";
import { OnlineMonitor } from "./online";
import { Output } from "./output";
import { CompileProblems } from "./problems";
import { RungCli } from "./runner/cli";
import { TerminalPool } from "./runner/terminal";
import { WatchController } from "./runner/watch";
import { readSettings } from "./settings";
import { StatusBar } from "./statusBar";
import { ObjectDecorations, ProjectView } from "./views/projectView";
import { PlcView } from "./views/plcView";
import { RungWorkspace } from "./workspace";

let lsp: Lsp | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const out = new Output();
  const ws = new RungWorkspace(out);
  const terminals = new TerminalPool();
  const cli = new RungCli(ws, out, terminals);
  const watch = new WatchController(ws, cli, out);
  const online = new OnlineMonitor(ws, cli);
  const problems = new CompileProblems(ws);
  lsp = new Lsp(ws, cli, out);
  context.subscriptions.push(out, ws, terminals, cli, watch, online, problems, lsp);

  await ws.start();

  const project = new ProjectView(ws);
  const plc = new PlcView(ws, online, watch);
  context.subscriptions.push(project, plc, new ObjectDecorations(ws), new StatusBar(ws, watch, online), new BlockCodeLens(ws));
  registerCommands(context, { ws, cli, out, watch, online, problems, project, lsp });

  // Refresh views after every CLI command (state.json changes are also picked up by the file watcher).
  context.subscriptions.push(
    cli.onDidFinish(({ args }) => {
      ws.scheduleReload(100);
      const [cmd] = args;
      if (cmd === "init") void lsp?.restart();
    }),
  );

  // Optional compile on save; with rung watch running, watch imports and compiles the change itself.
  let compiling = false;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (compiling || doc.languageId !== "scl" || !readSettings().compileOnSave || !ws.hasConfig || ws.watching) return;
      const o = ws.objectAt(doc.uri.fsPath);
      if (!o || o.readOnly) return;
      compiling = true;
      void cli
        .run(Args.compileFile(o.path, o.device))
        .then((r) => problems.set(r.output, o.path))
        .finally(() => (compiling = false));
    }),
  );

  void lsp.start();

  if (readSettings().autoStartWatch && ws.hasConfig && !ws.watching) void watch.start();
}

export async function deactivate(): Promise<void> {
  await lsp?.stop();
}
