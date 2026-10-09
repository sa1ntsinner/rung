// SPDX-License-Identifier: MIT
import { expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { LiveAccess } from "../src/liveAccess";
import { parseRungToml } from "../src/core/rungToml";
vi.mock("vscode", () => ({ window: { showInputBox: vi.fn(), showWarningMessage: vi.fn(), showQuickPick: vi.fn() } }));

it("shares credentials between views but isolates PLC, target and workspace changes", async () => {
  const values = new Map<string, string>();
  const secrets = { get: async (key: string) => values.get(key), store: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
  const ws = { root: "C:/plant", config: parseRungToml('devices=["A","B"]\n[live.plc.A]\ntransport="s7commplus"\naddress="192.168.250.1"\n[live.plc.B]\ntransport="s7commplus"\naddress="192.168.250.2"'), devices: () => ["A", "B"], reload: vi.fn(async () => {}) };
  const access = new LiveAccess(ws as never, secrets as never);
  const a = (await access.select("A"))!;
  expect(ws.reload).toHaveBeenCalledOnce();
  vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("alpha");
  expect(await access.environment(a, true)).toMatchObject({ RUNG_PLC_PASSWORD: "alpha" });
  expect(await access.environment((await access.select("A"))!)).toMatchObject({ RUNG_PLC_PASSWORD: "alpha" });
  expect(await access.environment((await access.select("B"))!)).not.toHaveProperty("RUNG_PLC_PASSWORD");
  ws.config.live!.plc.A!.address = "192.168.250.3";
  expect(await access.environment((await access.select("A"))!)).not.toHaveProperty("RUNG_PLC_PASSWORD");
  ws.root = "C:/another";
  expect(await access.environment((await access.select("A"))!)).not.toHaveProperty("RUNG_PLC_PASSWORD");
});
