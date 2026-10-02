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
import { OwnerServer } from "@rung/sync";
import { LineIndex } from "../src/lexer.js";
import type { CompletionItem, DocumentHighlight, InitializeParams, InitializeResult, SignatureHelp } from "vscode-languageserver/node.js";

const SRC = 'FUNCTION_BLOCK "Fx_A"\nVAR\n   count : Int;\nEND_VAR\nBEGIN\n   #count := #count + 1;\n   #nope := 1;\nEND_FUNCTION_BLOCK\n';

async function boot(capabilities: InitializeParams["capabilities"] = {}, before?: (root: string) => Promise<unknown>) {
  const root = mkdtempSync(join(tmpdir(), "rung-lsp-srv-"));
  const blocks = join(root, "plc", "PLC_1", "blocks");
  mkdirSync(blocks, { recursive: true });
  writeFileSync(join(blocks, "Fx_A.scl"), SRC);
  mkdirSync(join(root, ".rung"), { recursive: true });
  writeFileSync(join(root, ".rung", "diagnostics.json"), JSON.stringify({ seq: 1, items: [{ address: "plc:PLC_1/blocks/Fx_A", path: "plc/PLC_1/blocks/Fx_A.scl", severity: "error", code: "COMPILE", message: "compiler says no", line: 6 }] }));
  await before?.(root);
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = startServer(new StreamMessageReader(toServer), new StreamMessageWriter(toClient));
  const client = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
  const diags: { uri: string; diagnostics: { message: string; source: string }[] }[] = [];
  client.onNotification("textDocument/publishDiagnostics", (p) => diags.push(p));
  client.listen();
  const uri = pathToFileURL(join(blocks, "Fx_A.scl")).href;
  const init = await client.sendRequest("initialize", { processId: null, rootUri: pathToFileURL(root).href, capabilities });
  await client.sendNotification("initialized", {});
  return { root, uri, client, server, diags, init, version: 0 };
}
const until = async (cond: () => boolean) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 5000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("rung lsp: what rung watch is doing, as the editor's progress", () => {
  it("shows sending and compiling while a pass runs and ends when it reports", async () => {
    let owner: OwnerServer | undefined;
    const t = await boot({ window: { workDoneProgress: true } }, async (root) => (owner = await OwnerServer.start(root, {})));
    const progress: { kind: string; message?: string; title?: string }[] = [];
    t.client.onRequest("window/workDoneProgress/create", () => null);
    t.client.onNotification("$/progress", (p: { value: { kind: string; message?: string; title?: string } }) => progress.push(p.value));
    await new Promise((r) => setTimeout(r, 300)); // the server subscribes once initialized
    owner!.emit("phase", { phase: "sending", detail: "plc/PLC_1/blocks/Fx_A.scl" });
    await until(() => progress.length === 1);
    owner!.emit("phase", { phase: "compiling", detail: "what uses the changed blocks" });
    owner!.emit("report", { imported: 1 });
    await until(() => progress.some((p) => p.kind === "end"));
    expect(progress).toEqual([
      { kind: "begin", title: "rung", message: "sending Fx_A.scl to TIA Portal" },
      { kind: "report", message: "compiling what uses the changed blocks" },
      { kind: "end" },
    ]);
    await owner!.close();
  });
});

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

const SCALE = `FUNCTION "Scale" : Real // Scale a raw value
VAR_INPUT
   Raw : Int; // Raw measurement
   Low : Real;
   High : Real;
END_VAR
BEGIN
END_FUNCTION
`;
const MOTOR = `FUNCTION_BLOCK "Motor" // Motor control
VAR_OUTPUT
   Out : Bool; // Running state
END_VAR
VAR_INPUT
   Run : Bool;
   Speed : Int := 0;
END_VAR
VAR_IN_OUT
   State : Int;
END_VAR
BEGIN
END_FUNCTION_BLOCK
`;
const EDITOR = `FUNCTION_BLOCK "Editor"
VAR
   Motor : "Motor";
   t : TON;
   value : Int;
   ready : Bool;
   i : Int;
   values : Array[0..3] of Int;
END_VAR
BEGIN
   BODY
END_FUNCTION_BLOCK
`;

