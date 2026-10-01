// SPDX-License-Identifier: BUSL-1.1
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node.js";
import type { CodeAction, InlayHint, Range } from "vscode-languageserver/node.js";
import { startServer, type MessageReader, type MessageWriter, type ServerHandle } from "../src/server.js";
import type { MonitorProvider } from "../src/monitor.js";

export const SOURCE = 'FUNCTION_BLOCK "Motor"\nVAR\n   count : Int;\n   flag : Bool;\nEND_VAR\nBEGIN\n   #count := #count + 1;\nEND_FUNCTION_BLOCK\n';
export const ALL_LINES = { start: { line: 0, character: 0 }, end: { line: 100, character: 0 } };

export async function monitorServer(
  monitor?: MonitorProvider,
  options: {
    refreshSupport?: boolean;
    initializationOptions?: Record<string, unknown>;
    start?: (reader: MessageReader, writer: MessageWriter) => ServerHandle;
    setup?: (root: string) => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "rung-lsp-monitor-"));
  const blocks = join(root, "plc", "PLC_1", "blocks");
  await mkdir(blocks, { recursive: true });
  await writeFile(join(blocks, "Motor.scl"), SOURCE);
  await options.setup?.(root);
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const reader = new StreamMessageReader(toServer);
  const writer = new StreamMessageWriter(toClient);
  const server = options.start?.(reader, writer) ?? startServer(reader, writer, { monitor });
  const client = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
  const messages: { type: number; message: string }[] = [];
  const refreshes: number[] = [];
  client.onNotification("textDocument/publishDiagnostics", () => {});
  client.onNotification("window/showMessage", (p) => messages.push(p));
  client.onRequest("workspace/inlayHint/refresh", () => { refreshes.push(Date.now()); return null; });
  client.listen();
  const uri = pathToFileURL(join(blocks, "Motor.scl")).href;
  const init = await client.sendRequest("initialize", {
    processId: null, rootUri: pathToFileURL(root).href,
    capabilities: { workspace: { inlayHint: { refreshSupport: options.refreshSupport ?? true } } },
    initializationOptions: options.initializationOptions,
  }) as { capabilities: { inlayHintProvider: boolean; executeCommandProvider: { commands: string[] } } };
  const open = (uri: string, text = SOURCE) => client.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "scl", version: 1, text } });
  await open(uri);
  return {
    root, uri, client, server, messages, refreshes, init, open,
    hints: (target = uri, range: Range = ALL_LINES) => client.sendRequest<InlayHint[]>("textDocument/inlayHint", { textDocument: { uri: target }, range }),
    actions: (target = uri) => client.sendRequest<CodeAction[]>("textDocument/codeAction", { textDocument: { uri: target }, range: ALL_LINES, context: { diagnostics: [] } }),
    execute: (action: CodeAction) => client.sendRequest("workspace/executeCommand", action.command!),
    dispose: async () => {
      server.dispose();
      server.connection.dispose();
      client.dispose();
      toServer.destroy();
      toClient.destroy();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function until(condition: () => boolean) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 5000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
