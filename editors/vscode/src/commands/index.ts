// SPDX-License-Identifier: MIT
// Registers every rung.* command. The CLI does the work; commands pick the target, run it and refresh.
import { join } from "node:path";
import * as vscode from "vscode";
import { Args, parseOnlineState } from "../core/args";
import { initCommand } from "./init";
import { parseNoTarget } from "../core/connect";
import { noTestsHint } from "../core/testItems";
import type { Lsp } from "../lsp";
import type { OnlineMonitor } from "../online";
import type { Output } from "../output";
import type { CompileProblems } from "../problems";
import { RungCli } from "../runner/cli";
import type { RunResult } from "../runner/terminal";
import type { WatchController } from "../runner/watch";
import type { ProjectView } from "../views/projectView";
import { isFile, type RungWorkspace } from "../workspace";
import { Connector } from "./connect";
import { compareCommand, renameCommand } from "./compare";
import { downloadCommand } from "./download";
import { interfacesCommand } from "./interfaces";
import { pickUsages, whoWrites } from "./usages";
import { createTest } from "./createTest";
import { recordExpectations } from "./record";
import { crossReference } from "./xref";
import { interfaceImpact } from "./impact";
import { compareBehaviour } from "./behaviour";
import { newObjectCommand } from "./newObject";
import type { UsagesView } from "../views/usagesView";
import type { ChangesView } from "../views/changesView";
import type { PlanEntry } from "../core/preview";
import { registerMerge } from "./merge";
import { deviceTarget, fileTarget } from "./targets";
import {projectAssets,type ProjectAssetsOptions} from "./projectAssets";
import {TraceCommands} from "./trace";

export interface Services {
  ws: RungWorkspace;
  cli: RungCli;
  out: Output;
  watch: WatchController;
  online: OnlineMonitor;
  problems: CompileProblems;
  project: ProjectView;
  lsp: Lsp;
  usages: UsagesView;
  changes: ChangesView;
}

const DOCS = "https://github.com/sa1ntsinner/rung/blob/main/docs/editors/README.md";

function needsWorkspace(ws: RungWorkspace): boolean {
  if (ws.hasConfig) return true;
  void vscode.window
    .showWarningMessage("This folder is not a rung workspace (no rung.toml).", "Open TIA Project…")
    .then((p) => p && vscode.commands.executeCommand("rung.init"));
  return false;
}

