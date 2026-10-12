// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { downloadCommand } from "../src/commands/download";
import { parseRungToml } from "../src/core/rungToml";
vi.mock("vscode", () => ({ window: { showWarningMessage: vi.fn() } }));
vi.mock("../src/commands/targets", () => ({ deviceTarget: async () => "A" }));
vi.mock("../src/runner/cli", () => ({ RungCli: {} }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(["environment", "PLC"])("blocks direct download under the %s lock before connection or CLI work", async source => {
  vi.stubEnv("RUNG_READ_ONLY", source === "environment" ? "1" : "0");
  const ws = { hasConfig: true, reload: vi.fn(async () => {}), config: parseRungToml('[plc.A]\nmode="PN/IE"\npc_interface="Ethernet"\nread_only=true') };
  const cli = { run: vi.fn() }, connector = { ensure: vi.fn() };
  await downloadCommand(ws as never, cli as never, {} as never, connector as never, "A");
  expect(cli.run).not.toHaveBeenCalled();
  expect(connector.ensure).not.toHaveBeenCalled();
  expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(source === "environment" ? "RUNG_READ_ONLY=1" : "PLC A"));
});
