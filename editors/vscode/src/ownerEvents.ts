// SPDX-License-Identifier: MIT
// Subscribes to rung watch's events (the workspace owner's local pipe, .rung/owner.json): phases of a pass, its
// report, errors. Connects when a watch appears and again after it restarts, retrying while the watch's pipe is not
// up yet. On connecting it fires "connected", then the owner's own status (what it did before we listened).
// Read-only: subscribe and status are the only requests.
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import * as vscode from "vscode";
import type { RungWorkspace } from "./workspace";

export class OwnerEvents implements vscode.Disposable {
  private sock: Socket | undefined;
  /** the owner (pid + start) this connection belongs to */
  private connectedTo: string | undefined;
  private retry: NodeJS.Timeout | undefined;
  private delay = 1000;
  private readonly fired = new vscode.EventEmitter<{ event: string; params: unknown }>();
  readonly onEvent = this.fired.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly ws: RungWorkspace) {
    this.sub = ws.onDidChange(() => this.follow());
    this.follow();
  }

  private key(): string | undefined {
    return this.ws.owner ? `${this.ws.root}:${this.ws.owner.pid}:${this.ws.owner.startedAt ?? ""}` : undefined;
  }

  private follow(): void {
    const key = this.key();
    if (key === this.connectedTo) return;
    this.close();
    if (!key || !this.ws.root) {
      this.delay = 1000;
      return;
    }
    let info: { pipe?: string; token?: string };
    try {
      info = JSON.parse(readFileSync(join(this.ws.root, ".rung", "owner.json"), "utf8")) as typeof info;
    } catch {
      return this.again();
    }
    if (!info.pipe || !info.token) return this.again();
    this.connectedTo = key;
    const sock = createConnection(info.pipe);
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("error", () => undefined);
    sock.on("close", () => {
      if (this.sock !== sock) return;
      this.sock = undefined;
      this.connectedTo = undefined;
      this.fired.fire({ event: "disconnected", params: {} });
      this.again(); // the watch may only be restarting; when it is gone, ws.owner goes and nothing is retried
    });
    sock.on("connect", () => {
      this.delay = 1000;
      this.fired.fire({ event: "connected", params: {} });
      sock.write(JSON.stringify({ id: 1, token: info.token, method: "subscribe" }) + "\n");
      sock.write(JSON.stringify({ id: 2, token: info.token, method: "status" }) + "\n");
    });
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; event?: string; params?: unknown };
          if (msg.event) this.fired.fire({ event: msg.event, params: msg.params });
          else if (msg.id === 2 && msg.result) this.fired.fire({ event: "status", params: msg.result });
        } catch {
          /* not ours */
        }
      }
      // a report lists every file of the pass: a whole project's first pass is large, but not this large
      if (buf.length > 64 * 1024 * 1024) sock.destroy();
    });
  }

  /** Tries again in a while (1 s, doubling to 15 s) while a watch is there to connect to. */
  private again(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.ws.owner) this.follow();
    }, this.delay);
    this.delay = Math.min(this.delay * 2, 15_000);
  }

  private close(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const s = this.sock;
    this.sock = undefined;
    this.connectedTo = undefined;
    s?.destroy();
  }

  dispose(): void {
    this.sub.dispose();
    this.close();
    this.fired.dispose();
  }
}
