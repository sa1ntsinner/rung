// SPDX-License-Identifier: MIT
// VS Code extension for rung: language client, rung sidebar (Project, PLC), status bar, CodeLens and commands.
// Every action runs the rung CLI (setting rung.command); workspace files are only read here.
import * as vscode from "vscode";
import { BlockCodeLens } from "./codelens";
import { DeclarationsPanel } from "./declarations/panel";
import { registerCommands } from "./commands";
import { Args } from "./core/args";
import { addToUserPath, installBundledRung, onPath } from "./bundled";
import { findExecutable } from "./core/exec";
import { isFile } from "./workspace";
import { Lsp } from "./lsp";
import { Monitor } from "./monitor";
import { OnlineMonitor } from "./online";
import { Output } from "./output";
import { CompileProblems } from "./problems";
import { RungCli } from "./runner/cli";
import { TerminalPool } from "./runner/terminal";
import { WatchController } from "./runner/watch";
import { readSettings } from "./settings";
import { StatusBar } from "./statusBar";
import { registerTests } from "./testing";
import { ObjectDecorations, ProjectView } from "./views/projectView";
import { PlcView } from "./views/plcView";
import { EnvironmentView, FIXES, type CheckItem } from "./views/environmentView";
import { RungWorkspace } from "./workspace";

let lsp: Lsp | undefined;

/** Returned by activate(): the pieces the integration tests (test-e2e) look at. Not a stable API. */
export interface RungExtensionApi {
  ws: RungWorkspace;
  cli: RungCli;
  watch: WatchController;
  online: OnlineMonitor;
  problems: CompileProblems;
  project: ProjectView;
  plc: PlcView;
  environment: EnvironmentView;
  monitor: Monitor;
  statusBar: StatusBar;
  decorations: ObjectDecorations;
  lsp: Lsp;
}

export async function activate(context: vscode.ExtensionContext): Promise<RungExtensionApi> {
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
  // the rung that comes with the extension, only when none is installed (rung on PATH, or rung.command set); it
  // lives in the extension's own storage folder
  const command = readSettings().command;
  const installed = !(command.length === 1 && command[0] === "rung") || !!findExecutable("rung", { platform: process.platform, env: process.env, isFile });
  RungCli.bundledBase = context.globalStorageUri.fsPath;
  RungCli.bundled = installed
    ? undefined
    : await installBundledRung(context.extensionPath, RungCli.bundledBase, (s) => out.info(s)).catch((e: Error) => {
        out.info(`the rung that comes with the extension could not be set up: ${e.message}`);
        return undefined;
      });

  const project = new ProjectView(ws);
  const plc = new PlcView(ws, online, watch);
  const statusBar = new StatusBar(ws, watch, online);
  const decorations = new ObjectDecorations(ws);
  const environment = new EnvironmentView(cli);
  const monitor = new Monitor(ws, cli, out, context.secrets);
  context.subscriptions.push(
    monitor,
    vscode.commands.registerCommand("rung.monitor.toggle", (uri?: vscode.Uri) => monitor.toggle(uri instanceof vscode.Uri ? uri : undefined)),
    vscode.commands.registerCommand("rung.monitor.stop", () => monitor.stop()),
  );
  context.subscriptions.push(project, plc, environment, decorations, statusBar, new BlockCodeLens(ws));
  context.subscriptions.push(
    DeclarationsPanel.register(context, { lsp, ws }),
    vscode.commands.registerCommand("rung.declarations.open", (uri?: vscode.Uri, position?: vscode.Position) =>
      DeclarationsPanel.show(context, { lsp: lsp!, ws }, uri instanceof vscode.Uri ? uri : undefined, position instanceof vscode.Position ? position : undefined),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("rung.env.refresh", () => environment.refresh()),
    vscode.commands.registerCommand("rung.installCommand", async () => {
      // terminals and agents start `rung` from PATH: the copy the extension keeps up to date goes there
      const dir = RungCli.bundledBase;
      if (!RungCli.bundled || !dir) {
        void vscode.window.showInformationMessage(
          findExecutable("rung", { platform: process.platform, env: process.env, isFile }) ? "rung is on PATH already." : "This build of the extension carries no rung of its own; install rung from its release and put it on PATH.",
        );
        return;
      }
      if (onPath(dir)) {
        void vscode.window.showInformationMessage(`rung is on PATH already (${dir}).`);
        return;
      }
      const go = await vscode.window.showInformationMessage(`Put rung on your PATH, so terminals and AI agents can start it? This adds ${dir} to your user PATH; new terminals see it.`, { modal: true }, "Add to PATH");
      if (go !== "Add to PATH") return;
      await addToUserPath(dir);
      void vscode.window.showInformationMessage(`${dir} is on your user PATH now. Open a new terminal (or restart the agent) to use rung there.`);
      await environment.refresh();
    }),
    vscode.commands.registerCommand("rung.env.fix", async (item?: CheckItem) => {
      const fix = item && FIXES[item.id];
      if (!fix) return;
      await cli.run(fix.args, { terminal: "rung setup", icon: "tools" });
      await environment.refresh();
    }),
    vscode.commands.registerCommand("rung.assignments", async () => {
      // TIA Portal's assignment list: which I/O and memory addresses are used, by which tag, where
      const r = await cli.capture(["assignments"], { progress: "rung: collecting the assignment list…" });
      if (r.error) return;
      const doc = await vscode.workspace.openTextDocument({ content: r.output, language: "plaintext" });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand("rung.setup", async () => {
      await cli.run(["setup"], { terminal: "rung setup", icon: "tools" });
      await environment.refresh();
    }),
  );
  registerCommands(context, { ws, cli, out, watch, online, problems, project, lsp });
  registerTests(context, ws, cli);

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
  return { ws, cli, watch, online, problems, project, plc, environment, monitor, statusBar, decorations, lsp };
}

export async function deactivate(): Promise<void> {
  await lsp?.stop();
}
