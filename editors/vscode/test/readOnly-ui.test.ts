// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { RungWorkspace } from "../src/workspace";
import { StatusBar } from "../src/statusBar";
import { Activity } from "../src/core/activity";
import { PlcView } from "../src/views/plcView";

vi.mock("vscode", () => {
  class Disposable { constructor(private readonly callback = () => {}) {} dispose() { this.callback(); } }
  class EventEmitter { event = () => new Disposable(); fire() {} dispose() {} }
  class MarkdownString { value = ""; appendMarkdown(text: string) { this.value += text; } appendText(text: string) { this.value += text; } }
  return { Disposable, EventEmitter, MarkdownString, TreeItem: class {}, ThemeIcon: class {}, ThemeColor: class {}, TreeItemCollapsibleState: { None: 0 }, StatusBarAlignment: { Left: 1 },
    window: { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }) },
    commands: { executeCommand: vi.fn() },
    workspace: { onDidChangeWorkspaceFolders: () => new Disposable(), onDidChangeConfiguration: () => new Disposable(), getConfiguration: () => ({ get: () => undefined }) },
  };
});

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it.each(["environment", "PLC"])("updates the read-only context and status bar from the %s lock", async source => {
  vi.stubEnv("RUNG_READ_ONLY", source === "environment" ? "1" : "0");
  const root = mkdtempSync(join(tmpdir(), "rung-read-only-ui-"));
  writeFileSync(join(root, "rung.toml"), 'devices=["A"]\n[project]\npath="fixture.ap20"\n[live.plc.A]\ntransport="s7commplus"\naddress="192.0.2.1"\nread_only=true');
  mkdirSync(join(root, ".rung")); writeFileSync(join(root, ".rung", "writes.json"), JSON.stringify({ project: "fixture.ap20" }));
  const ws = new RungWorkspace({ debug() {} } as never); ws.root = root;
  let status: StatusBar | undefined;
  try {
    await ws.reload();
    expect(ws.writes).toBe("off");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("setContext", "rung.readOnly", true);
    const writesItem = (PlcView.prototype as any).writesItem.call({ ws });
    expect(writesItem.command).toBeUndefined();
    expect(writesItem.tooltip).toContain(source === "environment" ? "RUNG_READ_ONLY=1" : "PLC A");
    const event = () => ({ dispose() {} });
    status = new StatusBar(ws, { status: "stopped", onDidChange: event } as never, { online: () => [], get: () => ({}), onDidChange: event } as never, new Activity(), { onEvent: event } as never);
    expect(status.text).toContain("read-only");
    expect(status.tooltipText).toContain(source === "environment" ? "RUNG_READ_ONLY=1" : "PLC A");
    vi.stubEnv("RUNG_READ_ONLY", "0");
    writeFileSync(join(root, "rung.toml"), 'devices=["A"]');
    await ws.reload();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("setContext", "rung.readOnly", false);
  } finally { status?.dispose(); ws.dispose(); rmSync(root, { recursive: true, force: true }); }
});
