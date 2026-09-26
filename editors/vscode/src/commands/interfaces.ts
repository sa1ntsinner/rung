// SPDX-License-Identifier: MIT
// `rung interfaces --scan`: every PG/PC interface TIA Portal offers and what answers on it. Choosing one
// saves it as [plc.<device>] through `rung connect --use`; Esc only looks.
import * as vscode from "vscode";
import { Args, parseInterfaces } from "../core/args";
import { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";
import type { Connector } from "./connect";
import { deviceTarget } from "./targets";

export async function interfacesCommand(ws: RungWorkspace, cli: RungCli, connector: Connector, arg: unknown): Promise<void> {
  if (!ws.hasConfig || !ws.root) {
    void vscode.window.showWarningMessage("This folder has no rung.toml.");
    return;
  }
  const device = await deviceTarget(ws, arg, "Interfaces");
  if (!device) return;
  const r = await cli.capture(Args.interfaces(device, true), { progress: `rung: scanning PG/PC interfaces for ${device}…`, cancellable: true });
  if (r.error || r.code === null) return;
  if (r.code !== 0) {
    void vscode.window.showErrorMessage(`rung interfaces failed: ${RungCli.summary(r.output)}`);
    return;
  }
  const options = parseInterfaces(r.output);
  const reachable = options.filter((o) => o.reachable.length).length;
  await connector.pickInterface(
    device,
    options,
    `Interfaces for ${device}: ${reachable ? `devices answer on ${reachable} of ${options.length}` : "no device answered"}`,
    "Choose one to save it as the connection in rung.toml (Esc: only look)",
  );
}
