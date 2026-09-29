// SPDX-License-Identifier: MIT
// Monitoring like TIA Portal's "Monitoring on/off": the values of the open block at the end of each line, read
// from the PLC's Web API by `rung live watch --json` (read-only, one block at a time).
import type { ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import type { Output } from "./output";
import { RungCli } from "./runner/cli";
import { killTree, startProcess } from "./runner/terminal";
import type { RungWorkspace } from "./workspace";
import { lineText, type MonitorPlan } from "./core/monitorText";

export type { MonitorPlan };

interface Session {
  uri: vscode.Uri;
  child: ChildProcess;
  plan?: MonitorPlan;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  stopping?: boolean;
  reads: number;
}

export class Monitor implements vscode.Disposable {
  private session: Session | undefined;
  private readonly deco = vscode.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 2.5em", color: new vscode.ThemeColor("editorCodeLens.foreground") },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly ws: RungWorkspace,
    private readonly cli: RungCli,
    private readonly out: Output,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.subs.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
      // TIA Portal stops monitoring when the block is edited; so does rung (the lines no longer match)
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.session && e.contentChanges.length && e.document.uri.toString() === this.session.uri.toString()) void this.stop("the block was edited");
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (this.session && d.uri.toString() === this.session.uri.toString()) void this.stop();
      }),
    );
  }

  get monitoring(): vscode.Uri | undefined {
    return this.session?.uri;
  }
  get plan(): MonitorPlan | undefined {
    return this.session?.plan;
  }
  get values(): Record<string, unknown> {
    return this.session?.values ?? {};
  }
  get reads(): number {
    return this.session?.reads ?? 0;
  }

  /** Starts monitoring the block in the editor, or stops it. */
  async toggle(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (this.session && (!target || target.toString() === this.session.uri.toString())) return this.stop();
    if (!target) return;
    await this.stop();
    await this.start(target);
  }

  private async start(uri: vscode.Uri, instance?: string): Promise<void> {
    const rel = this.ws.rel(uri.fsPath);
    if (!rel) {
      void vscode.window.showWarningMessage("Monitoring works on the blocks of a rung workspace.");
      return;
    }
    const password = await this.password();
    if (password === undefined) return;
    const args = ["live", "watch", "--json", "--file", rel, ...(instance ? ["--instance", instance] : [])];
    const inv = this.cli.invocation(args);
    this.out.info(`$ ${inv.display}`);
    let pending = "";
    const session: Session = { uri, child: undefined as unknown as ChildProcess, values: {}, errors: {}, reads: 0 };
    const { child, done } = startProcess(
      inv,
      this.ws.root,
      (text) => {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) this.take(session, line);
      },
      { RUNG_WEBAPI_PASSWORD: password },
    );
    session.child = child;
    this.session = session;
    void vscode.commands.executeCommand("setContext", "rung.monitoring", true);
    this.changed.fire();
    const r = await done;
    if (this.session !== session) return;
    this.session = undefined;
    this.clear();
    void vscode.commands.executeCommand("setContext", "rung.monitoring", false);
    this.changed.fire();
    if (session.stopping || r.code === 0) return;
    // why it ended, in rung's words; an FB with several instances asks which one
    const several = /NO_INSTANCE: .* has \d+ instance DBs \(([^)]*)\)/.exec(r.output);
    if (several || /NO_INSTANCE/.test(r.output)) {
      const choice = several
        ? await vscode.window.showQuickPick([...several[1]!.split(", "), "Another instance (a multi-instance)…"], { title: "Monitor through which instance?" })
        : "Another instance (a multi-instance)…";
      const inst = choice?.endsWith("…") ? await vscode.window.showInputBox({ title: "Instance to monitor", prompt: 'An instance DB, or a multi-instance such as "Line_DB".Motor1' }) : choice;
      if (inst) await this.start(uri, inst);
      return;
    }
    if (/RUNG_WEBAPI_PASSWORD|Api\.Login|401|Invalid credentials/i.test(r.output)) await this.secrets.delete(this.secretKey());
    const pick = await vscode.window.showWarningMessage(`Monitoring stopped: ${RungCli.summary(r.output)}`, ...(/live\.webapi/.test(r.output) ? ["Open rung.toml"] : []));
    if (pick) await vscode.commands.executeCommand("rung.openConfig");
  }

  private take(s: Session, line: string): void {
    if (!line.startsWith("{")) return;
    try {
      const m = JSON.parse(line) as { plan?: MonitorPlan; values?: Record<string, unknown>; errors?: Record<string, string> };
      if (m.plan) s.plan = m.plan;
      if (m.values) {
        s.values = m.values;
        s.errors = m.errors ?? {};
        s.reads++;
      }
      if (this.session === s) this.render();
    } catch {
      /* a partial or foreign line */
    }
  }

  private render(): void {
    const s = this.session;
    for (const ed of vscode.window.visibleTextEditors) {
      if (!s?.plan || ed.document.uri.toString() !== s.uri.toString()) {
        ed.setDecorations(this.deco, []);
        continue;
      }
      const opts: vscode.DecorationOptions[] = [];
      for (const [line, labels] of Object.entries(s.plan.lines)) {
        const n = Number(line);
        if (n >= ed.document.lineCount) continue;
        const end = ed.document.lineAt(n).range.end;
        opts.push({ range: new vscode.Range(end, end), renderOptions: { after: { contentText: lineText(labels, s.values, s.errors) } } });
      }
      ed.setDecorations(this.deco, opts);
    }
  }

  private clear(): void {
    for (const ed of vscode.window.visibleTextEditors) ed.setDecorations(this.deco, []);
  }

  async stop(why?: string): Promise<void> {
    const s = this.session;
    if (!s) return;
    s.stopping = true;
    killTree(s.child);
    this.session = undefined;
    this.clear();
    void vscode.commands.executeCommand("setContext", "rung.monitoring", false);
    this.changed.fire();
    if (why) void vscode.window.showInformationMessage(`Monitoring stopped: ${why}.`);
  }

  private secretKey(): string {
    return `rung.webapi.password:${this.ws.root ?? ""}`;
  }

  /** The PLC web server password: from RUNG_WEBAPI_PASSWORD, else asked once and kept in VS Code's secret storage. */
  private async password(): Promise<string | undefined> {
    if (this.ws.config?.tiaVersion === "CODESYS") return ""; // CODESYS is read through rung's bridge, no web server
    if (process.env.RUNG_WEBAPI_PASSWORD) return process.env.RUNG_WEBAPI_PASSWORD;
    const kept = await this.secrets.get(this.secretKey());
    if (kept) return kept;
    const typed = await vscode.window.showInputBox({ title: "PLC web server password", prompt: "For the user in [live.webapi] of rung.toml. Kept in VS Code's secret storage, never in files.", password: true, ignoreFocusOut: true });
    if (typed === undefined) return undefined;
    await this.secrets.store(this.secretKey(), typed);
    return typed;
  }

  dispose(): void {
    void this.stop();
    this.deco.dispose();
    this.changed.dispose();
    for (const s of this.subs) s.dispose();
  }
}
