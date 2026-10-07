// SPDX-License-Identifier: MIT
// What a command acts on: a file (editor, Explorer, project view, CodeLens) or a PLC (PLC view, quick pick).
import { basename } from "node:path";
import * as vscode from "vscode";
import { findBlockHeaders, headerAt } from "../core/headers";
import { deviceChoices } from "../core/targets";
import { ProjectItem } from "../views/projectView";
import { PlcItem } from "../views/plcView";
import type { RungWorkspace } from "../workspace";

export interface FileTarget {
  uri: vscode.Uri;
  /** Workspace-relative path. */
  rel: string;
  device?: string;
  /** Block name (for rung test --filter). */
  name?: string;
}

function uriOf(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (arg instanceof ProjectItem && arg.node.type === "object") return arg.resourceUri;
  return vscode.window.activeTextEditor?.document.uri;
}

/** File for a command; warns and returns undefined when there is none inside the workspace. */
export async function fileTarget(ws: RungWorkspace, arg: unknown, nameArg?: unknown, what = "an SCL file of the workspace"): Promise<FileTarget | undefined> {
  const uri = uriOf(arg);
  const rel = uri?.scheme === "file" ? ws.rel(uri.fsPath) : undefined;
  if (!uri || !rel) {
    void vscode.window.showWarningMessage(`Open ${what} first.`);
    return undefined;
  }
  const o = ws.objectAt(uri.fsPath);
  const t: FileTarget = { uri, rel };
  if (o) t.device = o.device;
  if (typeof nameArg === "string" && nameArg) t.name = nameArg;
  else if (arg instanceof ProjectItem && arg.node.type === "object") t.name = arg.node.object.name;
  else {
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    const doc = editor?.document ?? (await vscode.workspace.openTextDocument(uri).then(undefined, () => undefined));
    const h = doc ? headerAt(findBlockHeaders(doc.getText()), editor?.selection.active.line ?? 0) : undefined;
    t.name = h?.name ?? o?.name ?? basename(rel).replace(/\..*$/, "");
  }
  return t;
}

/** PLC for a command: from the PLC view item / argument, or asked when the workspace has several. */
export async function deviceTarget(ws: RungWorkspace, arg: unknown, action: string): Promise<string | undefined> {
  if (typeof arg === "string" && arg) return arg;
  if (arg instanceof PlcItem && arg.device) return arg.device;
  // a tree element of another view that names its PLC (the Changes view's comparison)
  if (arg && typeof arg === "object" && typeof (arg as { device?: unknown }).device === "string") return (arg as { device: string }).device;
  if (arg instanceof ProjectItem && (arg.node.type === "device" || arg.node.type === "unit")) return arg.node.device;
  const devices = ws.devices();
  if (devices.length === 1) return devices[0];
  const picked = await vscode.window.showQuickPick(deviceChoices(devices, ws.lastDevice), { title: `${action}: which PLC?`, placeHolder: "PLC (TIA device name)" });
  if (picked) await ws.rememberDevice(picked);
  return picked;
}
