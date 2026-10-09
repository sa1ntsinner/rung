// SPDX-License-Identifier: MIT
import { expect, it, vi } from "vitest";
import { Monitor } from "../src/monitor";

const fake = vi.hoisted(() => ({ documents: [] as any[], processes: [] as { take: (text: string) => void; end: (result: unknown) => void; env: unknown }[] }));
vi.mock("vscode", () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  ThemeColor: class {}, DecorationRangeBehavior: { ClosedClosed: 0 },
  window: { createTextEditorDecorationType: () => ({ dispose() {} }), onDidChangeVisibleTextEditors: () => ({ dispose() {} }), visibleTextEditors: [], showWarningMessage: vi.fn() },
  workspace: { textDocuments: fake.documents, onDidChangeTextDocument: () => ({ dispose() {} }), onDidCloseTextDocument: () => ({ dispose() {} }) },
  commands: { executeCommand: vi.fn() },
}));
vi.mock("../src/runner/terminal", () => ({ stopLive: vi.fn(), startProcess: (_inv: unknown, _cwd: unknown, take: (text: string) => void, env: unknown) => {
  let end!: (result: unknown) => void;
  const done = new Promise(resolve => { end = resolve; });
  fake.processes.push({ take, end, env });
  return { child: {}, done };
} }));
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
it("refuses a dirty buffer before requesting a PLC or credentials", async () => {
  const uri = { fsPath: "/w/Motor.scl", toString: () => "file:///w/Motor.scl" }, save = vi.fn();
  fake.documents.push({ uri, isDirty: true, save });
  const access = { select: vi.fn(async () => undefined) };
  const monitor = new Monitor({ rel: () => "plc/A/blocks/Motor.scl", onDidChange: () => ({ dispose() {} }) } as never, {} as never, {} as never, access as never);
  try {
    await monitor.toggle(uri as never);
    expect(save).not.toHaveBeenCalled();
    expect(access.select).not.toHaveBeenCalled();
  } finally { fake.documents.length = 0; monitor.dispose(); }
});

it("forwards native authentication details and rejects events from the previous block process", async () => {
  const access = { scope: "A", select: async () => ({ device: "A", workspace: "A" }), environment: vi.fn(async (_connection, ask, output) => ask && output.includes("AUTHENTICATION_REQUIRED") ? { RUNG_PLC_USER: "eng", RUNG_PLC_PASSWORD: "secret" } : {}) };
  const monitor = new Monitor({ root: "/w", rel: () => "plc/A/blocks/Motor.scl", onDidChange: () => ({ dispose() {} }) } as never, { invocation: () => ({ display: "rung live watch" }) } as never, { info() {} } as never, access as never);
  const uri = { fsPath: "/w/plc/A/blocks/Motor.scl", toString: () => "file:///w/plc/A/blocks/Motor.scl" };
  const starting = monitor.toggle(uri as never);
  try {
    await settle();
    const first = fake.processes.at(-1)!;
    first.end({ code: 1, output: "AUTHENTICATION_REQUIRED: a user and a password" });
    await settle();
    const second = fake.processes.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.env).toEqual({ RUNG_PLC_USER: "eng", RUNG_PLC_PASSWORD: "secret" });
    second.take('{"values":{"x":2}}\n');
    first.take('{"values":{"x":99}}\n');
    expect(monitor.values).toEqual({ x: 2 });
    await monitor.stop(); second.end({ code: 0, output: "" }); await starting;
  } finally { monitor.dispose(); }
});
