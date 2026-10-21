// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { AgentMode } from "../src/agentMode";

vi.mock("vscode", () => ({
  StatusBarAlignment: { Left: 1 },
  ThemeColor: class { constructor(readonly id: string) {} },
  window: { createStatusBarItem: vi.fn(), showQuickPick: vi.fn(), createTerminal: vi.fn(), onDidChangeWindowState: vi.fn(() => ({ dispose() {} })), onDidCloseTerminal: vi.fn(() => ({ dispose() {} })) },
  commands: { registerCommand: vi.fn(() => ({ dispose() {} })) },
}));
afterEach(() => vi.clearAllMocks());
function setup(plcs = [{ plc: "PLC_1", mode: "auto", source: "workspace", actions: ["write"] }]) {
  const item = { text: "", tooltip: "", backgroundColor: undefined, show: vi.fn(), hide: vi.fn(), dispose() {} };
  vi.mocked(vscode.window.createStatusBarItem).mockReturnValue(item as never);
  const ws = { root: "C:/plant", hasConfig: true, onDidChange: () => ({ dispose() {} }) };
  const cli = { capture: vi.fn(async () => ({ code: 0, output: JSON.stringify({ workspace: ws.root, plcs }) })), invocation: vi.fn((args) => ({ file: "rung", args })) };
  const mode = new AgentMode(ws as never, cli as never);
  return { mode, item, cli, ws };
}
it("hides manual and shows permissive modes, warning for bypass", async () => {
  for (const value of ["manual", "ask", "auto", "bypass"]) {
    const s = setup([{ plc: "PLC_1", mode: value, source: "PLC", actions: [] }]);
    await s.mode.refresh();
    expect(s.cli.capture).toHaveBeenCalledWith(["agent-mode", "--json"], expect.anything());
    if (value === "manual") expect(s.item.hide).toHaveBeenCalled();
    else expect(s.item.text).toContain(value);
    expect(s.item.backgroundColor).toEqual(value === "bypass" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined);
    s.mode.dispose();
  }
});
it("runs mode changes in a real terminal with inherited markers and a typed-name prompt", async () => {
  const s = setup();
  const show = vi.fn();
  vi.mocked(vscode.window.createTerminal).mockReturnValue({ show } as never);
  vi.mocked(vscode.window.showQuickPick)
    .mockResolvedValueOnce({ label: "auto" } as never)
    .mockResolvedValueOnce({ label: "PLC_1", plc: "PLC_1" } as never)
    .mockResolvedValueOnce([{ label: "write" }] as never)
    .mockResolvedValueOnce({ label: "8 hours", duration: "8h" } as never);
  await s.mode.choose();
  expect(s.cli.invocation).toHaveBeenCalledWith(["agent-mode", "auto", "--plc", "PLC_1", "--actions", "write", "--for", "8h"]);
  expect(vscode.window.createTerminal).toHaveBeenCalledWith({ name: "rung agent mode", cwd: s.ws.root, shellPath: "rung", shellArgs: ["agent-mode", "auto", "--plc", "PLC_1", "--actions", "write", "--for", "8h"] });
  expect(show).toHaveBeenCalled();
  s.mode.dispose();
});