export function registerCommands(context: vscode.ExtensionContext, s: Services): void {
  const { ws, cli, out, watch, online, problems } = s;
  const connector = new Connector(ws, cli, out, context.secrets);
  const trace = new TraceCommands(context,ws,cli,connector);
  context.subscriptions.push(trace);
  const reg = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const inWs =
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      needsWorkspace(ws) ? fn(...args) : undefined;

  reg("rung.projectAssets",inWs((options?:unknown)=>projectAssets(s,(options&&typeof options==="object"?options:{}) as ProjectAssetsOptions)));
  reg("rung.projectAssets.apply",inWs(()=>projectAssets(s,{apply:true})));
  reg("rung.traceRecord",inWs((options?:unknown)=>trace.record(options)));
  reg("rung.traceOpen",(file?:unknown)=>trace.open(file));
  reg("rung.traceImport",()=>trace.importCsv());

  // --- sync
  /** After pull / sync: point at new conflicts (the terminal has the details). */
  const afterSync = (r: RunResult) => {
    if (r.error || r.code === 0) return;
    void ws.reload().then(async () => {
      const n = ws.conflicts.length;
      if (!n) return;
      const pick = await vscode.window.showWarningMessage(
        `${n} conflict${n > 1 ? "s" : ""}: ${ws.conflicts.slice(0, 3).join(", ")}${n > 3 ? ", …" : ""}. Changed here and in TIA Portal; keep your file or take TIA's version.`,
        "Show in Project view",
      );
      if (pick) await vscode.commands.executeCommand("rung.project.focus");
    });
  };
  reg(
    "rung.pull",
    inWs(async () => {
      // pull needs the workspace state for itself; rung watch holds it (and keeps the files current anyway)
      if (ws.watching) {
        const stop = watch.owned ? "Stop watch and pull" : undefined;
        const pick = await vscode.window.showInformationMessage(
          "rung watch is running and already keeps the files and TIA Portal in sync, so a pull is not needed. To pull anyway, stop watch first.",
          ...(stop ? [stop] : []),
        );
        if (pick !== stop || !stop) return;
        await watch.stop();
        if (ws.watching) return;
      }
      afterSync(await cli.run(["pull"]));
    }),
  );
  reg(
    "rung.sync",
    inWs(async () => afterSync(await cli.run(["sync"]))),
  );
  reg("rung.status", inWs(() => cli.run(["status"])));
  reg("rung.views", inWs(() => cli.run(["views"])));
  reg("rung.watch.start", inWs(() => watch.start()));
  reg("rung.watch.stop", () => watch.stop());
  reg("rung.watch.toggle", inWs(() => watch.toggle()));
  reg("rung.watch.show", () => watch.show());
  // writes into the project: off after rung init; a running watch started its bridge without them, so it restarts
  const setWrites = (on: boolean) =>
    inWs(async () => {
      const r = await cli.run(["writes", on ? "on" : "off"]);
      if (r.error || r.code !== 0) return;
      await ws.reload();
      if (watch.owned && watch.status === "running") {
        await watch.stop();
        await watch.start();
      } else if (ws.watching) void vscode.window.showInformationMessage("rung watch runs outside VS Code: restart it there for this to apply.");
    });
  reg("rung.writes.on", setWrites(true));
  reg("rung.writes.off", setWrites(false));
  // what the next sync does: the Changes view, kept on screen while each change is looked at
  reg(
    "rung.preview",
    inWs(async () => {
      await vscode.commands.executeCommand("rung.changes.focus");
      await s.changes.refresh();
    }),
  );
  reg("rung.changes.refresh", inWs(() => s.changes.refresh()));
  reg("rung.changes.sync", inWs(() => s.changes.syncReviewed()));
  reg("rung.changes.open", (e: unknown) => (e && typeof e === "object" && "path" in e ? s.changes.open(e as PlanEntry) : undefined));
  reg("rung.whoWrites", () => whoWrites(s.usages));
  reg("rung.usages.pick", () => pickUsages(s.lsp));
  reg("rung.usages.refresh", () => s.usages.refresh());
  reg("rung.usages.history", () => s.usages.pickHistory());
  reg("rung.newObject", () => newObjectCommand(s.lsp, s.ws));
  // Insert in a table adds a row there; the webview also hands the key to VS Code, where it would switch the
  // text editor's overtype mode
  reg("rung.tableKey", () => undefined);
  reg("rung.compareBehaviour", (rev?: unknown) => compareBehaviour(s.ws, s.cli, typeof rev === "string" ? rev : undefined));
  reg("rung.xref", (arg?: unknown) => crossReference(s.ws, s.cli, arg));
  reg("rung.impact", (arg?: unknown) => interfaceImpact(s.lsp, arg));
  reg("rung.test.record", (uri?: unknown, caseIndex?: unknown, stepIndex?: unknown) => recordExpectations(s.ws, s.cli, s.lsp, uri instanceof vscode.Uri ? uri : undefined, typeof caseIndex === "number" ? caseIndex : undefined, typeof stepIndex === "number" ? stepIndex : undefined));
  reg("rung.test.create", (uri?: unknown, position?: unknown) => createTest(s.lsp, s.ws, uri instanceof vscode.Uri ? uri : undefined, position instanceof vscode.Position ? position : undefined));
  reg("rung.usages.show", (uri, position, symbol) => {
    if (uri instanceof vscode.Uri && position instanceof vscode.Position) return s.usages.show(uri, position, typeof symbol === "string" ? symbol : "this");
  });

  // --- compile / test
  reg(
    "rung.compileFile",
    inWs(async (arg) => {
      const t = await fileTarget(ws, arg, undefined, "a mirrored block file");
      if (!t) return;
      if (!ws.objectAt(t.uri.fsPath)) {
        void vscode.window.showWarningMessage(`${t.rel} is not a mirrored object yet. Run rung sync first.`);
        return;
      }
      await saveIfDirty(t.uri);
      const r = await cli.run(Args.compileFile(t.rel, t.device));
      problems.set(r.output, t.rel);
    }),
  );
  reg(
    "rung.compilePlc",
    inWs(async (arg) => {
      const d = await deviceTarget(ws, arg, "Compile");
      if (!d) return;
      const r = await cli.run(Args.compilePlc(d));
      problems.set(r.output);
    }),
  );
  reg(
    "rung.compileHardware",
    inWs(async (arg) => {
      const d = await deviceTarget(ws, arg, "Compile hardware");
      if (d) await cli.run(Args.compileHardware(d));
    }),
  );
  // rung test also works in TwinCAT / plain ST folders without rung.toml
  reg("rung.testAll", () => cli.run(Args.testAll()));
  reg("rung.testBlock", async (arg, name) => {
    const t = await fileTarget(ws, arg, name, "a block file");
    if (!t?.name) return;
    await saveIfDirty(t.uri);
    const r = await cli.run(Args.testBlock(t.name));
    const hint = noTestsHint(t.name, r.code);
    if (!r.error && hint) void vscode.window.showInformationMessage(hint);
  });

  // --- online
  // rung online finds the PLC itself and saves [plc.X]; when it cannot decide (NO_TARGET) the Connector
  // asks, saves the choice and the action runs again.
  const onlineAction = (mode: "online" | "offline") =>
    inWs(async (arg) => {
      const d = await deviceTarget(ws, arg, mode === "online" ? "Go online" : "Go offline");
      if (!d) return;
      let env = mode === "online" ? await connector.passwordEnv(d) : {};
      let trustCertificate = false;
      let tlsRetried = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        online.set(d, { ...online.get(d), checking: true });
        const args = mode === "online" ? Args.online(d) : Args.offline(d);
        if (trustCertificate) args.push("--trust-certificate");
        const r = await cli.capture(args, {
          progress: mode === "online" ? (ws.config?.plc[d] ? `rung: going online with ${d}…` : `rung: looking for ${d} on the network and going online…`) : `rung: going offline from ${d}…`,
          cancellable: true,
          env,
        });
        if (mode === "online" && !r.error && r.code !== null && r.code !== 0 && /TLS_UNTRUSTED/.test(r.output) && !tlsRetried) {
          online.set(d, { checking: false, error: RungCli.summary(r.output), at: Date.now() });
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
        if (mode === "online" && !r.error && r.code !== 0 && /PASSWORD_REQUIRED/.test(r.output)) {
          online.set(d, { ...online.get(d), checking: false });
          if (attempt === 2) {
            void showFailure(out, `${d} is not online`, r.output);
            return;
          }
          const next = await connector.askPassword(d, r.output);
          if (!next) return;
          env = next;
          continue;
        }
        const st = parseOnlineState(r.output);
        const noTarget = parseNoTarget(r.output);
        const error = noTarget?.kind === "notFound" ? "not found on the network" : noTarget ? "no connection chosen" : RungCli.summary(r.output);
        // no state in the output: what was shown before is no longer known
        online.set(d, st ? { state: st.state, checking: false, at: Date.now() } : { checking: false, error, at: Date.now() });
        if (r.error || r.code === null) return;
        if (r.code === 0) {
          // rung may have just saved the connection it found: show it in the PLC view now
          await ws.reload();
          void vscode.window.setStatusBarMessage(`rung: ${d} ${st?.state ?? mode}`, 4000);
          return;
        }
        if (mode === "online" && noTarget) {
          if (attempt === 2) {
            void showFailure(out, `${d} is not online`, r.output);
            return;
          }
          if (!(await connector.choose(d, noTarget))) return;
          trustCertificate = tlsRetried = false;
          continue;
        }
        if (mode === "online" && st) {
          if (attempt === 2) {
            void showFailure(out, `${d} is not online`, r.output);
            return;
          }
          // rung reached TIA Portal, but the PLC did not come online (e.g. NotReachable): offer another connection
          const pick = await vscode.window.showErrorMessage(`${d} is not online (${st.state}).`, "Choose connection…", "Show output");
          if (pick === "Show output") out.show();
          if (pick !== "Choose connection…" || !(await connector.choose(d))) return;
          trustCertificate = tlsRetried = false;
          continue;
        }
        void showFailure(out, mode === "online" ? `${d} is not online` : `Going offline failed`, r.output);
        return;
      }
    });
  reg("rung.goOnline", onlineAction("online"));
  reg("rung.goOffline", onlineAction("offline"));
  reg(
    "rung.onlineState",
    inWs(async (arg) => {
      const d = arg ? await deviceTarget(ws, arg, "Online state") : undefined;
      await online.refresh(d);
      const devices = d ? [d] : ws.devices();
      const text = devices.map((x) => `${x}: ${online.get(x).state ?? `unknown (${online.get(x).error ?? "not checked"})`}`).join(", ");
      void vscode.window.showInformationMessage(`Online state: ${text}`);
    }),
  );
  reg("rung.refreshPlc", inWs(() => online.refresh()));
  reg(
    "rung.connect",
    inWs(async (arg) => {
      const d = await deviceTarget(ws, arg, "Connect");
      if (d) await connector.choose(d);
    }),
  );
  reg("rung.interfaces", inWs((arg) => interfacesCommand(ws, cli, connector, arg)));
  reg("rung.download", inWs((arg) => downloadCommand(ws, cli, online, connector, arg)));
  reg("rung.compare", inWs((arg) => compareCommand(ws, cli, out, connector, s.changes, arg)));
  reg("rung.rename", inWs((arg) => renameCommand(ws, cli, out, arg)));

  // --- TIA Portal / conflicts
  reg("rung.session.release", inWs(async () => {
    const progress = "rung: releasing the project from background TIA Portal…";
    let r = await cli.capture(["session", "--release"], { progress });
    if (!r.error && r.code !== 0 && /PROJECT_UNSAVED/.test(r.output)) {
      const save = "Save and Release";
      const pick = await vscode.window.showWarningMessage("The project has unsaved changes in rung's background TIA Portal. Save them before closing the project?", { modal: true }, save);
      if (pick !== save) return;
      r = await cli.capture(["session", "--release", "--save"], { progress });
    }
    if (r.error || r.code === 0) return;
    void showFailure(out, "Could not release the project", r.output);
  }));
  reg(
    "rung.openInTia",
    inWs(async (arg) => {
      const t = await fileTarget(ws, arg, undefined, "a mirrored block file");
      if (!t) return;
      // with no TIA Portal window on the project, rung opens one (and moves the project out of its background TIA Portal)
      const progress = `rung: opening ${t.name ?? t.rel} in TIA Portal (a new TIA Portal window takes about a minute)…`;
      let r = await cli.capture(Args.open(t.rel), { progress });
      if (!r.error && r.code !== 0 && /PROJECT_UNSAVED/.test(r.output)) {
        const save = "Save and Open";
        const pick = await vscode.window.showWarningMessage(
          `The project has unsaved changes in rung's background TIA Portal. Opening ${t.name ?? t.rel} in a TIA Portal window closes it there first.`,
          { modal: true },
          save,
        );
        if (pick !== save) return;
        r = await cli.capture(Args.open(t.rel, true), { progress });
      }
      if (r.error || r.code === 0) return;
      void showFailure(out, "Could not open it in TIA Portal", r.output);
    }),
  );
  const merge = registerMerge(context, ws, cli);
  reg(
    "rung.resolveMerge",
    inWs(async (arg) => {
      const t = await fileTarget(ws, arg, undefined, "the conflicted file");
      if (!t) return;
      const o = ws.objectAt(t.uri.fsPath);
      if (o && o.status !== "conflicted") return void vscode.window.showInformationMessage(`${o.path} has no conflict.`);
      const rel = o?.path ?? t.rel.replace(/\.(conflict|tia)$/, "");
      await merge(vscode.Uri.joinPath(vscode.Uri.file(ws.root!), ...rel.split("/")), rel);
    }),
  );
  const resolve = (mode: "ours" | "theirs") =>
    inWs(async (arg) => {
      const t = await fileTarget(ws, arg, undefined, "the conflicted file");
      if (!t) return;
      const o = ws.objectAt(t.uri.fsPath);
      if (o && o.status !== "conflicted") {
        void vscode.window.showInformationMessage(`${o.path} has no conflict.`);
        return;
      }
      const target = o?.path ?? t.rel;
      const ok = await vscode.window.showWarningMessage(
        mode === "ours" ? `Keep your file for ${target}?` : `Take TIA Portal's version of ${target}?`,
        { modal: true, detail: mode === "ours" ? "Your file wins; it is sent to TIA Portal on the next sync." : "Your changes to this file are replaced by the version in TIA Portal." },
        mode === "ours" ? "Keep my file" : "Take TIA version",
      );
      if (!ok) return;
      const r = await cli.capture(Args.resolve(target, mode));
      if (r.error) return;
      if (r.code === 0) void vscode.window.showInformationMessage(r.output.trim().split(/\r?\n/).pop() ?? "resolved");
      else void showFailure(out, "rung resolve failed", r.output);
    });
  reg("rung.resolveOurs", resolve("ours"));
  reg("rung.resolveTheirs", resolve("theirs"));

  // --- workspace
  reg("rung.openConfig", async () => {
    if (!ws.root || !isFile(join(ws.root, "rung.toml"))) return needsWorkspace(ws);
    await vscode.window.showTextDocument(vscode.Uri.file(join(ws.root, "rung.toml")), { preview: false });
  });
  reg("rung.showOutput", () => out.show());
  reg("rung.refresh", () => s.project.refresh());
  reg("rung.projectView.groupByKind", () => vscode.workspace.getConfiguration("rung").update("projectView.grouping", "kind", vscode.ConfigurationTarget.Workspace));
  reg("rung.projectView.groupByFolder", () => vscode.workspace.getConfiguration("rung").update("projectView.grouping", "folder", vscode.ConfigurationTarget.Workspace));
  reg("rung.restartServer", () => s.lsp.restart());
  reg("rung.init", () => initCommand(ws, cli, context));
  reg("rung.openDocs", () => vscode.env.openExternal(vscode.Uri.parse(DOCS)));
  reg("rung.quickPick", () => quickPick(ws, watch));
}

