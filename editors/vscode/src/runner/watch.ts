// SPDX-License-Identifier: MIT
// `rung watch` in a real terminal: it has a console, so Ctrl+C reaches it and it stops cleanly
// (flushes state, releases the lock). Running state comes from .rung/owner.json via RungWorkspace.
import * as vscode from "vscode";
import type { Output } from "../output";
import type { RungWorkspace } from "../workspace";
import { RungCli } from "./cli";

const STOP_TIMEOUT_MS = 20_000;

export class WatchController implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  /** The terminal of a watch that ended on its own, kept open so its output can be read. */
  private ended: vscode.Terminal | undefined;
  /** owner.json of our watch was seen, i.e. it served. */
  private served = false;
  private exitTimer: NodeJS.Timeout | undefined;
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
        if (t === this.ended) this.ended = undefined;
        if (t !== this.terminal) return;
        // closed although nobody pressed Stop: rung watch exited (VS Code closes a terminal whose process ends)
        if (!this.stopping) this.endedOnItsOwn(true);
        this.forget();
        this.ws.scheduleReload(500);
        this.changed.fire();
      }),
      ws.onDidChange(() => {
        if (this.terminal && ws.watching) this.served = true;
        // our watch served and is gone although nobody pressed Stop: it ended (Ctrl+C typed in its
        // terminal, an error, TIA Portal closed). The rung.cmd shim may still ask "Terminate batch job?".
        else if (this.terminal && this.served && !this.stopping) this.endedOnItsOwn(false);
        this.changed.fire();
      }),
      // "rung.watching" covers starting and stopping too, so Stop Watch is offered as soon as the terminal opens
      this.onDidChange(() => this.updateContext()),
    );
    this.updateContext();
  }

  private lastContext: boolean | undefined;

  private updateContext(): void {
    const on = this.status !== "stopped";
    if (on === this.lastContext) return;
    this.lastContext = on;
    void vscode.commands.executeCommand("setContext", "rung.watching", on);
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
    this.ended?.dispose();
    this.ended = undefined;
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
      iconPath: new vscode.ThemeIcon("sync"),
      isTransient: true,
    });
    this.terminal.show(true);
    this.served = false;
    // a watch that fails at once (bad rung.toml, TIA Portal not running) exits without ever serving
    this.exitTimer = setInterval(() => {
      if (this.terminal?.exitStatus && !this.stopping) this.endedOnItsOwn(false);
    }, 1000);
    this.changed.fire();
    // owner.json appears once watch serves; the file watcher reloads the workspace then.
  }

  private forget(): void {
    this.terminal = undefined;
    this.served = false;
    if (this.exitTimer) clearInterval(this.exitTimer);
    this.exitTimer = undefined;
  }

  /** Our watch ended without Stop. `closed`: its terminal is gone, and with it what rung printed. */
  private endedOnItsOwn(closed: boolean): void {
    const t = this.terminal;
    if (!t) return;
    const code = t.exitStatus?.code;
    const served = this.served;
    this.forget();
    if (!closed) this.ended = t;
    this.changed.fire();
    const exit = code !== undefined ? ` (exit code ${code})` : "";
    this.out.error(`rung watch ended${exit}`);
    void (async () => {
      let message: string;
      if (served) message = "rung watch stopped. Files and TIA Portal are no longer kept in sync.";
      else if (!closed) message = `rung watch could not start${exit}. Its terminal shows why.`;
      else {
        // the reason went with the terminal: startup errors (rung.toml, the workspace lock) show up in rung status too
        const r = await this.cli.capture(["status"], { quiet: true });
        message = r.code !== 0 && !r.error ? `rung watch could not start${exit}: ${RungCli.summary(r.output)}` : `rung watch exited${exit} before it was ready. The rung output has the command line.`;
      }
      const buttons = [...(this.ended ? ["Show terminal"] : ["Show output"]), "Start again"];
      const pick = await vscode.window.showWarningMessage(message, ...buttons);
      if (pick === "Show terminal") this.ended?.show();
      if (pick === "Show output") this.out.show();
      if (pick === "Start again") void this.start();
    })();
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
      this.forget();
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
    (this.terminal ?? this.ended)?.show();
  }

  dispose(): void {
    if (this.exitTimer) clearInterval(this.exitTimer);
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
    // isTransient: the terminal is not restored on reload; VS Code ends it with the window.
  }
}
