// SPDX-License-Identifier: MIT
import * as vscode from "vscode";
import { plcReadOnly, type RungToml } from "./core/rungToml";

export function allowPlcWrite(config?: RungToml, device?: string): boolean {
  const reason = plcReadOnly(config, device);
  if (reason) void vscode.window.showWarningMessage(reason);
  return !reason;
}
