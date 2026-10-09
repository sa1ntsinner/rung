// SPDX-License-Identifier: MIT
import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { mutateLive } from "../src/liveMutation";
vi.mock("vscode", () => ({ window: { showInputBox: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn() } }));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../src/runner/terminal", () => ({ killTree: vi.fn() }));

it("shows the host's exact preview and cancels an editor confirmation after retargeting", async () => {
  for (const retarget of [false, true]) {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, stdin: { destroyed: false, on: vi.fn(), end: vi.fn() } });
    const operation = { operationId: "one", preview: "A · RungProve · 192.168.250.1\nSTOP\nObserved: RUN", expiresAt: Date.now() + 30_000 };
    let reply: any;
    child.stdin.end.mockImplementation(text => { reply = JSON.parse(text); setTimeout(() => child.emit("close", reply.confirmed ? 0 : 1), 0); });
    vi.mocked(spawn).mockImplementation(() => { setTimeout(() => child.stdout.emit("data", Buffer.from(JSON.stringify({ prepared: operation }) + "\n")), 0); return child as never; });
    const access = { scope: "original", select: async () => ({ device: "A", target: { transport: "s7commplus" }, workspace: "original" }), environment: async () => ({ RUNG_PLC_PASSWORD: "secret" }) };
    vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => { if (retarget) access.scope = "changed"; return "Confirm" as never; });
    const ws = { root: "C:/fixture", reload: async () => {}, onDidChange: () => ({ dispose() {} }) };
    const cli = { invocation: vi.fn(() => ({ file: "node", args: ["cli.js"], shell: false })) };
    await mutateLive(ws as never, cli as never, access as never, "stop", undefined, undefined, "A");
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("Confirm stop on A?", { modal: true, detail: operation.preview }, "Confirm");
    expect(reply).toEqual({ operationId: "one", preview: operation.preview, confirmed: !retarget });
    expect(cli.invocation.mock.calls[0]?.[0]).not.toContain("secret");
  }
});
