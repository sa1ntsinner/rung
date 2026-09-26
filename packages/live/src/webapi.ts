// SPDX-License-Identifier: BUSL-1.1
// Read-only client for the S7-1500 Web API (JSON-RPC 2.0 over HTTPS, /api/jsonrpc).
// rung only reads: login, browse, read values and the diagnostic buffer. It never writes to a PLC.
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

export interface WebApiOptions {
  /** Base URL, e.g. https://192.168.0.1 (http:// only for tests/simulators). */
  url: string;
  user: string;
  password: string;
  /** Accept self-signed PLC certificates. Off by default; enable per workspace. */
  insecure?: boolean;
  timeoutMs?: number;
}

export class WebApiError extends Error {
  override name = "WebApiError";
  constructor(
    public readonly code: number | string,
    message: string,
  ) {
    super(message);
  }
}

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Methods rung is allowed to call. Anything that writes is deliberately absent. */
const READ_ONLY_METHODS = new Set(["Api.Login", "Api.Logout", "Api.Ping", "Api.GetPermissions", "Api.Version", "PlcProgram.Read", "PlcProgram.Browse", "DiagnosticBuffer.Browse", "Plc.ReadOperatingMode"]);

export class WebApiClient {
  private token: string | undefined;
  private nextId = 1;
  constructor(private readonly opts: WebApiOptions) {}

  private post(body: unknown): Promise<RpcResponse[] | RpcResponse> {
    const url = new URL("/api/jsonrpc", this.opts.url);
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const r = req(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": data.length, ...(this.token ? { "X-Auth-Token": this.token } : {}) },
          rejectUnauthorized: !this.opts.insecure,
          timeout: this.opts.timeoutMs ?? 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 500) >= 400) return reject(new WebApiError(res.statusCode ?? 500, `HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new WebApiError("BAD_RESPONSE", `not JSON: ${text.slice(0, 200)}`));
            }
          });
        },
      );
      r.on("timeout", () => r.destroy(new WebApiError("TIMEOUT", "PLC did not answer")));
      r.on("error", (e) => reject(e instanceof WebApiError ? e : new WebApiError("NETWORK", (e as Error).message)));
      r.end(data);
    });
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!READ_ONLY_METHODS.has(method)) throw new WebApiError("NOT_ALLOWED", `${method} is not a read-only Web API method; rung never writes to a PLC`);
    const id = this.nextId++;
    const res = (await this.post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })) as RpcResponse;
    if (res.error) throw new WebApiError(res.error.code, `${method}: ${res.error.message}`);
    return res.result as T;
  }

  async login(): Promise<void> {
    this.token = await this.call<string>("Api.Login", { user: this.opts.user, password: this.opts.password });
  }

  /** Reads several variables in one batch request; names use TIA syntax, e.g. "Fx_Global".Counter. */
  async read(names: string[]): Promise<{ name: string; value?: unknown; error?: string }[]> {
    if (!this.token) await this.login();
    const base = this.nextId;
    this.nextId += names.length;
    const batch = names.map((n, i) => ({ jsonrpc: "2.0", id: base + i, method: "PlcProgram.Read", params: { var: n } }));
    const res = await this.post(batch);
    const list = Array.isArray(res) ? res : [res];
    return names.map((name, i) => {
      const r = list.find((x) => x.id === base + i);
      if (!r) return { name, error: "no answer" };
      return r.error ? { name, error: `${r.error.code}: ${r.error.message}` } : { name, value: r.result };
    });
  }

  async browse(name?: string): Promise<unknown> {
    if (!this.token) await this.login();
    return this.call("PlcProgram.Browse", name ? { var: name, mode: "children" } : { mode: "children" });
  }

  async diagnosticBuffer(count = 50): Promise<unknown> {
    if (!this.token) await this.login();
    return this.call("DiagnosticBuffer.Browse", { count });
  }

  async logout(): Promise<void> {
    if (!this.token) return;
    try {
      await this.call("Api.Logout");
    } finally {
      this.token = undefined;
    }
  }
}
