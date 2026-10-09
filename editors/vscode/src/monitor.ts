// SPDX-License-Identifier: MIT
// Monitoring like TIA Portal's "Monitoring on/off": the values of the open block at the end of each line, read
// from the PLC's Web API by `rung live watch --json` (read-only, one block at a time).
import type { ChildProcess } from "node:child_process";
import { basename } from "node:path";
import * as vscode from "vscode";
import type { Output } from "./output";
import { RungCli } from "./runner/cli";
import { stopLive, startProcess } from "./runner/terminal";
import type { RungWorkspace } from "./workspace";
import { lineText, type MonitorPlan } from "./core/monitorText";
import type { LiveAccess } from "./liveAccess";
import type { LiveFrame } from "./core/liveFrames";

export type { MonitorPlan };

interface Session {
  uri: vscode.Uri;
  child: ChildProcess;
  plan?: MonitorPlan;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  display?: Record<string, string>;
  stopping?: boolean;
  reads: number;
  workspace: string;
  scope?: LiveFrame["scope"];
  state?: LiveFrame["state"];
  instances?: string[];
}

export class Monitor implements vscode.Disposable {
  private session: Session | undefined;
  private generation = 0;
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
    private readonly access: LiveAccess,
  ) {
    this.subs.push(
      ws.onDidChange(() => { if (this.session && this.session.workspace !== this.access.scope) void this.stop("the live target changed"); }),
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
  get errors(): Record<string, string> {
    return this.session?.errors ?? {};
  }
  get display(): Record<string, string> | undefined {
    return this.session?.display;
  }
  get reads(): number {
    return this.session?.reads ?? 0;
  }
  get scope(): LiveFrame["scope"] { return this.session?.scope; }
  get state(): LiveFrame["state"] { return this.session?.state; }

  /** Starts monitoring the block in the editor, or stops it. */
  async toggle(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (this.session && (!target || target.toString() === this.session.uri.toString())) return this.stop();
    if (!target) return;
    await this.stop();
    await this.start(target);
  }

  private async start(uri: vscode.Uri, instance?: string, retryEnv?: Record<string, string>, authAttempt = 0): Promise<void> {
    const generation = ++this.generation;
    const rel = this.ws.rel(uri.fsPath);
    if (!rel) {
      void vscode.window.showWarningMessage("Monitoring works on the blocks of a rung workspace.");
      return;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    // A save can import the block through watch; monitoring must stay read-only.
    if (open?.isDirty) {
      void vscode.window.showWarningMessage(`${basename(uri.fsPath)} has unsaved changes. Save or revert the block yourself before monitoring.`);
      return;
    }
    const connection = await this.access.select(/^plc\/([^/]+)\//.exec(rel.replace(/\\/g, "/"))?.[1]);
    if (!connection || generation !== this.generation) return;
    const env = retryEnv ?? await this.access.environment(connection);
    if (!env || generation !== this.generation || connection.workspace !== this.access.scope) return;
    // Recheck after dialogs: from here to spawning there is no await for an edit to slip in.
    if (open?.isDirty) { void vscode.window.showWarningMessage("The block changed; save or revert it yourself before monitoring."); return; }
    const args = ["live", "watch", "--json", "--parent-stdio", "--file", rel, "--device", connection.device, ...(instance ? ["--instance", instance] : [])];
    const inv = this.cli.invocation(args);
    this.out.info(`$ ${inv.display}`);
    let pending = "";
    const session: Session = { uri, child: undefined as unknown as ChildProcess, values: {}, errors: {}, reads: 0, workspace: connection.workspace };
    const { child, done } = startProcess(
      inv,
      this.ws.root,
      (text) => {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) this.take(session, line);
      },
      env,
      true,
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
    if (session.instances || several || /NO_INSTANCE/.test(r.output)) {
      const instances = session.instances ?? several?.[1]?.split(", ") ?? [];
      const choice = instances.length
        ? await vscode.window.showQuickPick([...instances, "Another instance (a multi-instance)…"], { title: "Monitor through which instance?" })
        : "Another instance (a multi-instance)…";
      const inst = choice?.endsWith("…") ? await vscode.window.showInputBox({ title: "Instance to monitor", prompt: 'An instance DB, or a multi-instance such as "Line_DB".Motor1' }) : choice;
      if (inst && generation === this.generation) await this.start(uri, inst);
      return;
    }
    if (authAttempt === 0 && /AUTHENTICATION_(REQUIRED|FAILED)|Api\.Login|401|Invalid credentials/i.test(r.output)) {
      const env = await this.access.environment(connection, true, r.output);
      if (env && generation === this.generation && connection.workspace === this.access.scope) await this.start(uri, instance, env, 1);
      return;
    }
    const pick = await vscode.window.showWarningMessage(`Monitoring stopped: ${RungCli.summary(r.output)}`, ...(/live\.webapi/.test(r.output) ? ["Open rung.toml"] : []));
    if (pick) await vscode.commands.executeCommand("rung.openConfig");
  }

  private take(s: Session, line: string): void {
    if (this.session !== s) return;
    if (!line.startsWith("{")) return;
    try {
      const m = JSON.parse(line) as Partial<LiveFrame> & { plan?: MonitorPlan; error?: { code?: string; details?: { instances?: unknown } } };
      const instances = m.error?.details?.instances;
      if (m.error?.code === "NO_INSTANCE" && Array.isArray(instances) && instances.length <= 512 && instances.every(x => typeof x === "string" && x.length <= 1024)) s.instances = instances;
      if (m.plan) s.plan = m.plan;
      if (m.scope) {
        if (s.scope && (m.scope.device !== s.scope.device || m.scope.address !== s.scope.address || m.scope.transport !== s.scope.transport || m.scope.epoch < s.scope.epoch)) return;
        s.scope = m.scope;
      }
      if (m.values) {
        s.values = m.values;
        s.errors = m.errors ?? {};
        s.display = m.display;
        s.state = m.state;
        if (m.state && m.state !== "live") for (const name of Object.keys(s.values)) s.errors[name] ??= `PLC ${m.state}`;
        s.reads++;
      }
      this.render();
      this.changed.fire(); // the declarations table shows each read too
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
        opts.push({ range: new vscode.Range(end, end), hoverMessage: `${s.scope ? `${s.scope.device} · ${s.scope.transport} · ${s.scope.address}\n` : ""}${labels.map(name => s.errors[name]).filter(Boolean).join("\n")}`, renderOptions: { after: { contentText: lineText(labels, s.values, s.errors, s.display) } } });
      }
      ed.setDecorations(this.deco, opts);
    }
  }

  private clear(): void {
    for (const ed of vscode.window.visibleTextEditors) ed.setDecorations(this.deco, []);
  }

  async stop(why?: string): Promise<void> {
    this.generation++;
    const s = this.session;
    if (!s) return;
    s.stopping = true;
    stopLive(s.child);
    this.session = undefined;
    this.clear();
    void vscode.commands.executeCommand("setContext", "rung.monitoring", false);
    this.changed.fire();
    if (why) void vscode.window.showInformationMessage(`Monitoring stopped: ${why}.`);
  }

  dispose(): void {
    void this.stop();
    this.deco.dispose();
    this.changed.dispose();
    for (const s of this.subs) s.dispose();
  }
}
