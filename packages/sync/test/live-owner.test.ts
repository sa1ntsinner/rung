// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { OwnerServer, OwnerClient } from "../src/owner.js";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const servers: OwnerServer[] = [];
const clients: OwnerClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
});
const root = () => mkdtempSync(join(tmpdir(), "rung-live-owner-"));
it.skipIf(process.platform === "win32").each([undefined, "live"])("reclaims the Unix socket after owner death (%s)", async service => {
  const path = root();
  const module = pathToFileURL(join(process.cwd(), "packages/sync/dist/owner.js")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { OwnerServer } from ${JSON.stringify(module)};
    await OwnerServer.start(${JSON.stringify(path)}, {}, { service: ${JSON.stringify(service)} });
    console.log('ready'); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", code => reject(new Error(`fixture exited ${code}`))); });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await exited;
    const replacement = await OwnerServer.start(path, { who: async () => "replacement" }, { service });
    servers.push(replacement);
    expect(await (await connect(path, service)).request("who")).toBe("replacement");
  } finally { child.kill(); }
});
const connect = async (path: string, service?: string) => {
  const client = (await OwnerClient.connect(path, { service }))!;
  clients.push(client);
  return client;
};

it("rejects null JSON and oversized complete frames without invoking handlers", async () => {
  const path = root();
  let calls = 0;
  const server = await OwnerServer.start(path, { echo: async () => { calls++; return {}; } }, { service: "live" });
  servers.push(server);
  for (const payload of ["null\n", JSON.stringify({ id: 1, token: server.info.token, method: "echo", params: { padding: "x".repeat(16 * 1024 * 1024) } }) + "\n"]) {
    const socket = createConnection(server.info.pipe);
    socket.on("error", () => {});
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    socket.write(payload);
    await closed;
  }
  expect(calls).toBe(0);
});

it("closing a client releases its lease even when outgoing events are blocked", async () => {
  const path = root();
  const gone: string[] = [];
  const server = await OwnerServer.start(path, { id: async (_params, context) => context.clientId }, { service: "live", onDisconnect: id => { gone.push(id); } });
  servers.push(server);
  const client = await connect(path, "live");
  const id = await client.request<string>("id");
  const socket = (client as unknown as { sock: Socket }).sock;
  socket.pause();
  server.emitTo(id, "values", { padding: "x".repeat(8 * 1024 * 1024) });
  client.close();
  try { await expect.poll(() => gone, { timeout: 1000 }).toContain(id); }
  finally { socket.destroy(); }
});

it("keeps live and sync owners independent and rejects a competing live owner", async () => {
  const path = root();
  servers.push(await OwnerServer.start(path, { who: async () => "sync" }));
  servers.push(await OwnerServer.start(path, { who: async () => "live" }, { service: "live" }));
  expect(await (await connect(path)).request("who")).toBe("sync");
  expect(await (await connect(path, "live")).request("who")).toBe("live");
  expect(existsSync(join(path, ".rung", "live-owner.json"))).toBe(true);
  await expect(OwnerServer.start(path, {}, { service: "live" })).rejects.toBeDefined();
  expect(await (await connect(path, "live")).request("who")).toBe("live");
});

it("targets only the requesting client and releases a lease on socket close", async () => {
  const path = root();
  const gone: string[] = [];
  servers.push(await OwnerServer.start(path, { id: async (_params, context) => context.clientId }, {
    service: "live", onDisconnect: (id) => { gone.push(id); },
  }));
  const a = await connect(path, "live");
  const b = await connect(path, "live");
  const aId = await a.request<string>("id");
  const bId = await b.request<string>("id");
  expect(aId).not.toBe(bId);
  const aEvents: unknown[] = [], bEvents: unknown[] = [];
  await a.subscribe((_event, params) => aEvents.push(params));
  await b.subscribe((_event, params) => bEvents.push(params));
  servers[0]!.emitTo(aId, "online.values", { value: 7 });
  await expect.poll(() => aEvents).toEqual([{ value: 7 }]);
  expect(bEvents).toEqual([]);
  a.close();
  await expect.poll(() => gone).toContain(aId);
});

it("closes request-only clients and rejects requests after close", async () => {
  const path = root();
  const server = await OwnerServer.start(path, { id: async (_params, context) => context.clientId }, { service: "live" });
  const client = await connect(path, "live");
  await client.request("id");
  await server.close();
  await expect(client.request("id")).rejects.toMatchObject({ code: "OWNER_GONE" });
});

it("rejects service names containing path separators", async () => {
  await expect(OwnerServer.start(root(), {}, { service: "../escape" })).rejects.toThrow("service");
});

it("elects exactly one owner when startup attempts race", async () => {
  const path = root();
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => OwnerServer.start(path, { who: async () => "winner" }, { service: "live" })));
  const winners = attempts.filter((result) => result.status === "fulfilled");
  for (const result of winners) if (result.status === "fulfilled") servers.push(result.value);
  expect(winners).toHaveLength(1);
  expect(await (await connect(path, "live")).request("who")).toBe("winner");
});

it("coalesces large value bursts to the latest complete frame for each subscription", async () => {
  const path = root();
  const server = await OwnerServer.start(path, { id: async (_params, context) => context.clientId }, { service: "live" });
  servers.push(server);
  const client = await connect(path, "live");
  const id = await client.request<string>("id");
  const frames: { subscriptionId: string; seq: number }[] = [];
  await client.subscribe((_event, params) => frames.push(params as { subscriptionId: string; seq: number }));
  const padding = "x".repeat(512 * 1024);
  for (let seq = 0; seq < 100; seq++) server.emitTo(id, "online.values", { subscriptionId: "a", seq, values: { padding } });
  server.emitTo(id, "online.values", { subscriptionId: "b", seq: 42, values: { padding } });
  await expect.poll(() => frames.map(({ subscriptionId, seq }) => [subscriptionId, seq])).toContainEqual(["b", 42]);
  expect(frames.map(({ subscriptionId, seq }) => [subscriptionId, seq])).toContainEqual(["a", 99]);
  expect(frames.length).toBeLessThan(10);
});
