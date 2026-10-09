// SPDX-License-Identifier: MIT
import * as vscode from "vscode";
import { Args, parseCheck } from "../core/args";
import { mirrorFolderFor, preflight, tiaVersionOf, validateRemoteProject } from "../core/firstUse";
import { FIXES } from "../views/environmentView";
import { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";

/**
 * Open TIA Project…: one path from a .ap file to a mirrored, watched workspace. Checks first what no click can fix
 * (TIA Portal version, Openness group), mirrors into the open folder or one next to the project, pulls and starts
 * watch. Writes to TIA Portal stay off until the engineer turns them on.
 */
export async function initCommand(ws: RungWorkspace, cli: RungCli, context: vscode.ExtensionContext): Promise<void> {
  if (ws.hasConfig) {
    const pick = await vscode.window.showInformationMessage("This folder already has a rung.toml.", "Open rung.toml");
    if (pick) await vscode.commands.executeCommand("rung.openConfig");
    return;
  }
  const configuredHost = vscode.workspace.getConfiguration("rung").get<string>("remote.host")?.trim();
  let remote = !!configuredHost;
  if (!configuredHost || process.platform === "win32") {
    const pick = await vscode.window.showQuickPick(["TIA Portal on this PC", "TIA Portal on another PC (ssh)…"], { title: "Where does TIA Portal run?" });
    if (!pick) return;
    remote = pick === "TIA Portal on another PC (ssh)…";
  }
  let host: string | undefined;
  let project: string | undefined;
  if (remote) {
    host = (await vscode.window.showInputBox({
      title: "TIA Portal PC (ssh)",
      prompt: "SSH destination, for example engineer@tia-pc (key-based login)",
      value: configuredHost || context.globalState.get<string>("rung.remote.host"),
      validateInput: (value) => value.trim() ? undefined : "Enter an SSH destination.",
    }))?.trim();
    if (!host) return;
    await context.globalState.update("rung.remote.host", host);
    project = await vscode.window.showInputBox({
      title: "TIA Portal project on the Windows PC",
      prompt: "Windows project path, for example D:\\Projects\\Line\\Line.ap20",
      validateInput: validateRemoteProject,
    });
  } else {
    const files = await vscode.window.showOpenDialog({
      title: "TIA Portal project to open",
      openLabel: "Open with rung",
      canSelectMany: false,
      filters: { "TIA Portal project": ["ap19", "ap20", "ap21"] },
    });
    project = files?.[0]?.fsPath;
  }
  if (!project) return;

  // RUNG_BRIDGE names another bridge (a remote or test one): this PC's TIA Portal does not matter then
  const check = !host && process.env.RUNG_BRIDGE ? undefined : await cli.capture(["check", ...(host ? ["--host", host] : []), "--json"], { quiet: true, timeoutMs: 120_000, progress: `rung: checking TIA Portal and Openness on ${host || "this PC"}…` });
  const items = check && parseCheck(check.output);
  if (host && (check?.error || check?.code !== 0 || !items)) return void vscode.window.showErrorMessage(`Could not check ${host}: ${RungCli.summary(check?.output ?? "")}`, { modal: true });
  const pre = preflight(items, tiaVersionOf(project));
  if (!pre.ok) return void vscode.window.showErrorMessage(host ? `${host}: ${pre.message}` : pre.message, { modal: true });
  if (pre.whitelist) {
    if (host) {
      const pick = await vscode.window.showWarningMessage(`The rung bridge is not registered with TIA Portal Openness on ${host}. Run rung setup openness on that PC, or TIA Portal may ask "Openness access" first.`, "Go On");
      if (!pick) return;
    } else {
      const fix = FIXES.whitelist!;
      const pick = await vscode.window.showWarningMessage("The rung bridge is not registered with TIA Portal Openness, so TIA Portal may ask \"Openness access\" first.", fix.label, "Go On");
      if (pick === fix.label) await cli.run(fix.args);
      else if (!pick) return;
    }
  }

  // the open folder when there is one, else a folder next to the project, opened afterwards
  let dir = ws.root;
  if (!dir) {
    const picked = await vscode.window.showOpenDialog({
      title: "Folder for the project's files (git, VS Code, agents work here)",
      openLabel: "Mirror here",
      canSelectFiles: false,
      canSelectFolders: true,
      ...(host ? {} : { defaultUri: vscode.Uri.file(mirrorFolderFor(project)) }),
    });
    if (!picked?.[0]) return;
    dir = picked[0].fsPath;
  }
  const own = dir === ws.root;
  const init = await cli.run([...Args.init(project, own ? undefined : dir), ...(host ? ["--host", host] : [])]);
  if (init.code !== 0) return;
  // the first pull starts TIA Portal (or attaches to one that has the project); every later command reuses it
  const pull = await cli.run(own ? ["pull"] : ["pull", dir]);
  if (!own) return void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir));
  await ws.reload();
  if (pull.code === 0 && ws.hasConfig) await vscode.commands.executeCommand("rung.watch.start");
}
