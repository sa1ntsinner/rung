// SPDX-License-Identifier: BUSL-1.1
// Drives the language server over an in-memory JSON-RPC connection, like an editor would.
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node.js";
import { startServer } from "../src/server.js";

const SRC = 'FUNCTION_BLOCK "Fx_A"\nVAR\n   count : Int;\nEND_VAR\nBEGIN\n   #count := #count + 1;\n   #nope := 1;\nEND_FUNCTION_BLOCK\n';

async function boot() {
  const root = mkdtempSync(join(tmpdir(), "rung-lsp-srv-"));
  const blocks = join(root, "plc", "PLC_1", "blocks");
  mkdirSync(blocks, { recursive: true });
  writeFileSync(join(blocks, "Fx_A.scl"), SRC);
  mkdirSync(join(root, ".rung"), { recursive: true });
  writeFileSync(join(root, ".rung", "diagnostics.json"), JSON.stringify({ seq: 1, items: [{ address: "plc:PLC_1/blocks/Fx_A", path: "plc/PLC_1/blocks/Fx_A.scl", severity: "error", code: "COMPILE", message: "compiler says no", line: 6 }] }));
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = startServer(new StreamMessageReader(toServer), new StreamMessageWriter(toClient));
  const client = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
  const diags: { uri: string; diagnostics: { message: string; source: string }[] }[] = [];
  client.onNotification("textDocument/publishDiagnostics", (p) => diags.push(p));
  client.listen();
  const uri = pathToFileURL(join(blocks, "Fx_A.scl")).href;
  const init = await client.sendRequest("initialize", { processId: null, rootUri: pathToFileURL(root).href, capabilities: {} });
  await client.sendNotification("initialized", {});
  return { root, uri, client, server, diags, init };
}
const until = async (cond: () => boolean) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 5000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("rung lsp", () => {
  it("advertises capabilities and serves diagnostics, hover, definition, completion and rename", async () => {
    const t = await boot();
    expect((t.init as { capabilities: { completionProvider: { triggerCharacters: string[] } } }).capabilities.completionProvider.triggerCharacters).toContain("#");
    await t.client.sendNotification("textDocument/didOpen", { textDocument: { uri: t.uri, languageId: "scl", version: 1, text: SRC } });
    await until(() => t.diags.some((d) => d.uri === t.uri));
    const last = t.diags.filter((d) => d.uri === t.uri).at(-1)!;
    expect(last.diagnostics.map((d) => d.message)).toEqual(["#nope is not declared in Fx_A", "compiler says no"]);

    const hover = (await t.client.sendRequest("textDocument/hover", { textDocument: { uri: t.uri }, position: { line: 5, character: 5 } })) as { contents: { value: string } };
    expect(hover.contents.value).toMatch(/count\*\* : `Int`/);

    const def = (await t.client.sendRequest("textDocument/definition", { textDocument: { uri: t.uri }, position: { line: 5, character: 5 } })) as { range: { start: { line: number } } };
    expect(def.range.start.line).toBe(2);

    const items = (await t.client.sendRequest("textDocument/completion", { textDocument: { uri: t.uri }, position: { line: 5, character: 4 } })) as { label: string }[];
    expect(items.map((i) => i.label)).toContain("count");

    const edit = (await t.client.sendRequest("textDocument/rename", { textDocument: { uri: t.uri }, position: { line: 5, character: 5 }, newName: "total" })) as { changes: Record<string, unknown[]> };
    expect(edit.changes[t.uri]).toHaveLength(3);

    // an unsaved edit hides the compile diagnostic that described the synced file
    t.diags.length = 0;
    await t.client.sendNotification("textDocument/didChange", { textDocument: { uri: t.uri, version: 2 }, contentChanges: [{ text: SRC.replace("#nope := 1;", "") }] });
    await until(() => t.diags.some((d) => d.uri === t.uri));
    expect(t.diags.at(-1)!.diagnostics).toEqual([]);

    const symbols = (await t.client.sendRequest("textDocument/documentSymbol", { textDocument: { uri: t.uri } })) as { name: string }[];
    expect(symbols[0]!.name).toBe("Fx_A");
    const found = (await t.client.sendRequest("workspace/symbol", { query: "fx_a" })) as { name: string; kind: number; containerName: string; location: { uri: string } }[];
    expect(found).toEqual([{ name: "Fx_A", kind: 5, containerName: "PLC_1", location: { uri: t.uri, range: { start: { line: 0, character: 15 }, end: expect.anything() } } }]); // at its name
    const folds = (await t.client.sendRequest("textDocument/foldingRange", { textDocument: { uri: t.uri } })) as { startLine: number; endLine: number }[];
    expect(folds).toEqual([{ startLine: 0, endLine: 6 }, { startLine: 1, endLine: 2 }]);
    t.server.dispose();
    t.client.dispose();
  });
});
