// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MonitorProvider, MonitorValues } from "../src/monitor.js";
import { Monitoring, MONITOR_COMMAND, STOP_MONITOR_COMMAND } from "../src/monitor.js";
import { WorkspaceIndex } from "../src/workspace.js";
import { lineText } from "../src/monitorText.js";
import { lineText as vscodeLineText } from "../../../editors/vscode/src/core/monitorText.js";
import { monitorServer, SOURCE, until } from "./monitorHarness.js";

const servers: Awaited<ReturnType<typeof monitorServer>>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.dispose(); });
const boot = async (provider: MonitorProvider, refreshSupport = true) => {
  const server = await monitorServer(provider, { refreshSupport });
  servers.push(server);
  return server;
};

function fake() {
  let latest: MonitorValues = { values: { count: 12, flag: true }, errors: {} };
  const close = vi.fn(async () => {});
  const read = vi.fn(async () => latest);
  const provider: MonitorProvider = {
    plan: (_index, _uri, instance) => ({ block: "Motor", instance, vars: { count: "count", flag: "flag" }, lines: { 2: ["count"], 6: ["#count", "flag"] } }),
    instances: () => ["Motor1_DB", "Motor2_DB"],
    open: vi.fn(async () => ({ read, close })),
  };
  return { provider, read, close, set: (values: MonitorValues) => { latest = values; } };
}

const start = async (server: Awaited<ReturnType<typeof monitorServer>>) => {
  const actions = await server.actions();
  await server.execute(actions.find((action) => action.command?.command === MONITOR_COMMAND)!);
};

