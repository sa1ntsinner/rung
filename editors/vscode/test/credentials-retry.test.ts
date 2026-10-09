// SPDX-License-Identifier: MIT
import { beforeEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { Connector } from "../src/commands/connect";
import { compareCommand } from "../src/commands/compare";

vi.mock("vscode", () => ({ window: { showInputBox: vi.fn(), showWarningMessage: vi.fn(), showErrorMessage: vi.fn(), showInformationMessage: vi.fn() }, commands: { executeCommand: vi.fn() } }));
vi.mock("../src/runner/cli", () => ({ RungCli: { summary: (s: string) => s } }));
vi.mock("../src/commands/targets", () => ({ deviceTarget: async () => "PLC_1" }));

beforeEach(() => vi.resetAllMocks());

function setup() {
  const values = new Map<string, string>();
  const secrets = { get: async (key: string) => values.get(key), store: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
  const ws = { root: process.cwd(), config: { projectPath: "Line.ap20", plc: {} }, reload: async () => {} };
  const cli = { capture: vi.fn() };
  const changes = { setComparison: vi.fn() };
  const out = { show: vi.fn() };
  const connector = new Connector(ws as never, cli as never, out as never, secrets as never);
  const run = () => compareCommand(ws as never, cli as never, out as never, connector, changes as never, "PLC_1");
  return { connector, cli, run, changes, ws };
}

it("retains the named user when replacing a rejected password", async () => {
  const { connector } = setup();
  vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("eng").mockResolvedValueOnce("typo").mockResolvedValueOnce("correct");
  await connector.askPassword("PLC_1", "a user and a password");
  expect(await connector.askPassword("PLC_1", "did not take the password of eng")).toEqual({ RUNG_PLC_PASSWORD: "correct", RUNG_PLC_USER: "eng" });
  expect(await connector.passwordEnv("PLC_1")).toEqual({ RUNG_PLC_PASSWORD: "correct", RUNG_PLC_USER: "eng" });
});

it("compare retains certificate consent through password retries", async () => {
  const { cli, run, changes } = setup();
  vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Trust for This Connection" as never);
  vi.mocked(vscode.window.showInputBox).mockResolvedValue("correct");
  cli.capture.mockImplementation(async (args: string[], options: { env: Record<string, string> }) => {
    if (!args.includes("--trust-certificate")) return { code: 1, output: "TLS_UNTRUSTED" };
    if (!options.env.RUNG_PLC_PASSWORD) return { code: 1, output: "PASSWORD_REQUIRED" };
    return { code: 0, output: '{"identical":7,"items":[]}' };
  });
  await run();
  expect(changes.setComparison).toHaveBeenCalledWith("PLC_1", 7, []);
});

it("compare does not prompt for credentials after its final attempt", async () => {
  const { cli, run } = setup();
  cli.capture.mockResolvedValue({ code: 1, output: "PASSWORD_REQUIRED" });
  vi.mocked(vscode.window.showInputBox).mockResolvedValue("wrong");
  await run();
  expect(cli.capture).toHaveBeenCalledTimes(3);
  expect(vscode.window.showInputBox).toHaveBeenCalledTimes(2);
  expect(vscode.window.showErrorMessage).toHaveBeenCalled();
});

it("compare requests fresh TLS consent after choosing another connection", async () => {
  const { cli, run, connector } = setup();
  vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Trust for This Connection" as never);
  vi.spyOn(connector, "choose").mockResolvedValue({ mode: "PN/IE", pcInterface: "USB-LAN" });
  cli.capture
    .mockResolvedValueOnce({ code: 1, output: "TLS_UNTRUSTED first" })
    .mockResolvedValueOnce({ code: 1, output: "rung: NO_TARGET: 2 ways to reach PLC_1" })
    .mockResolvedValueOnce({ code: 1, output: "TLS_UNTRUSTED second" })
    .mockResolvedValueOnce({ code: 0, output: '{"identical":7,"items":[]}' });
  await run();
  expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
  expect(cli.capture.mock.calls.map(([args]) => args.includes("--trust-certificate"))).toEqual([false, true, false, true]);
});
