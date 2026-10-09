// SPDX-License-Identifier: MIT
import { expect, it, vi } from "vitest";
import { Monitor } from "../src/monitor";

const fake = vi.hoisted(() => ({ sourceChange: undefined as ((uri: any) => void) | undefined,
  documents: [] as any[], processes: [] as { take: (text: string) => void; end: (result: unknown) => void; env: unknown }[] }));
vi.mock("vscode", () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  ThemeColor: class {}, DecorationRangeBehavior: { ClosedClosed: 0 },
  window: { createTextEditorDecorationType: () => ({ dispose() {} }), onDidChangeVisibleTextEditors: () => ({ dispose() {} }), visibleTextEditors: [], showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
  workspace: { textDocuments: fake.documents, onDidChangeTextDocument: () => ({ dispose() {} }), onDidCloseTextDocument: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidChange: (cb: (uri: any) => void) => { fake.sourceChange = cb; return { dispose() {} }; },
      onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} }) },
  commands: { executeCommand: vi.fn() },
}));
vi.mock("../src/runner/terminal", () => ({ stopLive: vi.fn(), startProcess: (_inv: unknown, _cwd: unknown, take: (text: string) => void, env: unknown) => {
  let end!: (result: unknown) => void;
  const done = new Promise(resolve => { end = resolve; });
  fake.processes.push({ take, end, env });
  return { child: {}, done };
} }));
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
it("uses native recorded Why and drops stale epochs, dirty sources and closed dependencies", async () => {
  const access = { scope: "A", select: async () => ({ device: "A", workspace: "A" }), environment: async () => ({}) };
  const monitor = new Monitor({ root: "/w", rel: () => "plc/A/blocks/Motor.scl", onDidChange: () => ({ dispose() {} }) } as never,
    { invocation: () => ({ display: "rung live watch" }) } as never, { info() {} } as never, access as never);
  const uri = { fsPath: "/w/plc/A/blocks/Motor.scl", toString: () => "file:///w/plc/A/blocks/Motor.scl" };
  const tree = { kind: "value", text: "COUNT", value: "3", children: [] };
  const status = { kind: "reconstructed", exact: false, coherence: "subscription-sample", freshness: "native-sample", observedAt: 20, sequence: 1, trace: [], divergences: [],
    scope: { plc: "A", instance: '"Motor_DB"', epoch: 1 }, why: { COUNT: tree } };
  const starting = monitor.toggle(uri as never);
  await settle(); const process = fake.processes.at(-1)!;
  const send = (epoch: number, programStatus = status) => process.take(JSON.stringify({ values: { Count: 5 }, state: "live",
    scope: { device: "A", address: "192.168.250.1", transport: "s7commplus", epoch }, programStatus }) + "\n");
  try {
    send(1); const selected = monitor.captured!;
    expect(await selected.ask("#Count")).toEqual(tree); expect(monitor.values).toEqual({ Count: 5 });
    send(1); expect(monitor.captured?.identity).toBe(selected.identity); expect(await selected.ask("Count")).toEqual(tree);
    send(2); expect(monitor.captured).toBeUndefined(); expect(await selected.ask("Count")).toBeUndefined();
    fake.documents.push({ uri: { fsPath: "/w/Other.scl", toString: () => "file:///w/Other.scl" }, isDirty: true });
    send(2, { ...status, scope: { ...status.scope, epoch: 2 } }); expect(monitor.captured).toBeUndefined();
    fake.documents.length = 0; send(2, { ...status, scope: { ...status.scope, epoch: 2 } });
    const snapshot = monitor.captured!; fake.sourceChange?.({ fsPath: "/w/Dependency.scl" });
    expect(await snapshot.ask("Count")).toBeUndefined(); expect(monitor.monitoring).toBeUndefined();
  } finally { fake.documents.length = 0; await monitor.stop(); process.end({ code: 0, output: "" }); await starting; monitor.dispose(); }
});
it("routes Why through the historical capture and refuses an invalidated snapshot", async () => {
  const tree = { kind: "value", text: "Count", value: "5", children: [] };
  const capture = vi.fn(async () => ({ code: 0, output: JSON.stringify({ kind: "reconstructed", exact: false, freshness: "capture-only", trace: [], divergences: [], why: tree }) }));
  const monitor = new Monitor({ rel: () => "plc/A/blocks/Counter.scl", onDidChange: () => ({ dispose() {} }) } as never,
    { capture } as never, {} as never, { scope: "A" } as never);
  const uri = { fsPath: "/w/Counter.scl", toString: () => "file:///w/Counter.scl" };
  try {
    await monitor.reconstruct(uri as never, { fsPath: "/w/cycle.json" } as never, "Counter_DB");
    const selected = monitor.captured!;
    expect(await selected.ask("Count")).toEqual(tree);
    expect(capture.mock.calls[1]?.[0]).toContain("--why");
    const stale = monitor.captured!; fake.sourceChange?.({ fsPath: "/w/Dependency.scl" });
    expect(await stale.ask("Count")).toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(2);
  } finally { monitor.dispose(); }
});
it("clears reconstruction after a closed dependency changes on disk", async () => {
  fake.sourceChange = undefined;
  const monitor = new Monitor({ rel: () => "plc/A/blocks/Dependency.scl", onDidChange: () => ({ dispose() {} }) } as never,
    { capture: async () => ({ code: 0, output: JSON.stringify({ kind: "reconstructed", exact: false, freshness: "capture-only", trace: [], divergences: [] }) }) } as never,
    {} as never, { scope: "A" } as never);
  const uri = { fsPath: "/w/Motor.scl", toString: () => "file:///w/Motor.scl" };
  try {
    await monitor.reconstruct(uri as never, { fsPath: "/w/cycle.json" } as never, "Motor_DB");
    expect(monitor.monitoring).toBe(uri);
    fake.sourceChange?.({ fsPath: "/w/Dependency.scl" });
    expect(monitor.monitoring).toBeUndefined();
  } finally { monitor.dispose(); }
});
it("discards a captured reconstruction when the workspace changes during the CLI run", async () => {
  let change!: () => void, finish!: (result: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const capture = vi.fn(() => pending), access = { scope: "A", select: vi.fn() };
  const monitor = new Monitor({ rel: () => "plc/A/blocks/Motor.scl", onDidChange: (cb: () => void) => { change = cb; return { dispose() {} }; } } as never,
    { capture } as never, {} as never, access as never);
  const uri = { fsPath: "/w/Motor.scl", toString: () => "file:///w/Motor.scl" };
  try {
    const run = monitor.reconstruct(uri as never, { fsPath: "/w/cycle.json" } as never, "Motor_DB");
    await settle(); expect(capture).toHaveBeenCalledOnce(); access.scope = "B"; change();
    finish({ code: 0, output: JSON.stringify({ kind: "reconstructed", exact: false, freshness: "capture-only", trace: [], divergences: [] }) });
    await run;
    expect(monitor.monitoring).toBeUndefined(); expect(access.select).not.toHaveBeenCalled();
  } finally { monitor.dispose(); }
});
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
