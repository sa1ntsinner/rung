// SPDX-License-Identifier: MIT
// Terminals that run rung CLI commands as child processes of the extension: the user sees every line,
// the extension gets the exit code and output (for download retries, compile problems, refreshes).
import { spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import type { Invocation } from "../core/exec";

export interface RunResult {
  /** Process exit code; null when it could not start or was killed. */
  code: number | null;
  output: string;
  /** Spawn error (e.g. ENOENT when rung.command is wrong). */
  error?: Error;
}

const MAX_CAPTURE = 2 * 1024 * 1024;
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

/** Kills a child and its children (on Windows a cmd.exe shim would otherwise leave node running). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
  else child.kill("SIGINT");
}

/** Starts a child process and collects its output. */
export function startProcess(inv: Invocation, cwd: string | undefined, onData?: (text: string) => void, env: Record<string, string> = {}): { child: ChildProcess; done: Promise<RunResult> } {
  const child = spawn(inv.file, inv.args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: inv.shell,
  });
  let output = "";
  const take = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (output.length < MAX_CAPTURE) output += text;
    onData?.(text);
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  const done = new Promise<RunResult>((resolve) => {
    let error: Error | undefined;
    child.once("error", (e) => {
      error = e;
      resolve({ code: null, output, error: e });
    });
    child.once("close", (code) => {
      if (!error) resolve({ code, output });
    });
  });
  return { child, done };
}

export interface TerminalRunOptions {
  /** Ask before Ctrl+C kills the process (downloads). */
  guardInterrupt?: string;
}

/** A pseudoterminal that can run several rung commands one after another. */
export class RunTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  readonly terminal: vscode.Terminal;
  private opened!: Promise<void>;
  private markOpened!: () => void;
  private child: ChildProcess | undefined;
  private guard: string | undefined;
  private interruptArmed = false;
  closed = false;

  constructor(
    readonly name: string,
    icon: vscode.ThemeIcon,
  ) {
    this.opened = new Promise((r) => (this.markOpened = r));
    this.terminal = vscode.window.createTerminal({ name, pty: this, iconPath: icon });
  }

  get busy(): boolean {
    return !!this.child;
  }

  open(): void {
    this.markOpened();
  }

  close(): void {
    this.closed = true;
    if (this.child) killTree(this.child);
  }

  handleInput(data: string): void {
    if (data !== "\x03" || !this.child) return;
    if (this.guard && !this.interruptArmed) {
      this.interruptArmed = true;
      this.write(`\r\n${YELLOW}${this.guard}${RESET}\r\n`);
      return;
    }
    this.write(`\r\n${YELLOW}^C stopping rung…${RESET}\r\n`);
    killTree(this.child);
  }

  private write(text: string) {
    this.writeEmitter.fire(text);
  }

  async run(inv: Invocation, cwd: string | undefined, opts: TerminalRunOptions = {}): Promise<RunResult> {
    if (this.child) throw new Error(`${this.name} is busy`);
    this.terminal.show(true);
    await this.opened;
    this.guard = opts.guardInterrupt;
    this.interruptArmed = false;
    this.write(`${DIM}> ${inv.display}${RESET}\r\n`);
    const started = Date.now();
    const { child, done } = startProcess(inv, cwd, (t) => this.write(crlf(t)));
    this.child = child;
    const r = await done;
    this.child = undefined;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (r.error) this.write(`${RED}could not start ${inv.file}: ${r.error.message}${RESET}\r\n`);
    else if (r.code === 0) this.write(`${DIM}${GREEN}✓ done in ${secs} s${RESET}\r\n\r\n`);
    else this.write(`${RED}✗ exit code ${r.code ?? "killed"} after ${secs} s${RESET}\r\n\r\n`);
    return r;
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

/** Hands out terminals: one shared "rung" terminal (setting rung.terminal.reuse) and dedicated ones. */
export class TerminalPool implements vscode.Disposable {
  private shared: RunTerminal | undefined;
  private readonly all = new Set<RunTerminal>();
  private readonly sub: vscode.Disposable;

  constructor() {
    this.sub = vscode.window.onDidCloseTerminal((t) => {
      for (const r of this.all)
        if (r.terminal === t) {
          r.closed = true;
          this.all.delete(r);
          if (this.shared === r) this.shared = undefined;
        }
    });
  }

  get(reuse: boolean): RunTerminal {
    if (reuse && this.shared && !this.shared.closed && !this.shared.busy) return this.shared;
    const t = this.create("rung", new vscode.ThemeIcon("terminal"));
    if (reuse && (!this.shared || this.shared.closed)) this.shared = t;
    return t;
  }

  /** A terminal of its own, e.g. "rung download PLC_1"; an idle one with the same name is reused. */
  dedicated(name: string, icon: vscode.ThemeIcon): RunTerminal {
    for (const r of this.all) if (r.name === name && !r.closed && !r.busy) return r;
    return this.create(name, icon);
  }

  private create(name: string, icon: vscode.ThemeIcon): RunTerminal {
    const t = new RunTerminal(name, icon);
    this.all.add(t);
    return t;
  }

  dispose(): void {
    this.sub.dispose();
    for (const t of this.all) t.dispose();
    this.all.clear();
  }
}
