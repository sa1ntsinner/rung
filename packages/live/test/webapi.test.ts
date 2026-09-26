// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebApiClient } from "../src/index.js";

/** Minimal S7-1500 Web API stand-in. */
function fakePlc(values: Record<string, unknown>) {
  const calls: { method: string; token?: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const token = req.headers["x-auth-token"] as string | undefined;
      const handle = (r: { id: number; method: string; params?: { user?: string; password?: string; var?: string } }) => {
        calls.push({ method: r.method, ...(token ? { token } : {}) });
        if (r.method === "Api.Login") return r.params?.password === "secret" ? { jsonrpc: "2.0", id: r.id, result: "TOKEN123" } : { jsonrpc: "2.0", id: r.id, error: { code: 100, message: "Login failed" } };
        if (token !== "TOKEN123") return { jsonrpc: "2.0", id: r.id, error: { code: 2, message: "Permission denied" } };
        if (r.method === "PlcProgram.Read") return r.params!.var! in values ? { jsonrpc: "2.0", id: r.id, result: values[r.params!.var!] } : { jsonrpc: "2.0", id: r.id, error: { code: 200, message: "Address does not exist" } };
        if (r.method === "Api.Logout") return { jsonrpc: "2.0", id: r.id, result: true };
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "Method not found" } };
      };
      const parsed = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(handle) : handle(parsed)));
    });
  });
  return { server, calls };
}

let server: Server | undefined;
afterEach(() => server?.close());

async function start(values: Record<string, unknown>) {
  const f = fakePlc(values);
  server = f.server;
  await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", () => r()));
  const port = (f.server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, calls: f.calls };
}

describe("WebApiClient", () => {
  it("logs in once and reads a batch of variables with per-variable errors", async () => {
    const plc = await start({ '"Fx_Global".Counter': 42, '"Fx_Global".Ready': true });
    const c = new WebApiClient({ url: plc.url, user: "Administrator", password: "secret" });
    const r = await c.read(['"Fx_Global".Counter', '"Fx_Global".Ready', '"Nope".x']);
    expect(r).toEqual([
      { name: '"Fx_Global".Counter', value: 42 },
      { name: '"Fx_Global".Ready', value: true },
      { name: '"Nope".x', error: "200: Address does not exist" },
    ]);
    await c.read(['"Fx_Global".Counter']);
    expect(plc.calls.filter((x) => x.method === "Api.Login")).toHaveLength(1);
    expect(plc.calls.filter((x) => x.method === "PlcProgram.Read").every((x) => x.token === "TOKEN123")).toBe(true);
    await c.logout();
  });

  it("reports login failures with the PLC's code", async () => {
    const plc = await start({});
    const c = new WebApiClient({ url: plc.url, user: "Administrator", password: "wrong" });
    await expect(c.read(['"x"'])).rejects.toMatchObject({ code: 100 });
  });

  it("refuses any method that could write to the PLC", async () => {
    const c = new WebApiClient({ url: "http://127.0.0.1:1", user: "u", password: "p" });
    await expect(c.call("PlcProgram.Write", { var: '"x"', value: 1 })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(c.call("Plc.RequestChangeOperatingMode", { mode: "stop" })).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  });

  it("maps network errors and timeouts", async () => {
    const c = new WebApiClient({ url: "http://127.0.0.1:1", user: "u", password: "p", timeoutMs: 500 });
    await expect(c.read(['"x"'])).rejects.toMatchObject({ code: "NETWORK" });
  });
});

describe("Web API names", () => {
  it("quotes the first segment when a shell ate the quotes", async () => {
    const { webApiName } = await import("../src/webapi.js");
    expect(webApiName("Fx_Global.Counter")).toBe('"Fx_Global".Counter');
    expect(webApiName('"Fx_Global".Counter')).toBe('"Fx_Global".Counter');
    expect(webApiName("Tag_1")).toBe('"Tag_1"');
    expect(webApiName("DB1.arr[2].x")).toBe('"DB1".arr[2].x');
    expect(webApiName("%MW10")).toBe("%MW10");
  });
});
