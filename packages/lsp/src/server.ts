// SPDX-License-Identifier: BUSL-1.1
// rung lsp: Language Server Protocol adapter over the workspace index and the rung sync diagnostics.
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CodeActionKind,
  createConnection,
  DiagnosticSeverity,
  DocumentSymbol,
  MarkupKind,
  MessageType,
  ProposedFeatures,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  CompletionItemKind,
  DocumentHighlightKind,
  InsertTextFormat,
  type Connection,
  type Diagnostic as LspDiagnostic,
  type MessageReader,
  type MessageWriter,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { OwnerClient, type Diagnostic as SyncDiagnostic } from "@rung/sync";
import { WorkspaceIndex, deviceOfUri } from "./workspace.js";
import { isSimaticMl } from "./simaticml.js";
import { complete, definition, diagnostics, documentHighlights, hover, outline, references, rename, renameTarget, signatureHelp, usagesAt, type CompletionKind, type OutlineSymbol, type UsageSite } from "./features.js";
import { codeActions } from "./actions.js";
import { testKeyEdits } from "./testkeys.js";
import { foldingRanges } from "./folding.js";
import { workspaceSymbols, type FoundSymbol } from "./symbols.js";
import { Monitoring, MONITOR_COMMAND, STOP_MONITOR_COMMAND, type MonitorProvider } from "./monitor.js";

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
const GLOBAL_KIND = { FB: SymbolKind.Class, FC: SymbolKind.Function, OB: SymbolKind.Event, DB: SymbolKind.Module, UDT: SymbolKind.Struct, PRG: SymbolKind.Module, GVL: SymbolKind.Namespace, GVAR: SymbolKind.Variable, TAG: SymbolKind.Variable, OBJECT: SymbolKind.Object } as const;
const globalKind = (s: FoundSymbol) => (s.constant ? SymbolKind.Constant : GLOBAL_KIND[s.kind]);

export type { MessageReader, MessageWriter };

export interface ServerHandle {
  connection: Connection;
  index: WorkspaceIndex;
  dispose(): void;
}

export interface ServerOptions {
  monitor?: MonitorProvider;
  /** Renames a block, data type or DB in TIA Portal the way rung rename does (the CLI fills it in). */
  renamer?: Renamer;
}

export interface Renamer {
  /**
   * fileUri is the object's workspace file. TIA Portal renames it and keeps every use, and rung writes the files
   * that follow: the editor gets no text edits. Resolves with the renamed object's file and how many others followed.
   */
  rename(fileUri: string, newName: string): Promise<{ newUri?: string; users: number }>;
}

