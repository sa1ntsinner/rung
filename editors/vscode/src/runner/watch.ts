// SPDX-License-Identifier: MIT
// `rung watch` in a real terminal: it has a console, so Ctrl+C reaches it and it stops cleanly
// (flushes state, releases the lock). Running state comes from .rung/owner.json via RungWorkspace.
import * as vscode from "vscode";
import type { Output } from "../output";
import type { RungWorkspace } from "../workspace";
import type { RungCli } from "./cli";

const STOP_TIMEOUT_MS = 20_000;

export class WatchController implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private stopping = false;
  private readonly subs: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly ws: RungWorkspace,
    private readonly cli: RungCli,
    private readonly out: Output,
  ) {
    this.subs.push(
      vscode.window.onDidCloseTerminal((t) => {
        if (t !== this.terminal) return;
        this.terminal = undefined;
        this.ws.scheduleReload(500);
        this.changed.fire();
      }),
      ws.onDidChange(() => this.changed.fire()),
    );
  }

  /** "running" (owner alive), "starting" (our terminal, owner not up yet) or "stopped". */
  get status(): "running" | "starting" | "stopping" | "stopped" {
    if (this.stopping) return "stopping";
    if (this.ws.watching) return "running";
    return this.terminal ? "starting" : "stopped";
  }

  /** true when the running watch was started from this window. */
  get owned(): boolean {
    return !!this.terminal;
  }

  async start(): Promise<void> {
    if (!this.ws.hasConfig) {
      void vscode.window.showWarningMessage("This folder has no rung.toml. Initialize it from a TIA Portal project first.");
      return;
    }
    if (this.terminal) {
      this.terminal.show(true);
      return;
    }
    if (this.ws.watching) {
      void vscode.window.showInformationMessage(`rung watch is already running (pid ${this.ws.owner!.pid}), started outside this window.`);
      return;
    }
    const inv = this.cli.invocation(["watch"]);
    this.out.info(`$ ${inv.display}   (terminal "rung watch")`);
    this.terminal = vscode.window.createTerminal({
      name: "rung watch",
      cwd: this.ws.root,
      shellPath: inv.file,
      // cmd.exe needs its /c line verbatim; a string is passed through unchanged on Windows
      shellArgs: inv.shell ? inv.args.join(" ") : inv.args,
      iconPath: new vscode.ThemeIcon("eye"),
      isTransient: true,
    });
    this.terminal.show(true);
    this.changed.fire();
    // owner.json appears once watch serves; the file watcher reloads the workspace then.
  }

  async stop(): Promise<void> {
    if (!this.terminal) {
      if (this.ws.watching)
        void vscode.window.showInformationMessage(`rung watch (pid ${this.ws.owner!.pid}) was started outside this window. Stop it with Ctrl+C in its terminal.`);
      return;
    }
    const t = this.terminal;
    this.stopping = true;
    this.changed.fire();
    try {
      t.sendText("\u0003", false);
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        await this.ws.reload();
        if (!this.ws.watching) break;
      }
      if (this.ws.watching) {
        const pick = await vscode.window.showWarningMessage(
          "rung watch did not stop within 20 seconds (it may be waiting for TIA Portal).",
          { modal: true, detail: "Closing its terminal ends the process at once. The workspace state stays consistent, but a sync in progress is not finished." },
          "Close terminal",
        );
        if (pick !== "Close terminal") return;
      }
      t.dispose();
    } finally {
      this.stopping = false;
      this.ws.scheduleReload(300);
      this.changed.fire();
    }
  }

  async toggle(): Promise<void> {
    if (this.ws.watching || this.terminal) await this.stop();
    else await this.start();
  }

  show(): void {
    this.terminal?.show();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
    // isTransient: the terminal is not restored on reload; VS Code ends it with the window.
  }
}