async function editorBoot(snippetSupport = false) {
  const t = await boot({ textDocument: { completion: { completionItem: { snippetSupport } } } });
  for (const [file, text] of [["Scale.scl", SCALE], ["Motor.scl", MOTOR], ["Motor_DB.db", 'DATA_BLOCK "Motor_DB" "Motor"\nBEGIN\nEND_DATA_BLOCK\n']] as const) {
    const uri = pathToFileURL(join(t.root, "plc", "PLC_1", "blocks", file)).href;
    await t.client.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "scl", version: 1, text } });
  }
  return t;
}

async function requestAt<T>(t: Awaited<ReturnType<typeof boot>>, method: string, marked: string): Promise<T> {
  const offset = marked.indexOf("|");
  const body = marked.replace("|", "");
  const text = EDITOR.replace("BODY", body);
  const version = ++t.version;
  if (version === 1) await t.client.sendNotification("textDocument/didOpen", { textDocument: { uri: t.uri, languageId: "scl", version, text } });
  else await t.client.sendNotification("textDocument/didChange", { textDocument: { uri: t.uri, version }, contentChanges: [{ text }] });
  return t.client.sendRequest<T>(method, { textDocument: { uri: t.uri }, position: new LineIndex(text).position(text.indexOf(body) + offset) });
}