export function startServer(reader?: MessageReader, writer?: MessageWriter, options: ServerOptions = {}): ServerHandle {
  const connection = reader && writer ? createConnection(ProposedFeatures.all, reader, writer) : createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  const documents = new TextDocuments(TextDocument);
  const index = new WorkspaceIndex();
  let root: string | undefined;
  let syncDiags: SyncDiagnostic[] = [];
  let fsWatcher: FSWatcher | undefined;
  let owner: OwnerClient | null = null;
  let pollTimer: NodeJS.Timeout | undefined;
  const timers = new Map<string, NodeJS.Timeout>();
  let refreshSupport = false;
  let snippetSupport = false;
  let progressSupport = false;
  /** What rung watch is doing now (sending a file, compiling), shown by the editor as progress. */
  let phase: { done(): void; report(message: string): void } | undefined;
  let monitor = options.monitor ? new Monitoring(index, options.monitor, () => {
    if (refreshSupport) void connection.languages.inlayHint.refresh().catch(() => undefined);
  }, (message) => void connection.sendNotification("window/showMessage", { type: MessageType.Error, message }).catch(() => undefined)) : undefined;

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

  let phaseRun = 0;
  /** rung watch's "sending Fx_Motor.scl to TIA Portal", "compiling …" as the editor's progress, until the pass reports. */
  async function showPhase(p: { phase: string; detail: string }) {
    if (!progressSupport) return;
    const message = p.phase === "sending" ? `sending ${p.detail.split("/").pop()} to TIA Portal` : `${p.phase} ${p.detail}`;
    if (phase) return phase.report(message);
    const run = ++phaseRun;
    const progress = await connection.window.createWorkDoneProgress();
    // the pass reported while the editor was asked for a progress: nothing to show any more
    if (run !== phaseRun) return progress.done();
    progress.begin("rung", undefined, message);
    phase = progress;
  }
  function endPhase() {
    phaseRun++;
    phase?.done();
    phase = undefined;
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
    refreshSupport = params.capabilities.workspace?.inlayHint?.refreshSupport === true;
    snippetSupport = params.capabilities.textDocument?.completion?.completionItem?.snippetSupport === true;
    progressSupport = params.capabilities.window?.workDoneProgress === true;
    // an editor with monitoring of its own (rung's VS Code extension) turns this one off
    if ((params.initializationOptions as { monitor?: boolean } | undefined)?.monitor === false) monitor = undefined;
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
        signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [":"] },
        documentHighlightProvider: true,
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        foldingRangeProvider: true,
        inlayHintProvider: !!monitor,
        codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, ...(monitor ? [CodeActionKind.Empty] : [])] },
        executeCommandProvider: { commands: ["rung.lsp.createFile", ...(monitor ? [MONITOR_COMMAND, STOP_MONITOR_COMMAND] : [])] },
      },
      serverInfo: { name: "rung", version: "0.1.0" },
    };
  });

  connection.onInitialized(async () => {
    if (!root) return;
    // Files rewritten by rung sync (or edited elsewhere) are re-read; open buffers win.
    try {
      // rung workspaces mirror into plc/; VCI exports and IEC projects are watched from the root
      const watched = index.layout === "rung" ? join(root, "plc") : root;
      fsWatcher = watch(watched, { recursive: true }, (_e, file) => {
        if (!file || /(^|[\\/])\./.test(String(file))) return;
        if (index.layout !== "rung" && !/\.(scl|db|udt|awl|st|xml|TcPOU|TcDUT|TcGVL|TcIO)$/i.test(String(file))) return;
        const uri = pathToFileURL(join(watched, String(file))).href;
        if (documents.get(uri)) return;
        void readFile(fileURLToPath(uri), "utf8").then(
          (t) => {
            if (index.layout !== "rung" && /\.xml$/i.test(String(file)) && !isSimaticMl(t) && !/technology objects/i.test(String(file))) return;
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
    if (owner)
      await owner
        .subscribe((event, params) => {
          if (event === "diagnostics") void loadSyncDiagnostics();
          if (event === "phase") void showPhase(params as { phase: string; detail: string });
          if (event === "report" || event === "error") endPhase();
        })
        .catch(() => {});
    else pollTimer = setInterval(() => void loadSyncDiagnostics(), 2000);
  });

  documents.onDidChangeContent((e) => {
    monitor?.stop(e.document.uri);
    index.set(e.document.uri, e.document.getText(), e.document.version);
    schedule(e.document.uri);
  });
  documents.onDidClose(async (e) => {
    monitor?.stop(e.document.uri);
    try {
      index.set(e.document.uri, await readFile(fileURLToPath(e.document.uri), "utf8"), 0);
    } catch {
      index.remove(e.document.uri);
    }
  });

  connection.onCompletion((p) =>
    complete(index, p.textDocument.uri, offsetOf(p.textDocument.uri, p.position), snippetSupport).map((c) => ({
      label: c.label,
      kind: COMPLETION_KIND[c.kind],
      ...(c.detail ? { detail: c.detail } : {}),
      ...(c.insertText ? { insertText: c.insertText } : {}),
      ...(c.snippet ? { insertTextFormat: InsertTextFormat.Snippet } : {}),
      ...(c.replaceStart !== undefined ? { textEdit: { range: range(p.textDocument.uri, c.replaceStart, offsetOf(p.textDocument.uri, p.position)), newText: c.insertText! } } : {}),
      ...(c.documentation ? { documentation: c.documentation } : {}),
    })),
  );
  connection.onSignatureHelp((p) => signatureHelp(index, p.textDocument.uri, offsetOf(p.textDocument.uri, p.position)) ?? null);
  connection.onDocumentHighlight((p) => documentHighlights(index, p.textDocument.uri, offsetOf(p.textDocument.uri, p.position)).map((h) => ({
    range: range(p.textDocument.uri, h.start, h.end),
    kind: h.kind === "write" ? DocumentHighlightKind.Write : DocumentHighlightKind.Read,
  })));
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
  // rung's own request: who writes and who reads what is under the cursor, with the line and the block
  connection.onRequest("rung/usages", (p: { textDocument: { uri: string }; position: { line: number; character: number } }) => {
    const r = usagesAt(index, p.textDocument.uri, offsetOf(p.textDocument.uri, p.position));
    const line = (uri: string, start: number) => {
      const text = index.docs.get(uri)?.text ?? "";
      const from = text.lastIndexOf("\n", start - 1) + 1;
      const to = text.indexOf("\n", start);
      return text.slice(from, to < 0 ? undefined : to).trim();
    };
    const out = (s: UsageSite) => ({
      uri: s.uri,
      range: range(s.uri, s.start, s.end),
      kind: s.kind,
      block: s.block,
      text: line(s.uri, s.start),
      ...(s.calledFrom ? { calledFrom: s.calledFrom.map((c) => ({ block: c.block, uri: c.uri, range: range(c.uri, c.start, c.start) })) } : {}),
      ...(s.through ? { through: { block: s.through.block, param: s.through.param, uri: s.through.uri, range: range(s.through.uri, s.through.start, s.through.start), text: line(s.through.uri, s.through.start) } } : {}),
      ...(s.whole ? { whole: true } : {}),
      ...(s.handedTo ? { handedTo: s.handedTo } : {}),
    });
    const list = (l: UsageSite[]) => l.filter((s) => index.docs.get(s.uri)).map(out);
    return { writes: list(r.writes), reads: list(r.reads), ...(r.handedOn ? { handedOn: list(r.handedOn) } : {}) };
  });
  connection.onRenameRequest(async (p) => {
    const uri = p.textDocument.uri;
    const offset = offsetOf(uri, p.position);
    const target = renameTarget(index, uri, offset);
    if (target) {
      // a block, data type or DB: renamed in TIA Portal, so its uses there follow too, and rung writes the files
      if (!options.renamer) throw new Error(`"${target.name}" is renamed in TIA Portal: rung rename "${target.name}" ${p.newName}`);
      // rung renames what is on disk and rewrites the files that follow: an unsaved buffer would name another
      // object, or overwrite that rewrite when saved
      const unsaved: string[] = [];
      for (const d of documents.all()) {
        const disk = await readFile(fileURLToPath(d.uri), "utf8").catch(() => undefined);
        if (disk !== d.getText()) unsaved.push(relPath(d.uri) || fileURLToPath(d.uri));
      }
      if (unsaved.length) throw new Error(`Save ${unsaved.join(", ")} first: rung renames "${target.name}" in TIA Portal and in the files on disk`);
      const done = await options.renamer.rename(target.uri, p.newName);
      const followed = done.users ? `; ${done.users} ${done.users === 1 ? "file that uses it follows" : "files that use it follow"}` : "";
      void connection.sendNotification("window/showMessage", { type: MessageType.Info, message: `Renamed "${target.name}" to "${p.newName}" in TIA Portal${followed}` }).catch(() => undefined);
      if (done.newUri) void connection.window.showDocument({ uri: done.newUri }).catch(() => undefined);
      return { changes: {} };
    }
    const r = rename(index, uri, offset, p.newName);
    if (!Array.isArray(r)) throw new Error(r.error);
    const changes: Record<string, { range: ReturnType<typeof range>; newText: string }[]> = {};
    for (const e of r) (changes[e.uri] ??= []).push({ range: range(e.uri, e.start, e.end), newText: e.newText });
    // a block's parameter is named by its tests too: set: { Start: true }, expect: { "Data.Running": true }
    const decl = r[0];
    const block = decl && index.blockAt(decl.uri, decl.start);
    const v = block?.vars.find((x) => x.start === decl!.start);
    if (root && block && v && (block.kind === "FB" || block.kind === "FC") && ["Input", "Output", "InOut", "Static"].includes(v.section))
      for (const [file, edits] of await testKeyEdits(root, block.name, v.name, p.newName, deviceOfUri(decl!.uri))) changes[pathToFileURL(file).href] = edits;
    return { changes };
  });
  connection.onCodeAction((p) => {
    const uri = p.textDocument.uri;
    const fixes = codeActions(index, uri, offsetOf(uri, p.range.start), offsetOf(uri, p.range.end)).map((f) => {
      const byUri = new Map<string, { range: ReturnType<typeof range>; newText: string }[]>();
      for (const e of f.edits) byUri.set(e.uri, [...(byUri.get(e.uri) ?? []), { range: range(e.uri, e.start, e.end), newText: e.newText }]);
      const documentChanges = [...byUri].map(([u, edits]) => ({ textDocument: { uri: u, version: documents.get(u)?.version ?? null }, edits }));
      return {
        title: f.title,
        kind: CodeActionKind.QuickFix,
        isPreferred: !!f.preferred,
        diagnostics: p.context.diagnostics.filter((d) => d.code === f.code),
        edit: { documentChanges },
        // a new file is written by the server with its content (an LSP create-file edit carries none)
        ...(f.create ? { command: { title: f.title, command: "rung.lsp.createFile", arguments: [f.create.uri, f.create.text] } } : {}),
      };
    });
    return [...fixes, ...(p.context.only?.length && !p.context.only.includes(CodeActionKind.Empty) ? [] : monitor?.actions(uri) ?? [])];
  });
  connection.languages.inlayHint.on((p) => monitor?.hints(p.textDocument.uri, p.range) ?? []);
  connection.onExecuteCommand(async (p) => {
    if (p.command === MONITOR_COMMAND || p.command === STOP_MONITOR_COMMAND) {
      const [uri, instance] = p.arguments ?? [];
      if (typeof uri !== "string" || (instance !== undefined && typeof instance !== "string")) return;
      if (p.command === STOP_MONITOR_COMMAND) monitor?.stop(uri);
      else if (documents.get(uri)) await monitor?.start(uri, instance);
      return;
    }
    if (p.command !== "rung.lsp.createFile" || !root) return;
    const [uri, text] = (p.arguments ?? []) as [string, string];
    const path = fileURLToPath(uri);
    // only new sources inside the workspace's plc folder
    if (!resolve(path).toLowerCase().startsWith(resolve(root, "plc").toLowerCase() + sep) || !/\.(scl|db|udt)$/i.test(path)) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { flag: "wx" }).catch(() => {}); // never over an existing file
  });
  connection.onWorkspaceSymbol((p) =>
    workspaceSymbols(index, p.query).map((s) => ({ name: s.name, kind: globalKind(s), location: { uri: s.uri, range: range(s.uri, s.start, s.end) }, ...(s.container ? { containerName: s.container } : {}) })),
  );
  connection.onFoldingRanges((p) => {
    const doc = index.docs.get(p.textDocument.uri);
    return doc ? foldingRanges(doc) : [];
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
  // the editor may end the process right after the answer: the PLC's Web API session is logged out first
  connection.onShutdown(async () => {
    dispose();
    await monitor?.closed(3000);
  });

  function dispose() {
    monitor?.stop(undefined, false);
    fsWatcher?.close();
    clearInterval(pollTimer);
    owner?.close();
    for (const t of timers.values()) clearTimeout(t);
  }

  documents.listen(connection);
  connection.listen();
  return { connection, index, dispose };
}
