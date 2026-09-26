// SPDX-License-Identifier: MIT
// `rung interfaces --scan`: show what Openness offers, let the user pick one connection, and only then
// offer to write [plc.<device>] into rung.toml.
import { join } from "node:path";
import * as vscode from "vscode";
import { Args, parseInterfaces, type InterfaceOption } from "../core/args";
import { formatPlcSection, parseRungToml, upsertPlcSection, type PlcConnection } from "../core/rungToml";
import type { Output } from "../output";
import { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";
import { deviceTarget } from "./targets";

export async function interfacesCommand(ws: RungWorkspace, cli: RungCli, out: Output, arg: unknown): Promise<void> {
  if (!ws.hasConfig || !ws.root) {
    void vscode.window.showWarningMessage("This folder has no rung.toml.");
    return;
  }
  const device = await deviceTarget(ws, arg, "Interfaces");
  if (!device) return;
  const r = await cli.capture(Args.interfaces(device, true), { progress: `rung: scanning PG/PC interfaces for ${device}…`, cancellable: true });
  if (r.error) return;
  out.show();
  if (r.code !== 0) {
    void vscode.window.showErrorMessage(`rung interfaces failed: ${RungCli.summary(r.output)}`);
    return;
  }
  const options = parseInterfaces(r.output);
  if (!options.length) {
    void vscode.window.showWarningMessage(`TIA Portal offers no PG/PC interface with a target interface for ${device}. The full list is in the rung output.`);
    return;
  }
  const current = ws.config?.plc[device];
  const same = (o: InterfaceOption) => !!current && current.mode === o.mode && current.pcInterface === o.pcInterface && current.pcInterfaceNumber === o.pcInterfaceNumber && current.targetInterface === o.targetInterface;
  const pick = await vscode.window.showQuickPick(
    options.map((o) => ({
      label: `${same(o) ? "$(check) " : ""}${o.pcInterface}`,
      description: `${o.mode} · ${o.targetInterface}${o.pcInterfaceNumber !== 1 ? ` · number ${o.pcInterfaceNumber}` : ""}`,
      detail: o.reachable.length ? `reachable: ${o.reachable.join("; ")}` : "no device answered on this interface",
      option: o,
    })),
    { title: `Connection for ${device}`, placeHolder: "Pick the PG/PC interface and target rung should use (Esc: only look)", matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true },
  );
  if (!pick) return;
  const conn: PlcConnection = { mode: pick.option.mode, pcInterface: pick.option.pcInterface, pcInterfaceNumber: pick.option.pcInterfaceNumber, targetInterface: pick.option.targetInterface };
  const snippet = formatPlcSection(device, conn);
  const choice = await vscode.window.showInformationMessage(
    current ? `Replace [plc.${device}] in rung.toml?` : `Add [plc.${device}] to rung.toml?`,
    { modal: true, detail: snippet },
    "Write to rung.toml",
    "Copy",
  );
  if (choice === "Copy") {
    await vscode.env.clipboard.writeText(snippet + "\n");
    return;
  }
  if (choice !== "Write to rung.toml") return;
  await writePlcSection(ws, device, conn);
}

async function writePlcSection(ws: RungWorkspace, device: string, conn: PlcConnection): Promise<void> {
  const uri = vscode.Uri.file(join(ws.root!, "rung.toml"));
  const doc = await vscode.workspace.openTextDocument(uri);
  const next = upsertPlcSection(doc.getText(), device, conn);
  try {
    const check = parseRungToml(next).plc[device];
    if (!check || check.pcInterface !== conn.pcInterface || check.mode !== conn.mode) throw new Error("the new table does not read back");
  } catch (e) {
    void vscode.window.showErrorMessage(`rung.toml was not changed (${(e as Error).message}). Copy the snippet from the rung output instead.`);
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), next);
  if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) {
    void vscode.window.showErrorMessage("Could not write rung.toml.");
    return;
  }
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const line = doc.getText().split(/\r?\n/).findIndex((l) => l.includes(`[plc.`) && l.includes(device));
  if (line >= 0) editor.revealRange(new vscode.Range(line, 0, line + 4, 0), vscode.TextEditorRevealType.InCenter);
  void vscode.window.showInformationMessage(`Saved [plc.${device}] in rung.toml.`);
  void ws.reload();
}
