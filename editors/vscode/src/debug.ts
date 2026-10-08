// SPDX-License-Identifier: MIT
// Debugging a test case on the offline simulator: VS Code talks DAP to `rung debug`. The extension starts
// the process itself (a rung.cmd shim needs cmd.exe with verbatim arguments, which DebugAdapterExecutable
// cannot pass) and relays the messages.
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { RungCli } from "./runner/cli";
import { killTree } from "./runner/terminal";
import type { RungWorkspace } from "./workspace";

class RungDebugAdapter implements vscode.DebugAdapter {
  private readonly sent = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.sent.event;
  private readonly child;
  private buf = Buffer.alloc(0);

  constructor(cli: RungCli, cwd: string | undefined) {
    const inv = cli.invocation(["debug", "--stdio"]);
    this.child = spawn(inv.file, inv.args, { cwd, windowsVerbatimArguments: inv.shell, windowsHide: true });
    this.child.stdout.on("data", (c: Buffer) => this.read(c));
    let err = "";
    this.child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    const fail = (why: string) => this.sent.fire({ type: "event", event: "output", body: { category: "stderr", output: `rung debug: ${why}\n` } } as vscode.DebugProtocolMessage);
    this.child.on("error", (e) => fail(`${e.message} (set "rung.command" to the rung executable)`));
    this.child.on("exit", (code) => {
      if (code) fail(err.trim() || `exited with code ${code}`);
      this.sent.fire({ type: "event", event: "terminated" } as vscode.DebugProtocolMessage);
    });
  }

  private read(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const len = Number(/Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString("ascii"))?.[1]);
      if (!Number.isFinite(len) || this.buf.length < end + 4 + len) return;
      this.sent.fire(JSON.parse(this.buf.subarray(end + 4, end + 4 + len).toString("utf8")));
      this.buf = this.buf.subarray(end + 4 + len);
    }
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  dispose(): void {
    killTree(this.child); // through the rung.cmd shim rung debug is a child of cmd.exe
    this.sent.dispose();
  }
}

export function registerDebug(context: vscode.ExtensionContext, ws: RungWorkspace, cli: RungCli): void {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("rung", {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new RungDebugAdapter(cli, ws.root)),
    }),
    // values next to the code while stopped: each #name on the lines up to the statement stopped at
    vscode.languages.registerInlineValuesProvider("scl", {
      provideInlineValues(doc, viewport, context) {
        const out: vscode.InlineValue[] = [];
        const last = Math.min(viewport.end.line, context.stoppedLocation.end.line);
        for (let l = viewport.start.line; l <= last; l++) {
          const text = doc.lineAt(l).text.replace(/\/\/.*$/, "");
          for (const m of text.matchAll(/#"?([A-Za-z_]\w*)"?/g)) out.push(new vscode.InlineValueVariableLookup(new vscode.Range(l, m.index!, l, m.index! + m[0].length), m[1]!, false));
        }
        return out;
      },
    }),
  );
}

/** Starts debugging one case of a test file (numbered from 0), stopping at its first statement. */
export function debugCase(ws: RungWorkspace, file: vscode.Uri, caseIndex: number, name: string): Thenable<boolean> {
  const folder = ws.root ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(ws.root)) : undefined;
  return vscode.debug.startDebugging(folder, { type: "rung", request: "launch", name: `Debug ${name}`, test: file.fsPath, case: caseIndex, stopOnEntry: true });
}
