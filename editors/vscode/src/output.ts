// SPDX-License-Identifier: MIT
// One "rung" output channel shared by the extension and the language client.
import * as vscode from "vscode";
import { readSettings } from "./settings";

export class Output implements vscode.Disposable {
  readonly channel = vscode.window.createOutputChannel("rung");

  private stamp(): string {
    return new Date().toLocaleTimeString(undefined, { hour12: false });
  }

  /** Always written. */
  error(msg: string): void {
    this.channel.appendLine(`[${this.stamp()}] ${msg}`);
  }

  /** Written unless verbosity is "quiet". */
  info(msg: string): void {
    if (readSettings().verbosity !== "quiet") this.channel.appendLine(`[${this.stamp()}] ${msg}`);
  }

  /** Written only with verbosity "verbose". */
  debug(msg: string): void {
    if (readSettings().verbosity === "verbose") this.channel.appendLine(`[${this.stamp()}] ${msg}`);
  }

  /** Raw CLI output block (indented). `failed` blocks are written even when quiet. */
  block(text: string, failed = false): void {
    const v = readSettings().verbosity;
    if (!text.trim() || (v === "quiet" && !failed)) return;
    for (const line of text.replace(/\s+$/, "").split(/\r?\n/)) this.channel.appendLine(`    ${line}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
