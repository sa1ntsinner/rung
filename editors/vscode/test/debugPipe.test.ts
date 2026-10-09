// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { registerDebug } from "../src/debug";
const fake = vi.hoisted(() => ({ factory: undefined as any, child: undefined as any }));
vi.mock("node:child_process", () => ({ spawn: () => fake.child }));
vi.mock("../src/runner/terminal", () => ({ killTree: vi.fn() }));
vi.mock("vscode", () => ({
  EventEmitter: class { event = vi.fn(); fire = vi.fn(); dispose() {} },
  DebugAdapterInlineImplementation: class { constructor(public adapter: any) {} },
  debug: { registerDebugAdapterDescriptorFactory: (_name: string, factory: any) => { fake.factory = factory; return {}; } },
  languages: { registerInlineValuesProvider: () => ({}) },
}));
it("handles a closed debug input pipe and drops late messages", () => {
  const stdin = Object.assign(new EventEmitter(), { write: vi.fn(), writable: true, destroyed: false });
  fake.child = Object.assign(new EventEmitter(), { stdin, stdout: new EventEmitter(), stderr: new EventEmitter() });
  registerDebug({ subscriptions: [] } as never, {} as never, { invocation: () => ({ file: "rung", args: [] }) } as never);
  const adapter = fake.factory.createDebugAdapterDescriptor().adapter;
  expect(() => stdin.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }))).not.toThrow();
  adapter.handleMessage({ type: "request", command: "disconnect" });
  expect(stdin.write).not.toHaveBeenCalled();
  adapter.dispose();
});
