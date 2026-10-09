// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { LiveAccess } from "./liveAccess";
import type { RungCli } from "./runner/cli";
import { killTree } from "./runner/terminal";
import type { RungWorkspace } from "./workspace";

/** Uses the CLI's private confirmation pipe; source declarations are never changed here. */
export async function mutateLive(ws: RungWorkspace, cli: RungCli, access: LiveAccess, action: "modify" | "run" | "stop",
  name?: string, draft?: string, device?: string): Promise<void> {
  const connection = await access.select(device);
  if (!connection || !ws.root) return;
  if (connection.target.transport !== "s7commplus") { void vscode.window.showWarningMessage("PLC modification requires a configured s7commplus target."); return; }
  if (action === "modify") {
    name ??= await vscode.window.showInputBox({ title: "Modify current PLC value", prompt: "PLC symbolic name or verified absolute address" });
    if (!name) return;
    draft = await vscode.window.showInputBox({ title: `Modify ${name}`, prompt: "New current value as an SCL literal", value: draft ?? "" });
    if (draft === undefined) return;
  }
  const env = await access.environment(connection);
  if (!env || connection.workspace !== access.scope) return;
  const args = ["live", action, ...(action === "modify" ? [name!, draft!] : []), "--device", connection.device, "--confirm-stdin", "--json"];
  const inv = cli.invocation(args);
  const child = spawn(inv.file, inv.args, { cwd: ws.root, env: { ...process.env, ...env }, stdio: "pipe", windowsHide: true, windowsVerbatimArguments: inv.shell });
  let partial = "", output = "", errors = "", prepared = false, confirmed = false;
  const timer = setTimeout(() => killTree(child), 90_000);
  const changed = ws.onDidChange(() => { if (connection.workspace !== access.scope) killTree(child); });
  child.stdout.on("data", (chunk: Buffer) => {
    partial += chunk.toString("utf8");
    if (partial.length + output.length > 2 * 1024 * 1024) { killTree(child); return; }
    let end: number;
    while ((end = partial.indexOf("\n")) >= 0) {
      const line = partial.slice(0, end); partial = partial.slice(end + 1);
      let frame: { prepared?: { operationId: string; preview: string; expiresAt: number } };
      try { frame = JSON.parse(line); } catch { killTree(child); return; }
      if (!frame.prepared) { output += line + "\n"; continue; }
      if (prepared) { killTree(child); return; }
      prepared = true;
      const operation = frame.prepared;
      void (async () => {
        const answer = await vscode.window.showWarningMessage(`Confirm ${action} on ${connection.device}?`, { modal: true, detail: operation.preview }, "Confirm");
        await ws.reload();
        confirmed = answer === "Confirm" && connection.workspace === access.scope && Date.now() < operation.expiresAt && child.exitCode === null;
        child.stdin.on("error", () => {});
        if (!child.stdin.destroyed) child.stdin.end(JSON.stringify({ operationId: operation.operationId, preview: operation.preview, confirmed }) + "\n");
      })().catch(() => killTree(child));
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { if (errors.length < 16_384) errors += chunk.toString("utf8"); });
  child.on("error", () => void vscode.window.showErrorMessage("Could not start the PLC confirmation command."));
  await new Promise<void>(resolve => child.once("close", code => {
    clearTimeout(timer); changed.dispose();
    if (code === 0) void vscode.window.showInformationMessage("PLC operation acknowledged. Live monitoring shows subsequent values.");
    else if (confirmed) void vscode.window.showWarningMessage(output.trim() || "PLC operation outcome is unknown. Observe the PLC before preparing another operation.");
    else if (errors && !/cancelled/i.test(errors)) void vscode.window.showWarningMessage(errors.trim());
    resolve();
  }));
}

export function registerLiveCpuCommands(ws: RungWorkspace, cli: RungCli, access: LiveAccess): vscode.Disposable[] {
  return (["run", "stop"] as const).map(action => vscode.commands.registerCommand(`rung.live.${action}`, (item?: { device?: string }) => mutateLive(ws, cli, access, action, undefined, undefined, item?.device)));
}
