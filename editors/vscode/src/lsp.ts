// SPDX-License-Identifier: MIT
// Language client for `rung lsp --stdio` (diagnostics, completion, hover, …).
import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";
import type { Output } from "./output";
import type { RungCli } from "./runner/cli";
import type { RungWorkspace } from "./workspace";

export class Lsp implements vscode.Disposable {
  private client: LanguageClient | undefined;

  constructor(
    private readonly ws: RungWorkspace,
    private readonly cli: RungCli,
    private readonly out: Output,
  ) {}

  async start(): Promise<void> {
    const inv = this.cli.invocation(["lsp", "--stdio"]);
    // No `transport`: stdio is the default, and TransportKind.stdio would append a second "--stdio"
    // after the verbatim cmd.exe line of a rung.cmd shim.
    const serverOptions: ServerOptions = {
      command: inv.file,
      args: inv.args,
      options: { cwd: this.ws.root, ...(inv.shell ? { windowsVerbatimArguments: true } : {}) } as never,
    };
    const clientOptions: LanguageClientOptions = {
      // TwinCAT sources stay XML-highlighted; the server reads the ST inside their CDATA sections.
      documentSelector: [
        { scheme: "file", language: "scl" },
        { scheme: "file", pattern: "**/*.{TcPOU,TcDUT,TcGVL,TcIO}" },
      ],
      synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/{plc/**/*.{scl,db,udt,awl,s7dcl,xml},*.{st,TcPOU,TcDUT,TcGVL,TcIO}}") },
      outputChannel: this.out.channel,
    };
    this.out.debug(`language server: ${inv.display}`);
    try {
      this.client = new LanguageClient("rung", "rung language server", serverOptions, clientOptions);
      await this.client.start();
    } catch (e) {
      const pick = await vscode.window.showErrorMessage(`The rung language server did not start (${String(e)}). Set "rung.command" to the rung executable.`, "Open setting", "Show output");
      if (pick === "Open setting") await vscode.commands.executeCommand("workbench.action.openSettings", "rung.command");
      if (pick === "Show output") this.out.show();
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    if (c?.needsStop()) await c.stop().catch(() => undefined);
    await c?.dispose().catch(() => undefined);
  }

  dispose(): void {
    void this.stop();
  }
}
