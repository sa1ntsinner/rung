// SPDX-License-Identifier: MIT
// The declarations panel controller with VS Code faked: which block it asks for, late answers dropped, restore, a server that starts late.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ active: undefined as any, docs: [] as any[], panels: [] as any[], selection: undefined as any, activeChanged: undefined as any, serializer: undefined as any, saved: undefined as any }));
vi.mock("vscode", () => {
  const event = (set: (fn: any) => void) => (fn: any) => { set(fn); return { dispose() {} }; };
  const noopEvent = event(() => {});
  class Uri { constructor(readonly value: string) {} toString() { return this.value; } get fsPath() { return this.value.replace("file:///", ""); } static parse(s: string) { return new Uri(s); } static joinPath(u: Uri, ...p: string[]) { return new Uri(u.value + "/" + p.join("/")); } }
  class Position { constructor(readonly line: number, readonly character: number) {} }
  return {
    Uri, Position, ViewColumn: { Beside: 2, One: 1 },
    window: {
      get activeTextEditor() { return env.active; },
      onDidChangeActiveTextEditor: event(fn => env.activeChanged = fn),
      onDidChangeTextEditorSelection: event(fn => env.selection = fn),
      createWebviewPanel: () => { const p: any = { visible: true, title: "Declarations", dispose() {}, reveal() {}, onDidDispose: noopEvent, onDidChangeViewState: noopEvent }; p.webview = { cspSource: "local", asWebviewUri: (u: any) => u, postMessage: vi.fn(), onDidReceiveMessage: event(fn => p.receive = fn) }; env.panels.push(p); return p; },
      registerWebviewPanelSerializer: (_: any, s: any) => { env.serializer = s; return { dispose() {} }; },
    },
    workspace: { get textDocuments() { return env.docs; }, onDidChangeTextDocument: noopEvent, onDidSaveTextDocument: noopEvent, asRelativePath: (p: any) => String(p), openTextDocument: vi.fn() },
  };
});
import * as vscode from "vscode";
import { DeclarationsPanel } from "../src/declarations/panel";
import type { DeclModel } from "../src/protocol/declarations";

const context = () => ({ extensionUri: vscode.Uri.parse("file:///extension"), workspaceState: { get: () => env.saved, update: vi.fn(async (_: any, b: any) => { env.saved = b; }) } }) as any;
const doc = (uri: string) => ({ uri: vscode.Uri.parse(uri), languageId: "scl", version: 1, isDirty: false, offsetAt: (p: any) => p.line * 10 + p.character });
const model = (uri: string, name: string): DeclModel => ({ uri, version: 1, block: { name, kind: "FB", range: { start: 0, end: 1000 } }, sections: [], unavailable: [], editable: true });
const deps = (request: any) => ({ lsp: { request }, ws: { rel: (p: string) => p } }) as any;
let controllers: DeclarationsPanel[] = [];
const open = (ctx: any, d: any, uri?: any, pos?: any) => { const c = DeclarationsPanel.show(ctx, d, uri, pos); controllers.push(c); return c; };
const ready = async (c: any) => { await c.handle({ v: 1, kind: "ready" }); };

beforeEach(() => { vi.useFakeTimers(); env.docs = []; env.panels = []; env.saved = undefined; env.active = undefined; });
afterEach(() => { for (const c of new Set(controllers)) c.dispose(); controllers = []; vi.useRealTimers(); });

describe("declarations panel: targets, late answers, restore", () => {
  it("a CodeLens on a second block in the same file requests its position", async () => {
    const a = doc("file:///a.scl"); env.docs = [a]; env.active = { document: a, selection: { active: new vscode.Position(0, 0) } };
    const request = vi.fn(async (_method: string, _params: any) => model(a.uri.toString(), "A")); const ctx = context(); const d = deps(request);
    const c = open(ctx, d, a.uri, new vscode.Position(0, 0)); await ready(c); request.mockClear();
    open(ctx, d, a.uri, new vscode.Position(20, 0)); await vi.advanceTimersByTimeAsync(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ position: { line: 20, character: 0 } });
  });

  it("cursor movement into a second block refreshes that block model", async () => {
    const a = doc("file:///a.scl"); env.docs = [a]; env.active = { document: a, selection: { active: new vscode.Position(0, 0) } };
    const request = vi.fn(async (_method: string, _params: any) => model(a.uri.toString(), "A")); const c = open(context(), deps(request)); await ready(c); request.mockClear();
    // line 200 is offset 2000 here, outside block A (0..1000): the next block
    env.selection({ textEditor: env.active, selections: [{ active: new vscode.Position(200, 0) }] }); await vi.advanceTimersByTimeAsync(500);
    expect(request).toHaveBeenCalledWith("rung/declarations", expect.objectContaining({ position: { line: 200, character: 0 } }));
  });

  it("a late response for the old file cannot overwrite the current target", async () => {
    const a = doc("file:///a.scl"), b = doc("file:///b.scl"); env.docs = [a, b]; env.active = { document: a, selection: { active: new vscode.Position(0, 0) } };
    let finishA!: (v: DeclModel) => void;
    const request = vi.fn((_method: string, p: any) => p.textDocument.uri === a.uri.toString() ? new Promise<DeclModel>(r => finishA = r) : Promise.resolve(model(b.uri.toString(), "B")));
    const c: any = open(context(), deps(request)); c.ready = true; const pending = c.refresh();
    c.bind({ pinned: false, uri: b.uri.toString() }, new vscode.Position(0, 0)); await vi.advanceTimersByTimeAsync(1);
    finishA(model(a.uri.toString(), "A")); await pending;
    expect(c.model.uri).toBe(b.uri.toString()); expect(env.panels[0].title).toBe("B · Declarations");
  });

  it("first open stores the target so a reload restores the same file", async () => {
    const a = doc("file:///a.scl"); env.docs = [a]; env.active = { document: a, selection: { active: new vscode.Position(0, 0) } };
    const ctx = context(); const c = open(ctx, deps(vi.fn(async (_method: string, _params: any) => model(a.uri.toString(), "A")))); await ready(c);
    expect(env.saved).toEqual({ pinned: false, uri: a.uri.toString() });
  });

  it("a restored panel receives a model when the server finishes starting", async () => {
    const a = doc("file:///a.scl"); env.docs = [a]; env.active = { document: a, selection: { active: new vscode.Position(0, 0) } };
    let running = false; const request = vi.fn(async () => running ? model(a.uri.toString(), "A") : undefined);
    const c = open(context(), deps(request)); await ready(c); running = true; await vi.advanceTimersByTimeAsync(1000);
    expect(env.panels[0].webview.postMessage.mock.calls.some(([m]: any[]) => m.kind === "model")).toBe(true);
  });
});
