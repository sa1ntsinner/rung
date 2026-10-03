// SPDX-License-Identifier: MIT
// The Usages view: the answer to the latest question is the one shown.
import { expect, it, vi } from "vitest";
vi.mock("vscode", () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  window: { createTreeView: () => ({ dispose() {}, title: "", description: "" }) },
  workspace: { asRelativePath: (u: unknown) => String(u) },
  commands: { executeCommand: async () => undefined },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
}));
import * as vscode from "vscode";
import { UsagesView } from "../src/views/usagesView";

it("a late result cannot replace usages from the latest invocation", async () => {
  let finishA!: (value: any) => void;
  const at = { line: 0, character: 0 };
  const result = (block: string) => ({ writes: [{ block, uri: "file:///a.scl", text: block, kind: "write", range: { start: at, end: at } }], reads: [] });
  const lsp = { request: (_: string, p: any) => p.position.character === 0 ? new Promise(r => finishA = r) : Promise.resolve(result("B")) };
  const view = new UsagesView(lsp as any);
  try {
    const pendingA = view.show(vscode.Uri.parse("file:///a.scl"), at as any, "A");
    await view.show(vscode.Uri.parse("file:///a.scl"), { line: 0, character: 5 } as any, "B");
    finishA(result("A")); await pendingA;
    expect(view.getChildren()[0]?.children?.[0]?.label).toBe("B");
  } finally { view.dispose(); }
});
