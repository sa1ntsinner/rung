// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { LiveView } from "../src/views/liveView";
import { stopLive } from "../src/runner/terminal";

const fake = vi.hoisted(() => ({ commands: new Map<string, (...args: unknown[]) => unknown>(), view: undefined as any, children: [] as any[] }));
vi.mock("vscode", () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
  TreeItemCollapsibleState: { Expanded: 2 },
  ThemeIcon: class {}, ThemeColor: class {},
  window: { createTreeView: () => (fake.view = { visible: true, onDidChangeVisibility(callback: () => void) { this.changed = callback; return { dispose() {} }; }, changed() {}, dispose() {} }) },
  commands: { registerCommand: (name: string, action: (...args: unknown[]) => unknown) => { fake.commands.set(name, action); return { dispose() {} }; }, executeCommand() {} },
}));
vi.mock("../src/runner/terminal", () => ({ stopLive: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return { spawn: () => { const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }); fake.children.push(child); return child; } };
});
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

it("refreshes age labels only for stale values, without delaying live notification rendering", () => {
  vi.useFakeTimers();
  const view = new LiveView({ onDidChange: () => ({ dispose() {} }) } as never, {} as never,
    { get: (key: string, fallback: unknown) => key === "rung.liveValues" ? ["x"] : fallback } as never, undefined, { scope: "A" } as never);
  try {
    view.seen.set("x", { value: 1, at: Date.now(), history: [], state: "live" });
    const refresh = vi.spyOn((view as any).changed, "fire");
    vi.advanceTimersByTime(1000); expect(refresh).not.toHaveBeenCalled();
    view.seen.get("x")!.state = "stale";
    vi.advanceTimersByTime(1000); expect(refresh).toHaveBeenCalledOnce();
  } finally { view.dispose(); vi.useRealTimers(); }
});

it("shows watch tables as groups with duplicate rows and keeps draft modify values read-only", async () => {
  const invocation = vi.fn(() => ({ file: "rung", args: [] }));
  const access = { scope: "A", select: async (device: string) => ({ device, target: { transport: "s7commplus", address: "192.168.250.1" }, workspace: "A" }), environment: async () => ({}) };
  const view = new LiveView({ root: "/w", onDidChange: () => ({ dispose() {} }) } as never, { invocation } as never, { get: (_key: string, value: unknown) => value, update() {} } as never, undefined, access as never);
  try {
    await fake.commands.get("rung.live.table")!("plc/P/watch/Watch.xml"); await settle();
    expect(invocation.mock.calls[0]?.[0]).toContain("--table");
    const child = fake.children.at(-1);
    child.stdout.emit("data", Buffer.from(JSON.stringify({ plan: { table: { name: "Watch", rows: [
      { key: "row:1", name: '"DB".x', comments: { "en-US": "Row one" }, modifyValue: "17" },
      { key: "row:2", name: '"DB".x', comments: {} },
    ] }, errors: {} } }) + "\n"));
    const group = view.getChildren()[0]!;
    expect(view.getTreeItem(group).label).toBe("Watch");
    expect(view.getChildren(group)).toEqual(["row:1", "row:2"]);
    expect(view.getTreeItem("row:1").label).toBe('"DB".x');
    expect(view.getTreeItem("row:1").tooltip).toContain("Row one");
    expect(invocation).toHaveBeenCalledTimes(1);
  } finally { view.dispose(); }
});

it("releases hidden and paused leases, accepts fresh session epochs and rejects late process events", async () => {
  let changed!: () => void, scope = "A";
  const access = { get scope() { return scope; }, select: async () => ({ device: scope, target: { transport: "s7commplus", address: "192.168.250.1" }, workspace: scope }), environment: async () => ({}) };
  const ws = { root: "/w", onDidChange: (callback: () => void) => { changed = callback; return { dispose() {} }; } };
  const view = new LiveView(ws as never, { invocation: () => ({ file: "rung", args: [] }) } as never, { get: (_key: string, value: unknown) => value, update() {} } as never, undefined, access as never);
  const push = (child: EventEmitter & { stdout: EventEmitter }, value: number, epoch: number) => child.stdout.emit("data", Buffer.from(JSON.stringify({ at: value, values: { x: value }, observedAt: { x: value }, state: "live", scope: { device: scope, address: "192.168.250.1", transport: "s7commplus", epoch } }) + "\n"));
  try {
    await view.add("x"); await settle();
    const first = fake.children.at(-1);
    push(first, 10, 2);
    expect(view.seen.get("x")?.value).toBe(10);
    fake.commands.get("rung.live.pause")!();
    expect(stopLive).toHaveBeenCalledWith(first);
    fake.commands.get("rung.live.resume")!(); await settle();
    const second = fake.children.at(-1);
    push(second, 20, 1);
    expect(view.seen.get("x")?.value).toBe(20);
    push(first, 99, 3);
    expect(view.seen.get("x")?.value).toBe(20);
    fake.view.visible = false; fake.view.changed();
    expect(stopLive).toHaveBeenCalledWith(second);
    scope = "B"; changed();
    expect(view.seen.size).toBe(0);
    expect(view.recorder.frames).toHaveLength(0);
  } finally { view.dispose(); }
});
