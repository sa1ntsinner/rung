// SPDX-License-Identifier: BUSL-1.1
// Local IPC of the workspace owner (rung watch): one writer, many readers (CLI, LSP, MCP).
import { createHash, randomBytes } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "@rung/core";

export const OWNER_PROTOCOL = 1;

export interface OwnerInfo {
  protocol: number;
  pid: number;
  pipe: string;
  token: string;
  startedAt: number;
}

export type OwnerHandler = (params: Record<string, unknown>) => Promise<unknown>;

export class OwnerError extends Error {
  override name = "OwnerError";
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ownerFile = (root: string) => join(root, ".rung", "owner.json");

async function pipeName(root: string): Promise<string> {
  const id = createHash("sha256").update((await realpath(root)).toLowerCase()).digest("hex").slice(0, 16);
  // Unix socket paths are limited to ~108 bytes: keep them short, in the OS temp dir, user-only (0600).
  return process.platform === "win32" ? `\\\\.\\pipe\\rung-${id}` : join(tmpdir(), `rung-${userInfo().uid}-${id}.sock`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Line-delimited JSON over a socket, with a size bound per line. */
function lines(sock: Socket, onLine: (l: string) => void, maxBytes = 16 * 1024 * 1024) {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (l.trim()) onLine(l);
    }
    if (buf.length > maxBytes) sock.destroy();
  });
}

export class OwnerServer {
  private server!: Server;
  private readonly subscribers = new Set<Socket>();
  /** the last passes' reports, with when they happened, for an editor that subscribes later */
  private readonly recent: string[] = [];
  private constructor(
    readonly root: string,
    readonly info: OwnerInfo,
    private readonly handlers: Record<string, OwnerHandler>,
  ) {}

  /** Start serving; the caller must already hold the workspace state lock (single owner). */
  static async start(root: string, handlers: Record<string, OwnerHandler>): Promise<OwnerServer> {
    const pipe = await pipeName(root);
    if (process.platform !== "win32") await unlink(pipe).catch(() => {});
    const info: OwnerInfo = { protocol: OWNER_PROTOCOL, pid: process.pid, pipe, token: randomBytes(24).toString("hex"), startedAt: Date.now() };
    await mkdir(join(root, ".rung"), { recursive: true });
    const s = new OwnerServer(root, info, handlers);
    s.server = createServer((sock) => s.accept(sock));
    await new Promise<void>((resolve, reject) => {
      s.server.once("error", reject);
      s.server.listen(pipe, () => resolve());
    });
    if (process.platform !== "win32") await chmod(pipe, 0o600);
    await writeFileAtomic(ownerFile(root), JSON.stringify(info));
    return s;
  }

  private accept(sock: Socket) {
    sock.on("error", () => {});
    sock.on("close", () => this.subscribers.delete(sock));
    lines(sock, async (line) => {
      let req: { id?: unknown; token?: string; method?: string; params?: Record<string, unknown> };
      try {
        req = JSON.parse(line);
      } catch {
        sock.destroy();
        return;
      }
      const reply = (o: object) => sock.writable && sock.write(JSON.stringify({ id: req.id ?? null, ...o }) + "\n");
      if (req.token !== this.info.token) {
        reply({ error: { code: "UNAUTHORIZED", message: "bad owner token" } });
        sock.destroy();
        return;
      }
      if (req.method === "subscribe") {
        this.subscribers.add(sock);
        reply({ result: { subscribed: true } });
        // { replay: true }: the passes before it subscribed, oldest first, each with its time (`at`)
        if (req.params?.replay) for (const l of this.recent) if (sock.writable) sock.write(l);
        return;
      }
      const h = req.method ? this.handlers[req.method] : undefined;
      if (!h) return reply({ error: { code: "BAD_REQUEST", message: `unknown method ${req.method}` } });
      try {
        reply({ result: (await h(req.params ?? {})) ?? null });
      } catch (e) {
        const code = (e as { code?: string }).code ?? "INTERNAL";
        reply({ error: { code, message: (e as Error).message } });
      }
    });
  }

  /** Pushes an event to every subscriber (diagnostics, status changes). */
  emit(event: string, params: unknown) {
    const line = JSON.stringify({ event, params }) + "\n";
    for (const s of this.subscribers) if (s.writable) s.write(line);
    if (event === "report") {
      this.recent.push(JSON.stringify({ event, params, at: Date.now(), replay: true }) + "\n");
      if (this.recent.length > 20) this.recent.shift();
    }
  }

  async close(): Promise<void> {
    for (const s of this.subscribers) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
    try {
      const cur = JSON.parse(await readFile(ownerFile(this.root), "utf8")) as OwnerInfo;
      if (cur.token === this.info.token) await unlink(ownerFile(this.root));
    } catch {
      /* gone */
    }
  }
}

export class OwnerClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners: ((event: string, params: unknown) => void)[] = [];
  private constructor(
    private readonly sock: Socket,
    private readonly token: string,
  ) {
    lines(sock, (l) => {
      let msg: { id?: number; result?: unknown; error?: { code: string; message: string }; event?: string; params?: unknown };
      try {
        msg = JSON.parse(l);
      } catch {
        return;
      }
      if (msg.event) {
        for (const cb of this.listeners) cb(msg.event, msg.params);
        return;
      }
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new OwnerError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    });
    sock.on("close", () => {
      for (const p of this.pending.values()) p.reject(new OwnerError("OWNER_GONE", "rung watch stopped"));
      this.pending.clear();
    });
  }

  /** Connects to the running owner of `root`, or returns null if there is none. */
  static async connect(root: string): Promise<OwnerClient | null> {
    let info: OwnerInfo;
    try {
      info = JSON.parse(await readFile(ownerFile(root), "utf8")) as OwnerInfo;
    } catch {
      return null;
    }
    if (info.protocol !== OWNER_PROTOCOL || !alive(info.pid)) return null;
    try {
      const sock = await new Promise<Socket>((resolve, reject) => {
        const s = createConnection(info.pipe, () => resolve(s));
        s.once("error", reject);
      });
      sock.on("error", () => {});
      return new OwnerClient(sock, info.token);
    } catch {
      return null;
    }
  }

  static async withTokenForTest(root: string, token: string): Promise<OwnerClient> {
    const info = JSON.parse(await readFile(ownerFile(root), "utf8")) as OwnerInfo;
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(info.pipe, () => resolve(s));
      s.once("error", reject);
    });
    sock.on("error", () => {});
    return new OwnerClient(sock, token);
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sock.write(JSON.stringify({ id, token: this.token, method, params }) + "\n");
    });
  }

  async subscribe(cb: (event: string, params: unknown) => void): Promise<void> {
    this.listeners.push(cb);
    await this.request("subscribe");
  }

  close() {
    this.sock.end();
  }
}
