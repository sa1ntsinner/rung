// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { LiveAccess } from "./liveAccess";
import type { RungCli } from "./runner/cli";
import { humanConfirmedEnv } from "./core/agentEnv";
import { killTree } from "./runner/terminal";
import type { RungWorkspace } from "./workspace";
import { allowPlcWrite } from "./plcReadOnly";
import { plcReadOnly } from "./core/rungToml";

/** Uses the CLI's private confirmation pipe; source declarations are never changed here. */
export async function mutateLive(ws: RungWorkspace, cli: RungCli, access: LiveAccess, action: "modify" | "run" | "stop",
  name?: string, draft?: string, device?: string): Promise<void> {
  const connection = await access.select(device);
  if (!connection || !ws.root) return;
  if (!allowPlcWrite(ws.config, connection.device)) return;
  if (connection.simulator && action === "modify") return modifySimulator(ws, connection.device, connection.simulator, name, draft);
  if (connection.target.transport !== "s7commplus") { void vscode.window.showWarningMessage("PLC modification requires a configured s7commplus target."); return; }
  if (action === "modify") {
    name ??= await vscode.window.showInputBox({ title: "Modify current PLC value", prompt: "PLC symbolic name or verified absolute address" });
    if (!name) return;
    draft = await vscode.window.showInputBox({ title: `Modify ${name}`, prompt: "New current value as an SCL literal", value: draft ?? "" });
    if (draft === undefined) return;
  }
  const env = await access.environment(connection);
  if (!env || connection.workspace !== access.scope) return;
  if (!allowPlcWrite(ws.config, connection.device)) return;
  const args = ["live", action, ...(action === "modify" ? [name!, draft!] : []), "--device", connection.device, "--confirm-stdin", "--json"];
  const inv = cli.invocation(args);
  const child = spawn(inv.file, inv.args, { cwd: ws.root, env: { ...humanConfirmedEnv(), ...env }, stdio: "pipe", windowsHide: true, windowsVerbatimArguments: inv.shell });
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
        confirmed = answer === "Confirm" && !plcReadOnly(ws.config, connection.device) && connection.workspace === access.scope && Date.now() < operation.expiresAt && child.exitCode === null;
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

/** "TRUE" → true, "37" → 37, "1.5" → 1.5; anything else as written (times, strings). */
export function simulatorLiteral(text: string): unknown {
  const t = text.trim();
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}

/**
 * rung simulate is the workspace's own virtual PLC: a value is written straight into it (its Web API), no confirmation
 * pipe, no real plant behind it. Inputs set this way stand until the program or the next write changes them.
 */
async function modifySimulator(ws: RungWorkspace, device: string, url: string, name?: string, draft?: string): Promise<void> {
  name ??= await vscode.window.showInputBox({ title: "Set a value in the simulator", prompt: 'PLC tag or DB member, for example "Start_PB"' });
  if (!name) return;
  draft = await vscode.window.showInputBox({ title: `Set ${name} in the simulator`, prompt: "New value: TRUE, FALSE, a number or an SCL literal", value: draft ?? "" });
  if (draft === undefined) return;
  await ws.reload();
  if (!allowPlcWrite(ws.config, device)) return;
  const rpc = async (body: unknown, token?: string) => {
    const r = await fetch(`${url}/api/jsonrpc`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-auth-token": token } : {}) }, body: JSON.stringify(body) });
    return (await r.json()) as { result?: unknown; error?: { message?: string } }[];
  };
  try {
    const [login] = await rpc([{ jsonrpc: "2.0", id: 1, method: "Api.Login", params: { user: "any", password: "simulator" } }]);
    const token = (login?.result as { token?: string } | undefined)?.token;
    if (!allowPlcWrite(ws.config, device)) return;
    const [write] = await rpc([{ jsonrpc: "2.0", id: 2, method: "PlcProgram.Write", params: { var: name, value: simulatorLiteral(draft) } }], token);
    if (write?.error) void vscode.window.showWarningMessage(`The simulator did not take ${name}: ${write.error.message ?? "refused"}`);
    else void vscode.window.setStatusBarMessage(`$(vm-running) ${name} := ${draft} in the simulator`, 4000);
  } catch (e) {
    void vscode.window.showWarningMessage(`The simulator at ${url} did not answer: ${(e as Error).message}`);
  }
}
