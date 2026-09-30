// SPDX-License-Identifier: BUSL-1.1
// rung simulate: a virtual S7-1500 on its own address. It runs the workspace's SCL program on rung's offline
// simulator (cyclic OB or a chosen FB/FC) and answers the S7-1500 Web API (JSON-RPC over HTTP) with the live
// values, so rung live, the MCP live tools and editor features can be tried without hardware.
// It is not a PLCSIM: TIA Portal cannot go online to it or download into it.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WorkspaceIndex } from "@rung/lsp";
import { Simulator, parseBody, type Instance, type Value } from "@rung/sim";
import { WorkspaceError } from "@rung/core";
import { findWorkspace, type Io } from "./common.js";

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

export interface VirtualPlc {
  url: string;
  cycles(): number;
  close(): Promise<void>;
}

/** Plain JSON values of the simulator (instances become their memory). */
function plain(v: Value): unknown {
  if (v === undefined) return null;
  if (typeof v !== "object") return v;
  if ("__fb" in v) return plain((v as Instance).mem);
  if ("__array" in v) return (v as { items: Value[] }).items.map(plain);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
}

export async function startVirtualPlc(root: string, opts: { host: string; port: number; cycleMs: number; block?: string; user?: string; password?: string; log?: (s: string) => void }): Promise<VirtualPlc> {
  const index = new WorkspaceIndex();
  await index.load(root);
  const sim = new Simulator(index);
  const globals = index.allGlobals();
  // what runs every cycle: --block, else the cyclic OB (Main / OB1 / "Program cycle")
  const pick = opts.block
    ? index.global(opts.block)
    : globals.find((g) => g.kind === "OB" && /^(main|ob1|program[_ ]?cycle)$/i.test(g.name)) ?? globals.find((g) => g.kind === "OB");
  if (!pick?.block) throw new WorkspaceError("NOT_MIRRORED", opts.block ? `${opts.block} is not a block with code in the workspace` : "no organization block to run; choose an FB or FC with --block");
  const instance: Instance | undefined = pick.block.kind === "FB" ? sim.newInstance(pick.block.name) : undefined;
  // an FB runs in an instance DB named like TIA's default one: "Fx_Counter_DB".Count
  if (instance) (sim.globals as Record<string, Value>)[`${pick.block.name}_DB`.toUpperCase()] = instance;
  let cycles = 0;
  let lastError: string | null = null;
  const cycle = () => {
    sim.time += opts.cycleMs;
    try {
      sim.callBlock(instance ?? pick.block!.name);
      cycles++;
      lastError = null;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== lastError) opts.log?.(`cycle error: ${msg}\n`);
      lastError = msg;
    }
  };
  cycle(); // like a CPU going to RUN: the first scan is done before anyone can read
  const timer = setInterval(cycle, opts.cycleMs);

  const tokens = new Set<string>();
  const diag = [{ id: 1, timestamp: new Date().toISOString(), message: `rung virtual PLC started, running ${pick.block.name}` }];
  const ref = (name: string) => {
    // the Web API names variables like SCL does: "DB".member, "Tag", "DB".arr[2].x
    const [stmt] = parseBody(`${name} := 0;`);
    if (!stmt || stmt.k !== "assign") throw new Error("not a variable name");
    return stmt.target;
  };
  const handle = (r: RpcRequest, token: string | undefined): unknown => {
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
    const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: r.id, error: { code, message } });
    switch (r.method) {
      case "Api.Ping":
        return ok("rung-virtual-plc");
      case "Api.Login": {
        if (opts.user && (r.params?.user !== opts.user || r.params?.password !== opts.password)) return err(100, "Login failed");
        const t = randomUUID();
        tokens.add(t);
        return ok({ token: t });
      }
    }
    if (!token || !tokens.has(token)) return err(2, "Permission denied");
    switch (r.method) {
      case "Api.Logout":
        tokens.delete(token);
        return ok(true);
      case "Plc.ReadOperatingMode":
        return ok(lastError ? "stop" : "run");
      case "PlcProgram.Read":
        try {
          const target = ref(String(r.params?.var ?? ""));
          if (target.root.kind === "global") sim.read({ root: target.root, path: [], start: 0 }, null); // materialise the DB
          return ok(plain(sim.read(target, null)));
        } catch (e) {
          return err(200, `Address does not exist: ${(e as Error).message}`);
        }
      case "PlcProgram.Write":
        try {
          const target = ref(String(r.params?.var ?? ""));
          if (target.root.kind === "global") sim.read({ root: target.root, path: [], start: 0 }, null);
          sim.write(target, r.params?.value as Value, null);
          return ok(true);
        } catch (e) {
          return err(200, `Address does not exist: ${(e as Error).message}`);
        }
      case "PlcProgram.Browse":
        return ok(globals.filter((g) => g.kind === "DB" || g.kind === "TAG").map((g) => ({ name: g.name, db_number: 0, datatype: g.kind === "DB" ? "DB" : g.tag?.dataType ?? "" })));
      case "DiagnosticBuffer.Browse":
        return ok({ entries: [...diag, ...(lastError ? [{ id: 2, timestamp: new Date().toISOString(), message: `cycle error: ${lastError}` }] : [])] });
      default:
        return err(-32601, `Method not found: ${r.method}`);
    }
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || !req.url?.startsWith("/api/jsonrpc")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let reply: unknown;
      try {
        const msg = JSON.parse(body) as RpcRequest | RpcRequest[];
        const token = req.headers["x-auth-token"] as string | undefined;
        reply = Array.isArray(msg) ? msg.map((m) => handle(m, token)) : handle(msg, token);
      } catch {
        reply = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    url: `http://${opts.host}:${port}`,
    cycles: () => cycles,
    close: async () => {
      clearInterval(timer);
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export async function cmdSimulate(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const ws = await findWorkspace(dir).catch(() => dir);
  const host = (v.address as string | undefined) ?? "127.0.0.2";
  const port = Number(v.port ?? 8080);
  const cycle = Number(String(v.cycle ?? "10").replace(/ms$/i, ""));
  // no number would run the program without a pause and with its time standing at NaN
  if (!Number.isFinite(cycle)) throw new WorkspaceError("BAD_ARGUMENT", `--cycle is the cycle time in milliseconds (--cycle 10), not ${String(v.cycle)}`);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new WorkspaceError("BAD_ARGUMENT", `--port is a TCP port (0 to 65535), not ${String(v.port)}`);
  const cycleMs = Math.max(1, cycle);
  const plc = await startVirtualPlc(ws, { host, port, cycleMs, ...(v.block ? { block: String(v.block) } : {}), log: (s) => io.stderr(`rung simulate: ${s}`) });
  io.stdout(
    `rung simulate: virtual PLC at ${plc.url} (cycle ${cycleMs} ms)\n` +
      `Use it from rung live by adding to rung.toml:\n\n[live.webapi]\nurl = "${plc.url}"\nuser = "any"\n\nand any RUNG_WEBAPI_PASSWORD. Ctrl+C to stop.\n`,
  );
  await (io.stopSignal ?? new Promise<void>((r) => process.once("SIGINT", () => r())));
  await plc.close();
  io.stdout(`rung simulate: stopped after ${plc.cycles()} cycles\n`);
  return 0;
}
