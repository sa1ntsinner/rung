// SPDX-License-Identifier: MIT
import { expect, it, vi } from "vitest";

const started: { cwd: string; root?: string }[] = [];
vi.mock("vscode", () => ({ workspace: { createFileSystemWatcher: () => ({}) }, window: {}, commands: {} }));
vi.mock("vscode-languageclient/node", () => ({
  LanguageClient: class {
    constructor(_id: string, _name: string, server: { options: { cwd: string } }, client: { initializationOptions: { root?: string } }) {
      started.push({ cwd: server.options.cwd, root: client.initializationOptions.root });
    }
    async start() {}
    isRunning() { return true; }
    needsStop() { return true; }
    async stop() {}
    async dispose() {}
  },
}));
import { Lsp } from "../src/lsp";

it("restarts the language server on the folder chosen in a window of several", async () => {
  let listener = () => {};
  const ws = { root: "C:\\work\\line-a", onDidChange: (f: () => void) => ((listener = f), { dispose() {} }) };
  const cli = { invocation: () => ({ file: "rung", args: ["lsp", "--stdio"], display: "rung lsp --stdio" }) };
  const out = { channel: {}, debug() {}, show() {} };
  const lsp = new Lsp(ws as never, cli as never, out as never);
  await lsp.start();
  listener(); // something else changed: same folder, no restart
  ws.root = "C:\\work\\line-b";
  listener();
  await vi.waitFor(() => expect(started).toHaveLength(2));
  expect(started).toEqual([{ cwd: "C:\\work\\line-a", root: "C:\\work\\line-a" }, { cwd: "C:\\work\\line-b", root: "C:\\work\\line-b" }]);
  lsp.dispose();
});