async function saveIfDirty(uri: vscode.Uri): Promise<void> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc?.isDirty) await doc.save();
}

async function showFailure(out: Output, title: string, output: string): Promise<void> {
  const pick = await vscode.window.showErrorMessage(`${title}: ${RungCli.summary(output)}`, "Show output");
  if (pick) out.show();
}


interface ActionItem extends vscode.QuickPickItem {
  command?: string;
}

async function quickPick(ws: RungWorkspace, watch: WatchController): Promise<void> {
  if (!ws.hasConfig) {
    await vscode.commands.executeCommand("rung.init");
    return;
  }
  const scl = ["scl", "s7dcl"].includes(vscode.window.activeTextEditor?.document.languageId ?? "");
  const sep = (label: string): ActionItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const a = (icon: string, label: string, command: string, key?: string, detail?: string): ActionItem => ({ label: `$(${icon}) ${label}`, command, ...(key ? { description: `Alt+Q ${key}` } : {}), ...(detail ? { detail } : {}) });
  const running = watch.status === "running" || watch.status === "starting";
  const conflicts = ws.conflicts;
  const items: ActionItem[] = [
    sep("sync"),
    a("sync", "Sync now", "rung.sync", "S"),
    a("diff", "Preview sync", "rung.preview", "Shift+S", "what the next sync would send and bring in, before anything is written"),
    running ? a("eye-closed", "Stop watch", "rung.watch.stop", "W") : a("eye", "Start watch", "rung.watch.start", "W", "keep files and TIA Portal in sync"),
    a("cloud-download", "Pull from TIA Portal", "rung.pull", "P"),
    a("info", "Status", "rung.status"),
    ...(conflicts.length ? [a("warning", `Show ${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""}`, "rung.project.focus")] : []),
    sep("build"),
    ...(scl ? [a("tools", "Compile this file", "rung.compileFile", "B"), a("beaker", "Test this block", "rung.testBlock", "T")] : []),
    a("tools", "Compile PLC", "rung.compilePlc", "Shift+B"),
    a("circuit-board", "Compile hardware", "rung.compileHardware", "H"),
    a("beaker", "Test all", "rung.testAll", "Shift+T"),
    ...(scl ? [a("link-external", "Open in TIA Portal", "rung.openInTia", "E")] : []),
    sep("PLC"),
    a("plug", "Go online", "rung.goOnline", "O"),
    a("debug-disconnect", "Go offline", "rung.goOffline", "F"),
    a("pulse", "Online state", "rung.onlineState"),
    a("close", "Release the Project (close rung's background TIA Portal)", "rung.session.release"),
    a("link", "Connect…", "rung.connect", "C", "find the PLC on the network and choose the connection"),
    a("radio-tower", "Interfaces…", "rung.interfaces", "I"),
    a("diff-multiple", "Compare with PLC", "rung.compare", "M", "what on the PLC differs from the project"),
    a("desktop-download", "Download…", "rung.download", "D", "asks for confirmation first"),
    ...(scl ? [a("edit", "Rename in TIA Portal…", "rung.rename", "R", "every use follows")] : []),
    sep("workspace"),
    a("settings-gear", "Open rung.toml", "rung.openConfig"),
    a("output", "Show output", "rung.showOutput"),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: "rung", placeHolder: "rung action", matchOnDescription: true });
  if (pick?.command) await vscode.commands.executeCommand(pick.command);
}
