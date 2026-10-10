// SPDX-License-Identifier: MIT
// VS Code extension for rung: language client, rung sidebar (Project, PLC), status bar, CodeLens and commands.
// Every action runs the rung CLI (setting rung.command); workspace files are only read here.
import { basename } from "node:path";
import * as vscode from "vscode";
import { BlockCodeLens } from "./codelens";
import { DeclarationsPanel } from "./declarations/panel";
import { TracePanel } from "./trace/panel";
import { UDT_TABLE, UdtTableEditor } from "./declarations/udtEditor";
import { TEST_TABLE, TestTableEditor } from "./tests/testEditor";
import type { RungTests } from "./testing";
import type { DeclarationsSession } from "./declarations/session";
import { UsagesView } from "./views/usagesView";
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
import { Activity } from "./core/activity";
import { OwnerEvents } from "./ownerEvents";
import { ActivityView } from "./views/activityView";
import { ChangesView } from "./views/changesView";
import { registerTests } from "./testing";
import { registerDebug } from "./debug";
import { WhyView } from "./views/whyView";
import { LiveView } from "./views/liveView";
import { LiveAccess } from "./liveAccess";
import { registerLiveCpuCommands } from "./liveMutation";
import { ObjectDecorations, ProjectView } from "./views/projectView";
import { PlcView } from "./views/plcView";
import { EnvironmentView, FIXES, type CheckItem } from "./views/environmentView";
import { RungWorkspace } from "./workspace";

