// SPDX-License-Identifier: BUSL-1.1
// rung lsp: Language Server Protocol adapter over the workspace index and the rung sync diagnostics.
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createConnection,
  DiagnosticSeverity,
  DocumentSymbol,
  MarkupKind,
  ProposedFeatures,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  CompletionItemKind,
  type Connection,
  type Diagnostic as LspDiagnostic,
  type MessageReader,
  type MessageWriter,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { OwnerClient, type Diagnostic as SyncDiagnostic } from "@rung/sync";
import { WorkspaceIndex } from "./workspace.js";
import { complete, definition, diagnostics, hover, outline, references, rename, type CompletionKind, type OutlineSymbol } from "./features.js";

const SEVERITY = { error: DiagnosticSeverity.Error, warning: DiagnosticSeverity.Warning, information: DiagnosticSeverity.Information, info: DiagnosticSeverity.Information } as const;
const COMPLETION_KIND: Record<CompletionKind, CompletionItemKind> = {
  variable: CompletionItemKind.Variable,
  field: CompletionItemKind.Field,
  function: CompletionItemKind.Function,
  class: CompletionItemKind.Class,
  keyword: CompletionItemKind.Keyword,
  type: CompletionItemKind.TypeParameter,
  constant: CompletionItemKind.Constant,
  module: CompletionItemKind.Module,
};
const OUTLINE_KIND = { block: SymbolKind.Class, section: SymbolKind.Namespace, variable: SymbolKind.Variable, region: SymbolKind.Namespace } as const;

export interface ServerHandle {
  connection: Connection;
  index: WorkspaceIndex;
  dispose(): void;
}