describe("monitoring through LSP", () => {
  it("refreshes pushed snapshots without polling and disposes the subscription", async () => {
    const f = fake();
    let push!: (frame: MonitorValues) => void;
    const unsubscribe = vi.fn();
    f.provider.open = async () => ({ read: f.read, close: f.close, subscribe: (cb: (frame: MonitorValues) => void) => { push = cb; return unsubscribe; } });
    const s = await boot(f.provider);
    await start(s);
    push({ values: { count: 0, flag: true }, errors: {}, display: { count: "0.0" } });
    await until(() => s.refreshes.length > 0);
    expect((await s.hints())[0]!.label).toBe("count = 0.0");
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(f.read).not.toHaveBeenCalled();
    await s.execute((await s.actions())[0]!);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    push({ values: { count: 99 }, errors: {} });
    expect(await s.hints()).toEqual([]);
  });
  it("is off for an editor that monitors itself (rung's VS Code extension)", async () => {
    const f = fake();
    const s = await monitorServer(f.provider, { initializationOptions: { monitor: false } });
    servers.push(s);
    expect(s.init.capabilities.inlayHintProvider).toBe(false);
    expect(s.init.capabilities.executeCommandProvider.commands).not.toContain(MONITOR_COMMAND);
    expect((await s.actions()).filter((a) => a.command?.command === MONITOR_COMMAND)).toEqual([]);
  });

  it("offers instance choices and returns values and read errors at line ends", async () => {
    const f = fake();
    f.set({ values: { count: 12, "#count": 12 }, errors: { flag: "not readable" } });
    const s = await boot(f.provider);
    expect(s.init.capabilities.inlayHintProvider).toBe(true);
    expect(s.init.capabilities.executeCommandProvider.commands).toEqual(expect.arrayContaining([MONITOR_COMMAND, STOP_MONITOR_COMMAND]));
    expect((await s.actions()).map((a) => a.title)).toEqual(['Monitor values through "Motor1_DB"', 'Monitor values through "Motor2_DB"']);
    const action = (await s.actions())[1]!;
    await s.execute(action);
    expect(f.provider.open).toHaveBeenCalledWith(s.uri, expect.objectContaining({ instance: "Motor2_DB" }));
    expect(await s.hints()).toEqual([
      { position: { line: 2, character: SOURCE.split("\n")[2]!.length }, label: "count = 12", paddingLeft: true },
      { position: { line: 6, character: SOURCE.split("\n")[6]!.length }, label: "count = 12   flag = ?", paddingLeft: true },
    ]);
    expect((await s.actions()).map((a) => a.title)).toEqual(["Stop monitoring"]);
    expect(await s.hints(s.uri, { start: { line: 3, character: 0 }, end: { line: 6, character: 100 } })).toHaveLength(1);
    expect(await s.hints("file:///other.scl")).toEqual([]);
  });

  it("reads again after 500 ms and refreshes when values change", async () => {
    const f = fake();
    const s = await boot(f.provider);
    await start(s);
    await until(() => s.refreshes.length === 1);
    f.set({ values: { count: 42, "#count": 42, flag: false }, errors: {} });
    await until(() => s.refreshes.length === 2);
    expect((await s.hints())[1]!.label).toBe("count = 42   flag = FALSE");
    expect(s.refreshes[1]! - s.refreshes[0]!).toBeGreaterThanOrEqual(450);
  });

  it("does not request refresh from a client without refresh support", async () => {
    const f = fake();
    const s = await boot(f.provider, false);
    await start(s);
    await until(() => f.read.mock.calls.length === 2);
    expect(s.refreshes).toEqual([]);
    expect(await s.hints()).toHaveLength(2);
  });

  it.each(["edit", "close", "command", "shutdown"])("stops on %s and clears hints", async (reason) => {
    const f = fake();
    const s = await boot(f.provider);
    await start(s);
    if (reason === "edit") await s.client.sendNotification("textDocument/didChange", { textDocument: { uri: s.uri, version: 2 }, contentChanges: [{ text: SOURCE + "\n" }] });
    if (reason === "close") await s.client.sendNotification("textDocument/didClose", { textDocument: { uri: s.uri } });
    if (reason === "command") await s.execute((await s.actions())[0]!);
    if (reason === "shutdown") await s.client.sendRequest("shutdown");
    await until(() => f.close.mock.calls.length === 1);
    expect(await s.hints()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it("starting another block closes the first reader", async () => {
    const f = fake();
    const s = await boot(f.provider);
    await start(s);
    const other = s.uri.replace("Motor.scl", "Other.scl");
    await s.open(other);
    await s.execute((await s.actions(other))[0]!);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(await s.hints()).toEqual([]);
    expect(await s.hints(other)).toHaveLength(2);
  });

  it.each(["open", "read"])("a failing %s reports once and starts nothing", async (phase) => {
    const f = fake();
    if (phase === "open") f.provider.open = async () => { throw new Error("no [live.webapi] in rung.toml"); };
    else f.read.mockRejectedValue(new Error("the PLC refused the connection (web server off?)"));
    const s = await boot(f.provider);
    await start(s);
    await until(() => s.messages.length === 1);
    expect(s.messages[0]!.message).toMatch(/no \[live.webapi\]|the PLC refused/);
    expect(await s.hints()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(s.messages).toHaveLength(1);
    expect(f.close).toHaveBeenCalledTimes(phase === "open" ? 0 : 1);
  });

  it("a lost connection closes the reader and reports once", async () => {
    const f = fake();
    const s = await boot(f.provider);
    await start(s);
    f.read.mockRejectedValue(new Error("the PLC did not answer in time"));
    await until(() => s.messages.length === 1);
    expect(s.messages[0]!.message).toBe("the PLC did not answer in time");
    expect(await s.hints()).toEqual([]);
    expect(f.close).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(s.messages).toHaveLength(1);
  });

  it("an edit during a pending start closes its reader without publishing stale values", async () => {
    const f = fake();
    let opened!: (reader: Awaited<ReturnType<MonitorProvider["open"]>>) => void;
    f.provider.open = vi.fn(() => new Promise((resolve) => { opened = resolve; }));
    const s = await boot(f.provider);
    const pending = s.execute((await s.actions())[0]!);
    await until(() => !!opened);
    await s.client.sendNotification("textDocument/didChange", { textDocument: { uri: s.uri, version: 2 }, contentChanges: [{ text: SOURCE + "\n" }] });
    await s.hints();
    opened({ read: f.read, close: f.close });
    await pending;
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.read).not.toHaveBeenCalled();
    expect(await s.hints()).toEqual([]);
    expect(s.messages).toEqual([]);
  });

  it.each(["open", "read"])("shutdown answers only once a pending %s has settled and the PLC session is closed", async (phase) => {
    const f = fake();
    let settle!: () => void;
    let closed = false;
    f.close.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); closed = true; });
    if (phase === "open") f.provider.open = vi.fn(() => new Promise((resolve) => { settle = () => resolve({ read: f.read, close: f.close }); }));
    else f.read.mockImplementation(() => new Promise((resolve) => { settle = () => resolve({ values: {}, errors: {} }); }));
    const s = await boot(f.provider);
    void s.execute((await s.actions())[0]!).catch(() => {});
    await until(() => !!settle);
    let answered = false;
    const shutdown = s.client.sendRequest("shutdown").then(() => { answered = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);
    settle();
    await shutdown;
    expect(closed).toBe(true);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("waiting for the PLC session to close gives up after a while", async () => {
    const f = fake();
    f.read.mockImplementation(() => new Promise(() => {}));
    const monitoring = new Monitoring(new WorkspaceIndex(), f.provider, () => {}, () => {});
    void monitoring.start("file:///x/Motor.scl");
    await until(() => f.read.mock.calls.length === 1);
    monitoring.stop();
    const started = Date.now();
    await monitoring.closed(50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(f.close).not.toHaveBeenCalled();
  });

  it("offers Monitor values for a single instance", async () => {
    const f = fake();
    f.provider.instances = () => ["Motor1_DB"];
    const s = await boot(f.provider);
    expect((await s.actions()).map((action) => action.title)).toEqual(["Monitor values"]);
  });

  it("discards a pending read after stopping and closes after the read settles", async () => {
    const f = fake();
    let finish!: (values: MonitorValues) => void;
    f.read.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const s = await boot(f.provider);
    const pending = s.execute((await s.actions())[0]!);
    await until(() => !!finish);
    await s.client.sendRequest("workspace/executeCommand", { command: STOP_MONITOR_COMMAND, arguments: [s.uri] });
    expect(f.close).not.toHaveBeenCalled();
    finish({ values: { count: 999 }, errors: {} });
    await pending;
    await until(() => f.close.mock.calls.length === 1);
    expect(await s.hints()).toEqual([]);
    expect(s.messages).toEqual([]);
  });

  it("a block without values has no action and cannot start", async () => {
    const f = fake();
    f.provider.instances = () => [];
    f.provider.plan = () => ({ block: "Motor", vars: {}, lines: {} });
    const s = await boot(f.provider);
    expect(await s.actions()).toEqual([]);
    await s.client.sendRequest("workspace/executeCommand", { command: MONITOR_COMMAND, arguments: [s.uri] });
    await until(() => s.messages.length === 1);
    expect(s.messages[0]!.message).toBe("this block has no values to monitor");
    expect(f.provider.open).not.toHaveBeenCalled();
    expect(await s.hints()).toEqual([]);
  });

  it("uses the VS Code formatter for booleans, reals, strings, missing values and errors", () => {
    const labels = ["#flag", "real", "text", "missing", "failed", "object"];
    const values = { "#flag": true, real: 1.23456789, text: "motor", object: { count: 1 } };
    const errors = { failed: "not found" };
    expect(lineText(labels, values, errors)).toBe(vscodeLineText(labels, values, errors));
    expect(lineText(labels, values, errors)).toBe(`flag = TRUE   real = 1.23457   text = 'motor'   missing = …   failed = ?   object = {"count":1}`);
  });
});
