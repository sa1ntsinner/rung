// SPDX-License-Identifier: MIT
// Registers every rung.* command. The CLI does the work; commands pick the target, run it and refresh.
import { join } from "node:path";
import * as vscode from "vscode";
import { Args, parseOnlineState } from "../core/args";
import type { Lsp } from "../lsp";
import type { OnlineMonitor } from "../online";
import type { Output } from "../output";
import type { CompileProblems } from "../problems";
import { RungCli } from "../runner/cli";
import type { WatchController } from "../runner/watch";
import type { ProjectView } from "../views/projectView";
import { isFile, type RungWorkspace } from "../workspace";
import { downloadCommand } from "./download";
import { interfacesCommand } from "./interfaces";
import { deviceTarget, fileTarget } from "./targets";

export interface Services {
  ws: RungWorkspace;
  cli: RungCli;
  out: Output;
  watch: WatchController;
  online: OnlineMonitor;
  problems: CompileProblems;
  project: ProjectView;
  lsp: Lsp;
}

const DOCS = "https://github.com/sa1ntsinner/rung/blob/main/docs/editors/README.md";

function needsWorkspace(ws: RungWorkspace): boolean {
  if (ws.hasConfig) return true;
  void vscode.window
    .showWarningMessage("This folder is not a rung workspace (no rung.toml).", "Initialize…")
    .then((p) => p && vscode.commands.executeCommand("rung.init"));
  return false;
}

export function registerCommands(context: vscode.ExtensionContext, s: Services): void {
  const { ws, cli, out, watch, online, problems } = s;
  const reg = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const inWs =
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      needsWorkspace(ws) ? fn(...args) : undefined;

  // --- sync
  reg("rung.pull", inWs(() => cli.run(["pull"])));
  reg("rung.sync", inWs(() => cli.run(["sync"])));
  reg("rung.status", inWs(() => cli.run(["status"])));
  reg("rung.views", inWs(() => cli.run(["views"])));
  reg("rung.watch.start", inWs(() => watch.start()));
  reg("rung.watch.stop", () => watch.stop());
  reg("rung.watch.toggle", inWs(() => watch.toggle()));
  reg("rung.watch.show", () => watch.show());

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
    await cli.run(Args.testBlock(t.name));
  });

  // --- online
  const onlineAction = (mode: "online" | "offline") =>
    inWs(async (arg) => {
      const d = await deviceTarget(ws, arg, mode === "online" ? "Go online" : "Go offline");
      if (!d) return;
      online.set(d, { ...online.get(d), checking: true });
      const r = await cli.capture(mode === "online" ? Args.online(d) : Args.offline(d), { progress: mode === "online" ? `rung: going online with ${d}…` : `rung: going offline from ${d}…`, cancellable: true });
      const st = parseOnlineState(r.output);
      online.set(d, st ? { state: st.state, checking: false, at: Date.now() } : { ...online.get(d), checking: false, error: RungCli.summary(r.output) });
      if (r.error) return;
      if (r.code === 0) void vscode.window.setStatusBarMessage(`rung: ${d} ${st?.state ?? mode}`, 4000);
      else void showFailure(out, mode === "online" ? `${d} is not online${st ? ` (${st.state})` : ""}` : `Going offline failed`, r.output);
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
  reg("rung.interfaces", inWs((arg) => interfacesCommand(ws, cli, out, arg)));
  reg("rung.download", inWs((arg) => downloadCommand(ws, cli, online, arg)));

  // --- TIA Portal / conflicts
  reg(
    "rung.openInTia",
    inWs(async (arg) => {
      const t = await fileTarget(ws, arg, undefined, "a mirrored block file");
      if (!t) return;
      const r = await cli.capture(Args.open(t.rel), { progress: `rung: opening ${t.name ?? t.rel} in TIA Portal…` });
      if (!r.error && r.code !== 0) void showFailure(out, "Could not open it in TIA Portal", r.output);
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
  reg("rung.init", () => initCommand(ws, cli));
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

async function initCommand(ws: RungWorkspace, cli: RungCli): Promise<void> {
  if (!ws.root) {
    const pick = await vscode.window.showWarningMessage("Open the folder that should hold the rung workspace first.", "Open Folder…");
    if (pick) await vscode.commands.executeCommand("vscode.openFolder");
    return;
  }
  if (ws.hasConfig) {
    const pick = await vscode.window.showInformationMessage("This folder already has a rung.toml.", "Open rung.toml");
    if (pick) await vscode.commands.executeCommand("rung.openConfig");
    return;
  }
  const files = await vscode.window.showOpenDialog({
    title: "TIA Portal project to mirror into this folder",
    openLabel: "Initialize rung workspace",
    canSelectMany: false,
    filters: { "TIA Portal project": ["ap20", "ap21"] },
  });
  const project = files?.[0]?.fsPath;
  if (!project) return;
  const r = await cli.run(Args.init(project));
  await ws.reload();
  if (r.code !== 0 || !ws.hasConfig) return;
  const pick = await vscode.window.showInformationMessage("rung workspace created. Pull the project from TIA Portal now?", "Pull", "Later");
  if (pick === "Pull") await cli.run(["pull"]);
}

interface ActionItem extends vscode.QuickPickItem {
  command?: string;
}

async function quickPick(ws: RungWorkspace, watch: WatchController): Promise<void> {
  if (!ws.hasConfig) {
    await vscode.commands.executeCommand("rung.init");
    return;
  }
  const scl = vscode.window.activeTextEditor?.document.languageId === "scl";
  const sep = (label: string): ActionItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const a = (icon: string, label: string, command: string, key?: string, detail?: string): ActionItem => ({ label: `$(${icon}) ${label}`, command, ...(key ? { description: `Alt+Q ${key}` } : {}), ...(detail ? { detail } : {}) });
  const running = watch.status === "running" || watch.status === "starting";
  const conflicts = ws.conflicts;
  const items: ActionItem[] = [
    sep("sync"),
    a("sync", "Sync now", "rung.sync", "S"),
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
    a("radio-tower", "Interfaces…", "rung.interfaces", "I"),
    a("desktop-download", "Download…", "rung.download", "D", "asks for confirmation first"),
    sep("workspace"),
    a("settings-gear", "Open rung.toml", "rung.openConfig"),
    a("output", "Show output", "rung.showOutput"),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: "rung", placeHolder: "rung action", matchOnDescription: true });
  if (pick?.command) await vscode.commands.executeCommand(pick.command);
}
