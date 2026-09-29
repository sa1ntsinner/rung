// SPDX-License-Identifier: MIT
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  BridgeError,
  ErrorCodes,
  PROTOCOL_VERSION,
  type BridgeEvent,
  type CompileMessage,
  type ConnectionOptions,
  type ConnectionTarget,
  type DownloadOutcome,
  type DownloadRequest,
  type OnlineStatus,
  type CompareOutcome,
  type XRefEntry,
  type DescribeNode,
  type ExportResult,
  type HelloResult,
  type ObjectEntry,
  type ProjectInfo,
} from "./protocol.js";

export interface BridgeClientOptions {
  command: string;
  args?: string[];
  /** Merged over the parent environment. */
  env?: Record<string, string>;
  /** Default 120 s. A timed-out mutation rejects with OUTCOME_UNKNOWN and is never replayed. */
  requestTimeoutMs?: number;
  /** Frames above this size terminate the bridge. Default 64 MiB. */
  maxLineBytes?: number;
}

interface Pending {
  method: string;
  mutation: boolean;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const MUTATIONS = new Set(["objects.import", "objects.delete", "objects.rename", "plc.download"]);
const MAX_NOISE = 200;
const MAX_MALFORMED = 50;

export class BridgeClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: ((e: BridgeEvent) => void)[] = [];
  private buffer = "";
  private malformed = 0;
  private exited = false;
  private exitPromise: Promise<void>;
  /** Methods sent, in order (diagnostics and tests). */
  readonly sentMethods: string[] = [];
  info!: HelloResult;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly opts: Required<Pick<BridgeClientOptions, "requestTimeoutMs" | "maxLineBytes">>,
  ) {
    this.exitPromise = new Promise((resolve) => {
      const done = () => {
        if (this.exited) return;
        this.exited = true;
        this.failAll(new BridgeError(ErrorCodes.BRIDGE_EXITED, "rung-bridge exited"));
        resolve();
      };
      child.on("exit", done);
      child.on("error", (e) => {
        this.emit({ event: "spawn-error", params: { message: e.message } });
        done();
      });
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.emit({ event: "stderr", params: chunk }));
    child.stdin.on("error", () => {}); // EPIPE after the child died surfaces via "exit"
  }

  static async spawn(opts: BridgeClientOptions): Promise<BridgeClient> {
    const child = spawn(opts.command, opts.args ?? [], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    const client = new BridgeClient(child, {
      requestTimeoutMs: opts.requestTimeoutMs ?? 120_000,
      maxLineBytes: opts.maxLineBytes ?? 64 * 1024 * 1024,
    });
    try {
      const hello = (await client.request("bridge.hello", {})) as HelloResult;
      if (hello?.protocol !== PROTOCOL_VERSION)
        throw new BridgeError(ErrorCodes.PROTOCOL_MISMATCH, `bridge speaks protocol ${hello?.protocol}, expected ${PROTOCOL_VERSION}`);
      client.info = hello;
      return client;
    } catch (e) {
      await client.close();
      throw e instanceof BridgeError ? e : new BridgeError(ErrorCodes.BRIDGE_EXITED, String(e));
    }
  }

  onEvent(cb: (e: BridgeEvent) => void): void {
    this.listeners.push(cb);
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = this.opts.requestTimeoutMs): Promise<unknown> {
    if (this.exited) return Promise.reject(new BridgeError(ErrorCodes.BRIDGE_EXITED, "rung-bridge is not running"));
    const id = this.nextId++;
    const mutation = MUTATIONS.has(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          mutation
            ? new BridgeError(ErrorCodes.OUTCOME_UNKNOWN, `${method} timed out; it may or may not have been applied in TIA Portal`)
            : new BridgeError(ErrorCodes.TIMEOUT, `${method} timed out after ${timeoutMs} ms`),
        );
      }, timeoutMs);
      this.pending.set(id, { method, mutation, resolve, reject, timer });
      this.sentMethods.push(method);
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  hello(): Promise<HelloResult> {
    return this.request("bridge.hello", {}) as Promise<HelloResult>;
  }
  projectInfo(): Promise<ProjectInfo> {
    return this.request("project.info", {}) as Promise<ProjectInfo>;
  }
  listObjects(device: string): Promise<ObjectEntry[]> {
    return this.request("objects.list", { device }) as Promise<ObjectEntry[]>;
  }
  exportObject(address: string, form: string, dir: string): Promise<ExportResult> {
    return this.request("objects.export", { address, form, dir }) as Promise<ExportResult>;
  }
  importObject(address: string, form: string, path: string, expectedTiaRevision: string, operationId: string): Promise<ExportResult> {
    return this.request("objects.import", { address, form, path, expectedTiaRevision, operationId }) as Promise<ExportResult>;
  }

  deleteObject(address: string, expectedTiaRevision: string, operationId: string): Promise<{ deleted: boolean }> {
    return this.request("objects.delete", { address, expectedTiaRevision, operationId }) as Promise<{ deleted: boolean }>;
  }

  /** Renames a block, type or tag table in TIA Portal (uses follow there); compiles, so it can take a while. */
  renameObject(address: string, newName: string, expectedTiaRevision: string, operationId: string): Promise<{ address: string }> {
    return this.request("objects.rename", { address, newName, expectedTiaRevision, operationId }, 600_000) as Promise<{ address: string }>;
  }

  describe(scope: "hardware" | "hmi" | "techobjects" | "libraries", maxNodes = 20000): Promise<DescribeNode> {
    return this.request("model.describe", { scope, maxNodes }) as Promise<DescribeNode>;
  }

  xref(address: string): Promise<XRefEntry[]> {
    return this.request("xref.get", { address }) as Promise<XRefEntry[]>;
  }

  compile(device: string, addresses: string[] = []): Promise<CompileMessage[]> {
    return this.request("plc.compile", { device, addresses }) as Promise<CompileMessage[]>;
  }

  compileHardware(device: string): Promise<CompileMessage[]> {
    return this.request("plc.compile", { device, hardware: true }, 600_000) as Promise<CompileMessage[]>;
  }

  online(device: string, action: "state" | "online" | "offline", target?: ConnectionTarget): Promise<OnlineStatus> {
    return this.request("plc.online", { device, action, ...(target ? { target } : {}) }, 120_000) as Promise<OnlineStatus>;
  }

  /** Read-only; comparing a large program with the PLC takes a while. */
  compare(device: string, target?: ConnectionTarget): Promise<CompareOutcome> {
    return this.request("plc.compare", { device, ...(target ? { target } : {}) }, 600_000) as Promise<CompareOutcome>;
  }

  connections(device: string, scan = false): Promise<ConnectionOptions> {
    return this.request("plc.connections", { device, scan }, scan ? 180_000 : 60_000) as Promise<ConnectionOptions>;
  }

  /** A download can take minutes (hardware, large programs); it is never retried. */
  download(request: DownloadRequest): Promise<DownloadOutcome> {
    return this.request("plc.download", { request }, 1_800_000) as Promise<DownloadOutcome>;
  }

  show(address: string): Promise<{ shown: boolean }> {
    return this.request("objects.show", { address }) as Promise<{ shown: boolean }>;
  }

  /** Values of a running application (CODESYS: its own IEC paths such as PLC_PRG.fbCount.nCount). Read-only. */
  read(device: string, expressions: string[]): Promise<{ name: string; value?: unknown; error?: string }[]> {
    return this.request("plc.read", { device, expressions }, 30_000) as Promise<{ name: string; value?: unknown; error?: string }[]>;
  }

  async close(): Promise<void> {
    if (!this.exited) {
      this.child.stdin.end();
      const killer = setTimeout(() => this.child.kill(), 5_000);
      await this.exitPromise;
      clearTimeout(killer);
    }
    await this.exitPromise;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
    if (Buffer.byteLength(this.buffer) > this.opts.maxLineBytes) {
      this.buffer = "";
      this.emit({ event: "protocol-error", params: "frame too large" });
      this.child.kill();
    }
  }

  private onLine(line: string) {
    let msg: { id?: unknown; result?: unknown; error?: { code?: string; message?: string }; event?: string; params?: unknown };
    try {
      msg = JSON.parse(line);
      if (typeof msg !== "object" || msg === null) throw new Error("not an object");
    } catch {
      this.emit({ event: "stdout-noise", params: line.slice(0, MAX_NOISE) });
      if (++this.malformed > MAX_MALFORMED) this.child.kill();
      return;
    }
    if (typeof msg.event === "string") {
      this.emit({ event: msg.event, params: msg.params });
      return;
    }
    if (typeof msg.id !== "number") {
      this.emit({ event: "stdout-noise", params: line.slice(0, MAX_NOISE) });
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return; // late reply after timeout
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new BridgeError(msg.error.code ?? ErrorCodes.INTERNAL, msg.error.message ?? ""));
    else p.resolve(msg.result);
  }

  private failAll(err: BridgeError) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(p.mutation ? new BridgeError(ErrorCodes.OUTCOME_UNKNOWN, `${p.method}: bridge exited before replying`) : err);
      this.pending.delete(id);
    }
  }

  private emit(e: BridgeEvent) {
    for (const l of this.listeners) l(e);
  }
}
