// SPDX-License-Identifier: MIT
// A declarations session edits only the file and text its view showed: an answer that takes a while (a confirmation,
// the language server) does not carry an edit over to the file the view shows by then.
import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ docs: [] as any[], applied: [] as any[], confirm: undefined as undefined | ((v: string | undefined) => void) }));
vi.mock("vscode", () => {
  const noopEvent = () => ({ dispose() {} });
  class Uri { constructor(readonly value: string) {} toString() { return this.value; } get fsPath() { return this.value.replace("file:///", ""); } static parse(s: string) { return new Uri(s); } }
  class Position { constructor(readonly line: number, readonly character: number) {} }
  class Range { constructor(readonly a: number, readonly b: number, readonly c: number, readonly d: number) {} }
  class WorkspaceEdit { readonly edits: any[] = []; replace(uri: any, range: any, text: string) { this.edits.push({ uri: String(uri), range, text }); } get size() { return this.edits.length; } }
  return {
    Uri, Position, Range, WorkspaceEdit,
    window: { showWarningMessage: () => new Promise((r) => (env.confirm = r)), setStatusBarMessage: () => {} },
    workspace: { get textDocuments() { return env.docs; }, onDidChangeTextDocument: noopEvent, onDidSaveTextDocument: noopEvent, asRelativePath: (p: any) => String(p), applyEdit: async (e: any) => (env.applied.push(e), true) },
    commands: { executeCommand: async () => undefined },
  };
});
import { DeclarationsSession } from "../src/declarations/session";
import type { DeclModel } from "../src/protocol/declarations";

const doc = (uri: string) => ({ uri: { toString: () => uri, fsPath: uri }, version: 1, isDirty: false, getText: () => "x : Bool;", positionAt: (o: number) => ({ line: 0, character: o }) });
const ranges = { whole: { start: 0, end: 9 }, name: { start: 0, end: 1 }, type: { start: 4, end: 8 } };
const model = (uri: string): DeclModel => ({
  uri,
  version: 1,
  block: { name: "B", kind: "FB", range: { start: 0, end: 9 } },
  editable: true,
  unavailable: [],
  sections: [{ id: "Static-0", title: "Static", keyword: "VAR", modifiers: [], range: { start: 0, end: 9 }, body: { start: 0, end: 9 }, rows: [{ id: "x", depth: 0, name: "x", type: "Bool", kind: "plain", attrs: { accessible: { value: true, explicit: false }, visible: { value: true, explicit: false }, writable: { value: true, explicit: false }, setpoint: { value: false, explicit: false } }, hmi: true, other: [], ranges }] }],
});

describe("declarations session", () => {
  it("a delete confirmed after the view moved to another file is not applied", async () => {
    const A = "file:///a.scl", B = "file:///b.scl";
    env.docs = [doc(A), doc(B)];
    let bound = A;
    const request = vi.fn(async (method: string, p: any) => {
      if (method === "rung/declarations") return model(p.textDocument.uri);
      if (method === "rung/usages") return { writes: [{ uri: A, range: { start: { line: 3, character: 0 } } }], reads: [] };
      if (method === "rung/declarationEdit") return { ok: true, version: 1, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }, old: "x : Bool;", newText: "" }] };
      return undefined;
    });
    const s = new DeclarationsSession({ onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async () => true } as any, { lsp: { request }, ws: { rel: (p: string) => p } } as any, {
      uri: () => bound,
      position: () => undefined,
      visible: () => true,
      title: () => {},
      pinned: () => false,
      focus: () => {},
    });
    await s.receive({ v: 1, kind: "ready" });
    const answer = s.receive({ v: 1, kind: "delete", req: 1, uri: A, version: 1, rowId: "x" });
    await vi.waitFor(() => expect(env.confirm).toBeDefined());
    // the panel follows another editor while the question is open
    bound = B;
    env.confirm!("Delete");
    expect(await answer).toMatchObject({ kind: "result", ok: false });
    expect(env.applied).toEqual([]);
    s.dispose();
  });
});
