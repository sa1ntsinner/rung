// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerCommands } from "../src/commands";
import { parseRungToml } from "../src/core/rungToml";

vi.mock("vscode", () => ({ window: { showWarningMessage: vi.fn(), showQuickPick: vi.fn() }, commands: { registerCommand: vi.fn(() => ({ dispose() {} })) } }));
vi.mock("../src/commands/trace", () => ({ TraceCommands: class { dispose() {} } }));
vi.mock("../src/commands/merge", () => ({ registerMerge: vi.fn() }));
vi.mock("../src/commands/record", () => ({ recordExpectations: vi.fn() }));
vi.mock("../src/commands/init", () => ({ initCommand: vi.fn() }));
vi.mock("../src/commands/targets", () => ({ fileTarget: vi.fn(), deviceTarget: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it.each(["environment", "PLC"])("blocks command-id writes-on and apply handlers under the %s lock", async source => {
  vi.stubEnv("RUNG_READ_ONLY", source === "environment" ? "1" : "0");
  const cli = { run: vi.fn().mockResolvedValue({ code: 1 }), capture: vi.fn() }, changes = { syncReviewed: vi.fn() }, watch = { start: vi.fn() };
  const ws = { hasConfig: true, config: parseRungToml('[live.plc.A]\ntransport="s7commplus"\naddress="192.0.2.1"\nread_only=true'), reload: vi.fn(async () => {}) };
  registerCommands({ subscriptions: [], secrets: {} } as never, { ws, cli, changes, watch } as never);
  for (const id of ["rung.writes.on", "rung.projectAssets.apply", "rung.changes.sync"]) {
    const handler = vi.mocked(vscode.commands.registerCommand).mock.calls.find(call => call[0] === id)?.[1];
    expect(handler).toBeTypeOf("function");
    await handler!();
  }
  expect(cli.run).not.toHaveBeenCalled();
  expect(cli.capture).not.toHaveBeenCalled();
  expect(changes.syncReviewed).not.toHaveBeenCalled();
  expect(watch.start).not.toHaveBeenCalled();
  expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(source === "environment" ? "RUNG_READ_ONLY=1" : "PLC A"));
});
