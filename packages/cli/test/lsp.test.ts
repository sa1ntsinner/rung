// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultConfig, saveConfig } from "@rung/core";
import { WebApiClient } from "@rung/live";
import { WorkspaceIndex } from "@rung/lsp";
import { monitorServer, until } from "../../lsp/test/monitorHarness.js";
import { main } from "../src/main.js";
import * as lsp from "../src/lsp.js";
import type { Io } from "../src/common.js";

const servers: Awaited<ReturnType<typeof monitorServer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.dispose();
  vi.restoreAllMocks();
});
const io: Io = { cwd: ".", env: { RUNG_WEBAPI_PASSWORD: "secret" }, stdout: () => {}, stderr: () => {} };

async function boot(options: { url?: string; password?: boolean; webapi?: boolean } = {}) {
  const server = await monitorServer(undefined, {
    start: (reader, writer) => lsp.startLsp({ ...io, env: options.password === false ? {} : io.env }, reader, writer),
    setup: async (root) => {
      const config = defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]);
      if (options.webapi !== false) config.live = { webapi: { url: options.url ?? "https://plc.example", user: "reader" } };
      await saveConfig(root, config);
      for (const name of ["Motor1_DB", "Motor2_DB"])
        await writeFile(join(root, "plc", "PLC_1", "blocks", name + ".db"), 'DATA_BLOCK "' + name + '"\n"Motor"\nBEGIN\nEND_DATA_BLOCK\n');
    },
  });
  servers.push(server);
  return server;
}

describe("rung lsp monitoring wiring", () => {
  it("the lsp command injects the monitoring entry point with its environment", async () => {
    const started = vi.spyOn(lsp, "startLsp").mockImplementation(() => { throw new Error("started"); });
    await expect(main(["lsp", "--stdio"], io)).rejects.toThrow("started");
    expect(started).toHaveBeenCalledWith(io);
  });

  it("real plans and a fake Web API reader reach line-end hints without network access", async () => {
    const read = vi.spyOn(WebApiClient.prototype, "read").mockImplementation(async (names) => names.map((name) => ({ name, value: name.endsWith("flag") ? true : 7 })));
    const logout = vi.spyOn(WebApiClient.prototype, "logout").mockResolvedValue(undefined);
    const s = await boot();
    const actions = await s.actions();
    expect(actions.map((action) => action.title)).toEqual(['Monitor values through "Motor1_DB"', 'Monitor values through "Motor2_DB"']);
    await s.execute(actions[1]!);
    expect(read).toHaveBeenCalledWith(['"Motor2_DB".count', '"Motor2_DB".flag', '"Motor2_DB".count']);
    expect((await s.hints()).map((hint) => ({ line: hint.position.line, label: hint.label }))).toEqual([
      { line: 2, label: "count = 7" }, { line: 3, label: "flag = TRUE" }, { line: 6, label: "count = 7" },
    ]);
    await s.execute((await s.actions())[0]!);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(await s.hints()).toEqual([]);
  });

  it.each([
    [{ webapi: false }, /no \[live.webapi\] in rung.toml/],
    [{ password: false }, /set RUNG_WEBAPI_PASSWORD/],
    [{ url: "http://192.168.0.1" }, /http/i],
  ] as const)("preserves the live reader's configuration refusals: %j", async (options, message) => {
    const read = vi.spyOn(WebApiClient.prototype, "read");
    const s = await boot(options);
    await s.execute((await s.actions())[0]!);
    await until(() => s.messages.length === 1);
    expect(s.messages[0]!.message).toMatch(message);
    expect(read).not.toHaveBeenCalled();
    expect(await s.hints()).toEqual([]);
  });

  it("preserves the live command's unreachable PLC wording", async () => {
    vi.spyOn(WebApiClient.prototype, "read").mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    const logout = vi.spyOn(WebApiClient.prototype, "logout").mockResolvedValue(undefined);
    const s = await boot();
    await s.execute((await s.actions())[0]!);
    await until(() => s.messages.length === 1);
    expect(s.messages[0]!.message).toBe("the PLC refused the connection (web server off?) (ECONNREFUSED)");
    expect(logout).toHaveBeenCalledTimes(1);
    expect(await s.hints()).toEqual([]);
  });

  it("a single instance offers Monitor values and an IEC plan uses PROGRAM instance paths", async () => {
    const index = new WorkspaceIndex();
    const uri = "file:///w/plc/PLC_1/blocks/Count.st";
    index.set(uri, "FUNCTION_BLOCK Count\nVAR\n  n : INT;\nEND_VAR\nn := n + 1;\nEND_FUNCTION_BLOCK\n", 0);
    index.set("file:///w/plc/PLC_1/blocks/PLC_PRG.st", "PROGRAM PLC_PRG\nVAR\n  counter : Count;\nEND_VAR\nEND_PROGRAM\n", 0);
    const read = vi.fn(async (names: string[]) => names.map((name) => ({ name, value: 9 })));
    const close = vi.fn(async () => {});
    const provider = lsp.lspMonitor(io, async () => ({ read, close }));
    expect(provider.instances(index, uri)).toEqual(["PLC_PRG.counter"]);
    const plan = provider.plan(index, uri);
    expect(plan.lines).toEqual({ 2: ["n"], 4: ["n"] });
    const reader = await provider.open(uri, plan);
    expect(await reader.read()).toEqual({ values: { n: 9 }, errors: {} });
    expect(read).toHaveBeenCalledWith(["PLC_PRG.counter.n"]);
    await reader.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("rung lsp rename wiring", () => {
  it("renames the object of a workspace file through rung rename and hands back its new file", async () => {
    const root = (await boot()).root;
    await mkdir(join(root, ".rung"), { recursive: true });
    await writeFile(join(root, ".rung", "state.json"), JSON.stringify({ objects: { m: { address: "plc:PLC_1/blocks/Motor", path: "plc/PLC_1/blocks/Motor.scl" } } }));
    const calls: unknown[][] = [];
    const renamer = lsp.lspRenamer(io, async (ws, address, newName) => {
      calls.push([ws, address, newName]);
      return { from: address, to: "plc:PLC_1/blocks/Drive", oldPath: "plc/PLC_1/blocks/Motor.scl", newPath: "plc/PLC_1/blocks/Drive.scl", users: ["plc/PLC_1/blocks/Line.scl"], pull: {} as never };
    });
    const done = await renamer.rename(pathToFileURL(join(root, "plc", "PLC_1", "blocks", "Motor.scl")).href, "Drive");
    expect(calls).toEqual([[root, "plc:PLC_1/blocks/Motor", "Drive"]]);
    expect(done).toEqual({ newUri: pathToFileURL(join(root, "plc", "PLC_1", "blocks", "Drive.scl")).href, users: 1 });
  });
});