describe("editor call features over LSP", () => {
  it("advertises signature triggers and highlights and shows an FC's typed interface and comments", async () => {
    const t = await editorBoot();
    try {
      const capabilities = (t.init as InitializeResult).capabilities;
      expect(capabilities.signatureHelpProvider).toEqual({ triggerCharacters: ["(", ","], retriggerCharacters: [":"] });
      expect(capabilities.documentHighlightProvider).toBe(true);
      const h = await requestAt<SignatureHelp>(t, "textDocument/signatureHelp", '"Scale"(High := 10.0, Low := |, Raw := 1);');
      expect(h.activeParameter).toBe(1);
      expect(h.activeSignature).toBe(0);
      expect(h.signatures).toEqual([{
        label: '"Scale"(Raw : Int, Low : Real, High : Real) : Real',
        documentation: "Scale a raw value",
        parameters: [
          { label: "Raw : Int", documentation: "Input : Int — Raw measurement" },
          { label: "Low : Real", documentation: "Input : Real" },
          { label: "High : Real", documentation: "Input : Real" },
        ],
      }]);
    } finally { t.server.dispose(); t.client.dispose(); }
  });

  it("resolves instance DBs, multi-instances and TON instances, including output directions", async () => {
    const t = await editorBoot();
    try {
      for (const call of ['"Motor_DB"', "#Motor"]) {
        const h = await requestAt<SignatureHelp>(t, "textDocument/signatureHelp", `${call}(Out => |#ready, Run := TRUE);`);
        expect(h.activeParameter).toBe(3);
        expect(h.signatures[0]).toMatchObject({ label: `${call}(Run : Bool, Speed : Int, State : Int, Out => Bool)`, documentation: "Motor control" });
        expect(h.signatures[0]!.parameters?.[2]?.documentation).toBe("InOut : Int");
        expect(h.signatures[0]!.parameters?.[3]?.documentation).toBe("Output : Bool — Running state");
      }
      const timer = await requestAt<SignatureHelp>(t, "textDocument/signatureHelp", "#t(Q => |#ready, IN := TRUE, PT := T#1s);");
      expect(timer.activeParameter).toBe(2);
      expect(timer.signatures[0]).toMatchObject({ label: "#t(IN : Bool, PT : Time, Q => Bool, ET => Time)", documentation: "On-delay timer: Q becomes TRUE when IN has been TRUE for PT." });
    } finally { t.server.dispose(); t.client.dispose(); }
  });

  it("tracks positional and unfinished arguments and chooses the innermost call", async () => {
    const t = await editorBoot();
    try {
      for (const [call, active] of [
        ['"Scale"(1, |0.0, 10.0);', 1],
        ['"Scale"(1, 0.0, |);', 2],
        ['"Scale"(|);', 0],
        ['"Scale"(Raw := 1, High := |', 2],
        ['"Scale"(High :|', 2],
        ['LIMIT(0, |1, 10);', 1],
        ['LIMIT(MX := |10, MN := 0, IN := 1);', 2],
        ['"Scale"(LIMIT(0, 1, 2), |0.0, 10.0);', 1],
      ] as const) {
        expect((await requestAt<SignatureHelp>(t, "textDocument/signatureHelp", call)).activeParameter).toBe(active);
      }
      const inner = await requestAt<SignatureHelp>(t, "textDocument/signatureHelp", '"Scale"(Raw := LIMIT(0, |1, 10), Low := 0.0, High := 10.0);');
      expect(inner.signatures[0]).toMatchObject({ label: "LIMIT(MN : ANY, IN : ANY, MX : ANY) : ANY", documentation: "Clamps IN to the range MN..MX." });
    } finally { t.server.dispose(); t.client.dispose(); }
  });

  it("returns no signature outside parentheses or inside strings and comments", async () => {
    const t = await editorBoot();
    try {
      for (const body of [
        '|"Scale"(1, 0.0, 10.0);',
        '"Scale"|(1, 0.0, 10.0);',
        '"Scale"(1, 0.0, 10.0)|;',
        "LEN('a |b');",
        "LEN(STRING#'a |b');",
        "LIMIT(0, (* |inside *) 1, 10);",
        "LIMIT(0, // |inside\n1, 10);",
        "LIMIT(0, // inside|\n1, 10);",
        "LEN('unfinished|\n);",
        "// LIMIT(0, |1, 10);",
      ]) expect(await requestAt<SignatureHelp | null>(t, "textDocument/signatureHelp", body)).toBeNull();
    } finally { t.server.dispose(); t.client.dispose(); }
  });

  it.each([false, true])("only inserts call snippets when snippetSupport is %s", async (snippets) => {
    const t = await editorBoot(snippets);
    try {
      for (const [marked, label, plain, snippet] of [
        ['"Sc|', "Scale", 'Scale"', '"Scale"(Raw := ${1}, Low := ${2}, High := ${3})'],
        ['"Motor_D|', "Motor_DB", 'Motor_DB"', '"Motor_DB"(Run := ${1}, Speed := ${2}, State := ${3}, Out => ${4})'],
        ["LIM|", "LIMIT", undefined, "LIMIT(MN := ${1}, IN := ${2}, MX := ${3})"],
        ["#Mot|", "Motor", undefined, "#Motor(Run := ${1}, Speed := ${2}, State := ${3}, Out => ${4})"],
        ["#t|", "t", undefined, "#t(IN := ${1}, PT := ${2}, Q => ${3}, ET => ${4})"],
      ] as const) {
        const items = await requestAt<CompletionItem[]>(t, "textDocument/completion", marked);
        const item = items.find((c) => c.label === label)!;
        expect(item).toBeDefined();
        expect(item.label).toBe(label);
        expect(item.insertText).toBe(snippets ? snippet : plain);
        expect(item.insertTextFormat).toBe(snippets ? 2 : undefined);
        if (snippets && marked.startsWith('"')) expect(item.textEdit).toMatchObject({ newText: snippet, range: { start: { character: 3 } } });
      }
    } finally { t.server.dispose(); t.client.dispose(); }
  });

  it("marks assignment, output and InOut destinations as writes and keeps highlights in the file", async () => {
    const t = await editorBoot();
    try {
      const other = pathToFileURL(join(t.root, "plc", "PLC_1", "blocks", "Other.scl")).href;
      await t.client.sendNotification("textDocument/didOpen", { textDocument: { uri: other, languageId: "scl", version: 1, text: EDITOR.replace('"Editor"', '"Other"').replace("BODY", '"Motor_DB"(Run := TRUE);') } });
      const h = await requestAt<DocumentHighlight[]>(t, "textDocument/documentHighlight", '#val|ue := #value + 1;\n   "Motor_DB"(State := #value, Out => #ready);\n   #t(Q => #ready);');
      expect(h.map((x) => x.kind)).toEqual([3, 2, 3]);
      const output = await requestAt<DocumentHighlight[]>(t, "textDocument/documentHighlight", '#t(IN := #ready, Q => #rea|dy);\n   #ready := FALSE;');
      expect(output.map((x) => x.kind)).toEqual([2, 3, 3]);
      const instances = await requestAt<DocumentHighlight[]>(t, "textDocument/documentHighlight", '"Motor_D|B"(Run := TRUE);\n   "Motor_DB"(Run := FALSE);');
      expect(instances.map((x) => x.kind)).toEqual([2, 2]);
      const indexed = await requestAt<DocumentHighlight[]>(t, "textDocument/documentHighlight", '"Motor_DB"(State := #values[#i|]);\n   #i := 0;');
      expect(indexed.map((x) => x.kind)).toEqual([2, 3]);
    } finally { t.server.dispose(); t.client.dispose(); }
  });
});