let lsp: Lsp | undefined;
/** the test explorer, once the workspace has one (the test table runs its cases through it) */
let testsRef: RungTests | undefined;

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
  activity: Activity;
  changes: ChangesView;
  decorations: ObjectDecorations;
  lsp: Lsp;
  usages: UsagesView;
  /** the declarations panel, if open: its model and a way in for the view's messages */
  declarations: () => DeclarationsPanel | undefined;
  trace: () => TracePanel | undefined;
  /** the UDT tables open, by document */
  udtTables: Map<string, DeclarationsSession>;
  /** the test tables open, by document */
  testTables: typeof TestTableEditor.tables;
  tests: () => RungTests | undefined;
  why: import("./views/whyView").WhyView;
  live: import("./views/liveView").LiveView;
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
  registerDebug(context, ws, cli);
  const why = new WhyView(ws, cli);
  const access = new LiveAccess(ws, context.secrets);
  const live = new LiveView(ws, cli, context.workspaceState, lsp, access);
  context.subscriptions.push(why, live);

  await ws.start(context.workspaceState);
  context.subscriptions.push(
    vscode.commands.registerCommand("rung.chooseWorkspace", async () => {
      const items = ws.candidates().map((p) => ({ label: basename(p), description: p, picked: p === ws.root }));
      if (!items.length) return void vscode.window.showInformationMessage("No folder of this window has a rung.toml.");
      const pick = await vscode.window.showQuickPick(items, { title: "rung works on", placeHolder: "Choose the rung workspace" });
      if (!pick || pick.description === ws.root) return;
      // a watch started here keeps syncing the folder it was started in: say so, and offer to move it along
      if (watch.owned && watch.status !== "stopped") {
        const move = await vscode.window.showWarningMessage(`rung watch is running for ${basename(ws.root ?? "")}.`, { modal: true, detail: `It keeps syncing that folder until it is stopped. Switch to ${pick.label} and watch there instead?` }, "Switch and Watch There", "Switch Only");
        if (!move) return;
        if (move === "Switch and Watch There") {
          await watch.stop();
          await ws.choose(pick.description);
          await watch.start();
          return;
        }
      }
      await ws.choose(pick.description);
    }),
  );
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
  const plc = new PlcView(ws, online, watch, cli, access);
  // rung watch's events: the activity model hears them first, then the status bar and the view redraw
  const events = new OwnerEvents(ws);
  const activity = new Activity();
  context.subscriptions.push(events, events.onEvent(({ event, params, at }) => activity.event(event, params, at)));
  context.subscriptions.push(plc.listen(events));
  // rung watch waits for the person after an Openness refusal: one notification with the fix, not a retry loop
  let accessAsked = false;
  context.subscriptions.push(
    events.onEvent(({ event, params }) => {
      const p = params as { blocked?: boolean; code?: string };
      if (event !== "error" || !p?.blocked || p.code !== "ACCESS_DENIED" || accessAsked) return;
      accessAsked = true;
      void (async () => {
        const register = "Register rung with Openness";
        const pick = await vscode.window.showWarningMessage(
          "rung cannot reach TIA Portal yet: its bridge is not registered with TIA Portal Openness.",
          { detail: "Registering it once asks for administrator rights. If it is registered already, your Windows user must be in the group \"Siemens TIA Openness\"." },
          register,
          "Show Output",
        );
        if (pick === "Show Output") out.show();
        if (pick === register) {
          await cli.run(FIXES.whitelist!.args);
          await cli.capture(["sync"], { quiet: true }); // the waiting watch tries again
        }
        accessAsked = false;
      })();
    }),
  );
  const statusBar = new StatusBar(ws, watch, online, activity, events);
  const activityView = new ActivityView(ws, activity, events);
  const changes = new ChangesView(ws, cli, events);
  const decorations = new ObjectDecorations(ws);
  const environment = new EnvironmentView(cli);
  const monitor = new Monitor(ws, cli, out, access);
  why.captured = () => monitor.captured;
  context.subscriptions.push(monitor.onDidChange(() => why.invalidateCapture()));
  context.subscriptions.push(...registerLiveCpuCommands(ws, cli, access));
  context.subscriptions.push(
    monitor,
    vscode.commands.registerCommand("rung.monitor.toggle", (uri?: vscode.Uri) => monitor.toggle(uri instanceof vscode.Uri ? uri : undefined)),
    vscode.commands.registerCommand("rung.monitor.stop", () => monitor.stop()),
    vscode.commands.registerCommand("rung.monitor.reconstruct", (uri?: vscode.Uri) => monitor.reconstruct(uri instanceof vscode.Uri ? uri : undefined)),
  );
  const lens = new BlockCodeLens(ws);
  context.subscriptions.push(project, plc, environment, decorations, statusBar, activityView, changes, lens);
  context.subscriptions.push(
    DeclarationsPanel.register(context, { lsp, ws, monitor }),
    UdtTableEditor.register(context, { lsp, ws }),
    TestTableEditor.register(context, { lsp, ws, tests: () => testsRef }),
    vscode.commands.registerCommand("rung.test.openTable", (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (target) return vscode.commands.executeCommand("vscode.openWith", target, TEST_TABLE);
    }),
    vscode.commands.registerCommand("rung.udt.openTable", (uri?: vscode.Uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (target) return vscode.commands.executeCommand("vscode.openWith", target, UDT_TABLE);
    }),
    vscode.commands.registerCommand("rung.declarations.open", (uri?: vscode.Uri, position?: vscode.Position) =>
      DeclarationsPanel.show(context, { lsp: lsp!, ws, monitor }, uri instanceof vscode.Uri ? uri : undefined, position instanceof vscode.Position ? position : undefined),
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
  const usages = new UsagesView(lsp);
  context.subscriptions.push(usages);
  registerCommands(context, { ws, cli, out, watch, online, problems, project, lsp, usages, changes });
  const tests = registerTests(context, ws, cli);
  testsRef = tests;
  if (tests) lens.useTests(tests);

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

  // a restricted (untrusted) folder never starts TIA Portal on its own
  if (readSettings().autoStartWatch && vscode.workspace.isTrusted && ws.hasConfig && !ws.watching) void watch.start();
  return { ws, cli, watch, online, problems, project, plc, environment, monitor, statusBar, activity, changes, decorations, lsp, usages, declarations: () => DeclarationsPanel.open, trace: () => TracePanel.open, udtTables: UdtTableEditor.sessions, testTables: TestTableEditor.tables, tests: () => testsRef, why, live };
}

export async function deactivate(): Promise<void> {
  await lsp?.stop();
}
