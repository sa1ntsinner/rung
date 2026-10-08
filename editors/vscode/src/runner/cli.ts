// SPDX-License-Identifier: MIT
// Runs the rung CLI: in a terminal (the user watches) or in the background (the extension reads the result).
import * as vscode from "vscode";
import { buildInvocation, findExecutable, type Invocation } from "../core/exec";
import type { Output } from "../output";
import { readSettings } from "../settings";
import { isFile, type RungWorkspace } from "../workspace";
import { killTree, startProcess, type RunResult, type TerminalPool } from "./terminal";

export interface RunOptions {
  /** Dedicated terminal name; default: the shared "rung" terminal (or a new one, per rung.terminal.reuse). */
  terminal?: string;
  icon?: string;
  guardInterrupt?: string;
}

export interface CaptureOptions {
  /** Progress notification title; none = silent. */
  progress?: string;
  cancellable?: boolean;
  timeoutMs?: number;
  /** Log only with verbosity "verbose" unless it fails (background refreshes). */
  quiet?: boolean;
  /** Stops the process when cancelled (a test run the person stopped). */
  token?: vscode.CancellationToken;
}

export interface Finished {
  args: readonly string[];
  result: RunResult;
}

export class RungCli implements vscode.Disposable {
  /** The rung that came with the extension (bundled.ts), used while rung.command is the default and no rung is on PATH. */
  static bundled: string | undefined;
  /** The extension's storage folder the bundled rung and its command live in. */
  static bundledBase: string | undefined;
  private readonly finished = new vscode.EventEmitter<Finished>();
  /** Fires after every CLI command, so views can refresh. */
  readonly onDidFinish = this.finished.event;

  constructor(
    private readonly ws: RungWorkspace,
    private readonly out: Output,
    private readonly terminals: TerminalPool,
  ) {}

  invocation(args: readonly string[]): Invocation {
    const r = { platform: process.platform, env: process.env, isFile, ...(this.ws.root ? { cwd: this.ws.root } : {}) };
    const command = readSettings().command;
    const bundled = RungCli.bundled && command.length === 1 && command[0] === "rung" && !findExecutable("rung", r) ? [RungCli.bundled] : command;
    return buildInvocation(bundled, args, r);
  }

  /** Runs in a terminal the user can see; resolves when the command exits. */
  async run(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
    const inv = this.invocation(args);
    const t = opts.terminal ? this.terminals.dedicated(opts.terminal, new vscode.ThemeIcon(opts.icon ?? "terminal")) : this.terminals.get(readSettings().reuseTerminal);
    this.out.info(`$ ${inv.display}`);
    this.out.debug(`  spawn ${inv.file} ${JSON.stringify(inv.args)} in ${this.ws.root ?? "(no folder)"}`);
    const result = await t.run(inv, this.ws.root, opts.guardInterrupt ? { guardInterrupt: opts.guardInterrupt } : {});
    this.report(inv, result);
    this.finished.fire({ args, result });
    return result;
  }

  /** Runs without a terminal and returns the output (also logged to the rung output channel). */
  async capture(args: readonly string[], opts: CaptureOptions = {}): Promise<RunResult> {
    const inv = this.invocation(args);
    if (opts.quiet) this.out.debug(`$ ${inv.display}`);
    else this.out.info(`$ ${inv.display}`);
    const exec = async (token?: vscode.CancellationToken) => {
      const { child, done } = startProcess(inv, this.ws.root);
      const timer = opts.timeoutMs ? setTimeout(() => killTree(child), opts.timeoutMs) : undefined;
      const sub = token?.onCancellationRequested(() => killTree(child));
      try {
        return await done;
      } finally {
        if (timer) clearTimeout(timer);
        sub?.dispose();
      }
    };
    const result = opts.progress
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: opts.progress, cancellable: !!opts.cancellable }, (_p, token) => exec(token))
      : await exec(opts.token);
    this.report(inv, result);
    if (!opts.quiet || result.code !== 0) this.out.block(result.output, result.code !== 0);
    this.finished.fire({ args, result });
    return result;
  }

  private report(inv: Invocation, r: RunResult): void {
    if (r.error) {
      this.out.error(`could not start "${inv.display}": ${r.error.message}`);
      void this.offerCommandSetting(r.error);
    } else if (r.code !== 0) this.out.error(`exit code ${r.code ?? "killed"}: ${inv.display}`);
    else this.out.debug(`exit code 0: ${inv.display}`);
  }

  private async offerCommandSetting(e: Error): Promise<void> {
    const pick = await vscode.window.showErrorMessage(
      `rung could not be started (${(e as NodeJS.ErrnoException).code ?? e.message}). Is it on PATH? Otherwise set "rung.command", e.g. ["node", "C:/path/to/rung/packages/cli/dist/index.js"].`,
      "Open setting",
    );
    if (pick) await vscode.commands.executeCommand("workbench.action.openSettings", "rung.command");
  }

  /** Last non-empty "rung: …" / "hint: …" lines, for notifications. */
  static summary(output: string): string {
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // progress lines ("rung: looking for PLC_1 on the network…") say nothing about the outcome
    const err = lines.filter((l) => /^(rung( [a-z-]+)?:|hint:)/.test(l) && !/…$/.test(l));
    return (err.length ? err : lines.slice(-1)).join(" ").slice(0, 400);
  }

  dispose(): void {
    this.finished.dispose();
  }
}