export function startServer(reader?: MessageReader, writer?: MessageWriter): ServerHandle {
  const connection = reader && writer ? createConnection(ProposedFeatures.all, reader, writer) : createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  const documents = new TextDocuments(TextDocument);
  const index = new WorkspaceIndex();
  let root: string | undefined;
  let syncDiags: SyncDiagnostic[] = [];
  let fsWatcher: FSWatcher | undefined;
  let owner: OwnerClient | null = null;
  let pollTimer: NodeJS.Timeout | undefined;
  const timers = new Map<string, NodeJS.Timeout>();

  const pos = (uri: string, offset: number) => index.docs.get(uri)!.lines.position(offset);
  const range = (uri: string, start: number, end: number) => ({ start: pos(uri, start), end: pos(uri, end) });
  const offsetOf = (uri: string, p: { line: number; character: number }) => index.docs.get(uri)?.lines.offset(p.line, p.character) ?? 0;
  const relPath = (uri: string) => (root ? fileURLToPath(uri).slice(root.length + 1).split("\\").join("/") : "");

  async function publish(uri: string) {
    const doc = index.docs.get(uri);
    if (!doc) return;
    const items: LspDiagnostic[] = diagnostics(index, uri).map((d) => ({ range: range(uri, d.start, d.end), severity: SEVERITY[d.severity], message: d.message, code: d.code, source: "rung" }));
    // Compile/conflict diagnostics describe the file as synced; hide them while the buffer differs from disk.
    let onDisk = doc.text;
    try {
      onDisk = await readFile(fileURLToPath(uri), "utf8");
    } catch {
      /* new buffer */
    }
    if (onDisk === doc.text) {
      const rel = relPath(uri);
      for (const d of syncDiags.filter((x) => x.path === rel)) {
        const line = d.line ? Math.max(0, d.line - 1) : 0;
        items.push({ range: { start: { line, character: 0 }, end: { line, character: 200 } }, severity: SEVERITY[d.severity], message: d.message, code: d.code, source: "rung sync" });
      }
    }
    await connection.sendDiagnostics({ uri, diagnostics: items });
  }

  function schedule(uri: string) {
    clearTimeout(timers.get(uri));
    timers.set(uri, setTimeout(() => void publish(uri), 150));
  }

  async function loadSyncDiagnostics() {
    if (!root) return;
    try {
      syncDiags = (JSON.parse(await readFile(join(root, ".rung", "diagnostics.json"), "utf8")) as { items: SyncDiagnostic[] }).items ?? [];
    } catch {
      syncDiags = [];
    }
    for (const uri of index.docs.keys()) if (index.docs.get(uri)!.parsed) schedule(uri);
  }

  connection.onInitialize(async (params) => {
    const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined;
    if (folder) {
      root = fileURLToPath(folder);
      await index.load(root);
      await loadSyncDiagnostics();
    }
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: { triggerCharacters: ["#", '"', "."] },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: true,
        documentSymbolProvider: true,
      },
      serverInfo: { name: "rung", version: "0.1.0" },
    };
  });

  connection.onInitialized(async () => {
    if (!root) return;
    // Files rewritten by rung sync (or edited elsewhere) are re-read; open buffers win.
    try {
      fsWatcher = watch(join(root, "plc"), { recursive: true }, (_e, file) => {
        if (!file || /(^|[\\/])\./.test(String(file))) return;
        const uri = pathToFileURL(join(root!, "plc", String(file))).href;
        if (documents.get(uri)) return;
        void readFile(fileURLToPath(uri), "utf8").then(
          (t) => {
            index.set(uri, t, 0);
            schedule(uri);
          },
          () => index.remove(uri),
        );
      });
    } catch {
      /* no plc folder yet */
    }
    owner = await OwnerClient.connect(root);
    if (owner) await owner.subscribe((event) => event === "diagnostics" && void loadSyncDiagnostics()).catch(() => {});
    else pollTimer = setInterval(() => void loadSyncDiagnostics(), 2000);
  });

  documents.onDidChangeContent((e) => {
    index.set(e.document.uri, e.document.getText(), e.document.version);
    schedule(e.document.uri);
  });
  documents.onDidClose(async (e) => {
    try {
      index.set(e.document.uri, await readFile(fileURLToPath(e.document.uri), "utf8"), 0);
    } catch {
      index.remove(e.document.uri);
    }
  });

  connection.onCompletion((p) =>
    complete(index, p.textDocument.uri, offsetOf(p.textDocument.uri, p.position)).map((c) => ({
      label: c.label,
      kind: COMPLETION_KIND[c.kind],
      ...(c.detail ? { detail: c.detail } : {}),
      ...(c.insertText ? { insertText: c.insertText } : {}),
      ...(c.documentation ? { documentation: c.documentation } : {}),
    })),
  );
  connection.onHover((p) => {
    const h = hover(index, p.textDocument.uri, offsetOf(p.textDocument.uri, p.position));
    return h ? { contents: { kind: MarkupKind.Markdown, value: h.markdown }, range: range(p.textDocument.uri, h.start, h.end) } : null;
  });
  connection.onDefinition((p) => {
    const d = definition(index, p.textDocument.uri, offsetOf(p.textDocument.uri, p.position));
    return d && index.docs.get(d.uri) ? { uri: d.uri, range: range(d.uri, d.start, d.end) } : null;
  });
  connection.onReferences((p) =>
    references(index, p.textDocument.uri, offsetOf(p.textDocument.uri, p.position), p.context.includeDeclaration)
      .filter((l) => index.docs.get(l.uri))
      .map((l) => ({ uri: l.uri, range: range(l.uri, l.start, l.end) })),
  );
  connection.onRenameRequest((p) => {
    const r = rename(index, p.textDocument.uri, offsetOf(p.textDocument.uri, p.position), p.newName);
    if (!Array.isArray(r)) throw new Error(r.error);
    const changes: Record<string, { range: ReturnType<typeof range>; newText: string }[]> = {};
    for (const e of r) (changes[e.uri] ??= []).push({ range: range(e.uri, e.start, e.end), newText: e.newText });
    return { changes };
  });
  connection.onDocumentSymbol((p) => {
    const conv = (s: OutlineSymbol): DocumentSymbol => ({
      name: s.name,
      ...(s.detail ? { detail: s.detail } : {}),
      kind: OUTLINE_KIND[s.kind],
      range: range(p.textDocument.uri, s.start, s.end),
      selectionRange: range(p.textDocument.uri, s.start, s.end),
      children: s.children.map(conv),
    });
    return outline(index, p.textDocument.uri).map(conv);
  });
  connection.onShutdown(() => dispose());

  function dispose() {
    fsWatcher?.close();
    clearInterval(pollTimer);
    owner?.close();
    for (const t of timers.values()) clearTimeout(t);
  }

  documents.listen(connection);
  connection.listen();
  return { connection, index, dispose };
}
