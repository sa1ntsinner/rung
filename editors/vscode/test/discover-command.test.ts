// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { discoverBehaviour } from "../src/commands/discover";
vi.mock("vscode", () => ({ window: { activeTextEditor: undefined, showWarningMessage: vi.fn(), showErrorMessage: vi.fn(), showInformationMessage: vi.fn(), showQuickPick: vi.fn(), createWebviewPanel: vi.fn() }, ViewColumn: { Beside: 2 }, Uri: { file: (p: string) => ({ fsPath: p }) } }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async (file: string) => file.endsWith(".json") ? JSON.stringify({ config: { block: "Motor" }, referenceTest: "block: Motor" }) : "<html>local evidence</html>") }));
afterEach(() => vi.clearAllMocks());
const panel = () => { const p = { webview: { html: "", onDidReceiveMessage: vi.fn() }, dispose() {} }; vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(p as never); return p; };

it("does not run, save or import a dirty editor", async () => {
  Object.assign(vscode.window, { activeTextEditor: { document: { isDirty: true, uri: { scheme: "file", fsPath: "/work/Motor.scl" } } } });
  const capture = vi.fn();
  await discoverBehaviour({ subscriptions: [] } as never, { root: "/work" } as never, { capture } as never);
  expect(capture).not.toHaveBeenCalled(); expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/Save/));
});

it("searches the open block without asking for a revision and opens its workbench", async () => {
  Object.assign(vscode.window, { activeTextEditor: { document: { isDirty: false, uri: { scheme: "file", fsPath: "/work/Motor.scl" } } } });
  const p = panel(), capture = vi.fn(async () => ({ code: 2, output: JSON.stringify({ version: 1, status: "found", directory: "/work/.rung/discover/123" }) }));
  await discoverBehaviour({ subscriptions: [] } as never, { root: "/work" } as never, { capture } as never);
  expect(capture.mock.calls[0]?.[0]).toEqual(["discover", "--file", "/work/Motor.scl", "--json"]);
  expect(p.webview.html).toContain("local evidence");
  expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith("rung.discovery", "Discovery: Motor", 2, expect.anything());
});

it("without an SCL file searches every changed block and opens the one difference directly", async () => {
  Object.assign(vscode.window, { activeTextEditor: undefined });
  const p = panel(), capture = vi.fn(async () => ({ code: 2, output: JSON.stringify({ version: 1, results: [{ block: "Pump", status: "not-found", summary: "no difference" }, { block: "Motor", status: "found", summary: "Running differs", directory: "/work/.rung/discover/9/Motor" }] }) }));
  await discoverBehaviour({ subscriptions: [] } as never, { root: "/work" } as never, { capture } as never);
  expect(capture.mock.calls[0]?.[0]).toEqual(["discover", "--json"]);
  expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  expect(p.webview.html).toContain("local evidence");
});
