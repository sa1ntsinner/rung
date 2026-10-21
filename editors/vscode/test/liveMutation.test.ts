// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { mutateLive } from "../src/liveMutation";
import { parseRungToml } from "../src/core/rungToml";
vi.mock("vscode", () => ({ window: { showInputBox: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn() } }));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../src/runner/terminal", () => ({ killTree: vi.fn() }));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(["modify", "run", "stop"] as const)("blocks direct live %s commands before spawning under the environment lock", async action => {
  vi.stubEnv("RUNG_READ_ONLY", "1");
  const access = { scope: "fixture", select: async () => ({ device: "A", target: { transport: "s7commplus" }, workspace: "fixture" }), environment: vi.fn() };
  const cli = { invocation: vi.fn() };
  await mutateLive({ root: "C:/fixture" } as never, cli as never, access as never, action, "Start", "TRUE", "A");
  expect(spawn).not.toHaveBeenCalled();
  expect(cli.invocation).not.toHaveBeenCalled();
  expect(access.environment).not.toHaveBeenCalled();
  expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("RUNG_READ_ONLY=1"));
});

it.each([false, true])("blocks PLC-locked modify, including simulator=%s", async simulator => {
  vi.stubEnv("RUNG_READ_ONLY", "0");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const ws = { root: "C:/fixture", config: parseRungToml('[live.plc.A]\ntransport="webapi"\naddress="192.0.2.1"\nread_only=true') };
  const access = { scope: "fixture", select: async () => ({ device: "A", target: { transport: "webapi" }, workspace: "fixture", ...(simulator ? { simulator: "http://127.0.0.1:1234" } : {}) }) };
  await mutateLive(ws as never, {} as never, access as never, "modify", "Start", "TRUE", "A");
  expect(fetch).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("A"));
  vi.unstubAllGlobals();
});

it("cancels a live confirmation if read-only is enabled while the dialog is open", async () => {
  vi.stubEnv("RUNG_READ_ONLY", "0");
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, stdin: { destroyed: false, on: vi.fn(), end: vi.fn() } });
  const operation = { operationId: "one", preview: "fixture STOP", expiresAt: Date.now() + 30_000 };
  let reply: any;
  child.stdin.end.mockImplementation(text => { reply = JSON.parse(text); setTimeout(() => child.emit("close", 1), 0); });
  vi.mocked(spawn).mockImplementation(() => { setTimeout(() => child.stdout.emit("data", Buffer.from(JSON.stringify({ prepared: operation }) + "\n")), 0); return child as never; });
  vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => { vi.stubEnv("RUNG_READ_ONLY", "1"); return "STOP A" as never; });
  const ws = { root: "C:/fixture", reload: async () => {}, onDidChange: () => ({ dispose() {} }) };
  const access = { scope: "fixture", select: async () => ({ device: "A", target: { transport: "s7commplus" }, workspace: "fixture" }), environment: async () => ({}) };
  await mutateLive(ws as never, { invocation: () => ({ file: "fixture", args: [] }) } as never, access as never, "stop");
  expect(reply.confirmed).toBe(false);
});

it("blocks simulator RPC if read-only is enabled while the value prompt is open", async () => {
  vi.stubEnv("RUNG_READ_ONLY", "0");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  vi.mocked(vscode.window.showInputBox).mockImplementation(async () => { vi.stubEnv("RUNG_READ_ONLY", "1"); return "TRUE"; });
  const ws = { root: "C:/fixture", reload: async () => {} };
  const access = { scope: "fixture", select: async () => ({ device: "A", target: { transport: "webapi" }, workspace: "fixture", simulator: "http://127.0.0.1:1234" }) };
  await mutateLive(ws as never, {} as never, access as never, "modify", "Start", "TRUE");
  expect(fetch).not.toHaveBeenCalled();
});

it("shows the host's exact preview and cancels an editor confirmation after retargeting", async () => {
  for (const retarget of [false, true]) {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, stdin: { destroyed: false, on: vi.fn(), end: vi.fn() } });
    const operation = { operationId: "one", preview: "A · RungProve · 192.168.250.1\nSTOP\nObserved: RUN", expiresAt: Date.now() + 30_000 };
    let reply: any;
    child.stdin.end.mockImplementation(text => { reply = JSON.parse(text); setTimeout(() => child.emit("close", reply.confirmed ? 0 : 1), 0); });
    vi.mocked(spawn).mockImplementation(() => { setTimeout(() => child.stdout.emit("data", Buffer.from(JSON.stringify({ prepared: operation }) + "\n")), 0); return child as never; });
    const access = { scope: "original", select: async () => ({ device: "A", target: { transport: "s7commplus" }, workspace: "original" }), environment: async () => ({ RUNG_PLC_PASSWORD: "secret" }) };
    vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => { if (retarget) access.scope = "changed"; return "STOP A" as never; });
    const ws = { root: "C:/fixture", reload: async () => {}, onDidChange: () => ({ dispose() {} }) };
    const cli = { invocation: vi.fn(() => ({ file: "node", args: ["cli.js"], shell: false })) };
    await mutateLive(ws as never, cli as never, access as never, "stop", undefined, undefined, "A");
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("Put A in STOP?", { modal: true, detail: operation.preview }, "STOP A");
    expect(reply).toEqual({ operationId: "one", preview: operation.preview, confirmed: !retarget });
    expect(cli.invocation.mock.calls[0]?.[0]).not.toContain("secret");
  }
});

it("starts a confirmed live change without the markers an agent sets, keeping the rest of the environment", async () => {
  vi.stubEnv("RUNG_READ_ONLY", "0");
  vi.stubEnv("CLAUDECODE", "1");
  vi.stubEnv("CURSOR_TRACE_ID", "x");
  vi.stubEnv("RUNG_FIXTURE_KEEP", "kept");
  vi.mocked(spawn).mockClear();
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, stdin: { destroyed: false, on: vi.fn(), end: vi.fn() } });
  const operation = { operationId: "one", preview: "fixture STOP", expiresAt: Date.now() + 30_000 };
  child.stdin.end.mockImplementation(() => { setTimeout(() => child.emit("close", 1), 0); });
  vi.mocked(spawn).mockImplementation(() => { setTimeout(() => child.stdout.emit("data", Buffer.from(JSON.stringify({ prepared: operation }) + "\n")), 0); return child as never; });
  vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => "Cancel" as never);
  const ws = { root: "C:/fixture", reload: async () => {}, onDidChange: () => ({ dispose() {} }) };
  const access = { scope: "fixture", select: async () => ({ device: "A", target: { transport: "s7commplus" }, workspace: "fixture" }), environment: async () => ({}) };
  await mutateLive(ws as never, { invocation: () => ({ file: "fixture", args: [] }) } as never, access as never, "stop");
  const env = (vi.mocked(spawn).mock.calls[0]![2] as { env: Record<string, string | undefined> }).env;
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.CURSOR_TRACE_ID).toBeUndefined();
  expect(env.RUNG_FIXTURE_KEEP).toBe("kept");
  vi.unstubAllEnvs();
});
