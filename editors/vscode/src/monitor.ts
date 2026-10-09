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
import { lineText, reconstructedLines, type MonitorPlan } from "./core/monitorText";
import type { LiveAccess } from "./liveAccess";
import type { LiveFrame } from "./core/liveFrames";
import type { WhyNode } from "./views/whyView";

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
  programStatus?: LiveFrame["programStatus"];
  nativeLines?: Record<number, string>;
}

export class Monitor implements vscode.Disposable {
  private session: Session | undefined;
  private replay?: { uri: vscode.Uri; lines: Record<number, string>; hover: string; capture: vscode.Uri; instance: string };
  private replayPending = false;
  private replayScope?: string;
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
    const sources = vscode.workspace.createFileSystemWatcher("**/*.{scl,db,udt,awl,st,s7dcl,TcPOU,TcDUT,TcGVL,xml,sd,yaml}");
    const sourceChanged = (uri: vscode.Uri) => {
      if ((this.replayPending || this.replay || this.session?.programStatus?.kind === "reconstructed") && ws.rel(uri.fsPath)) void this.stop("a workspace source changed");
    };
    this.subs.push(
      sources, sources.onDidChange(sourceChanged), sources.onDidCreate(sourceChanged), sources.onDidDelete(sourceChanged),
      ws.onDidChange(() => { if ((this.replayPending || this.replay) && this.replayScope !== this.access.scope || this.session && this.session.workspace !== this.access.scope) void this.stop("the workspace or live target changed"); }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
      // TIA Portal stops monitoring when the block is edited; so does rung (the lines no longer match)
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length && ((this.replayPending || this.replay || this.session?.programStatus?.kind === "reconstructed") && ws.rel(e.document.uri.fsPath) || this.session && e.document.uri.toString() === this.session.uri.toString())) void this.stop("the source was edited");
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if ((this.replay?.uri ?? this.session?.uri)?.toString() === d.uri.toString()) void this.stop();
      }),
    );
  }

  get monitoring(): vscode.Uri | undefined {
    return this.replay?.uri ?? this.session?.uri;
  }

  get captured(): { uri: string; identity: object; ask: (expression: string) => Promise<WhyNode | undefined> } | undefined {
    const replay = this.replay, generation = this.generation;
    if (replay) return { uri: replay.uri.toString(), identity: replay, ask: expression => generation === this.generation
      ? this.reconstruct(replay.uri, replay.capture, replay.instance, expression) : Promise.resolve(undefined) };
    const session = this.session, status = session?.programStatus;
    if (status?.kind !== "reconstructed" || session?.state !== "live") return;
    return { uri: session.uri.toString(), identity: status, ask: async expression => this.session === session && generation === this.generation
      && session.programStatus === status && session.state === "live" ? status.why?.[expression.replace(/^#/, "").toUpperCase()] : undefined };
  }

  async reconstruct(uri?: vscode.Uri, capture?: vscode.Uri, instance?: string, why?: string): Promise<WhyNode | undefined> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || !this.ws.rel(target.fsPath)) return;
    await this.stop();
    const generation = this.generation;
    this.replayPending = true;
    this.replayScope = this.access.scope;
    try {
      const dirty = () => vscode.workspace.textDocuments.some(d => d.isDirty && this.ws.rel(d.uri.fsPath));
      if (dirty()) { void vscode.window.showWarningMessage("Save or revert workspace sources before reconstructing a capture."); return; }
      const selected = capture ?? (await vscode.window.showOpenDialog({ title: "Open a pre/post-cycle capture", canSelectMany: false, filters: { "Cycle capture": ["json"] } }))?.[0];
      const db = instance ?? (selected && await vscode.window.showInputBox({ title: "Instance DB in the capture", prompt: "Choose the DB whose pre-cycle memory was captured" }));
      if (!selected || !db || generation !== this.generation || dirty()) return;
      const version = vscode.workspace.textDocuments.find(d => d.uri.toString() === target.toString())?.version;
      const run = await this.cli.capture(["program-status", target.fsPath, "--capture", selected.fsPath, "--instance", db, "--json", ...(why ? ["--why", why] : [])], { timeoutMs: 15_000, quiet: true });
      if (generation !== this.generation || dirty() || version !== vscode.workspace.textDocuments.find(d => d.uri.toString() === target.toString())?.version) return;
      if (run.output.length > 3_145_728 || run.code !== 0 && run.code !== 2) throw new Error(RungCli.summary(run.output));
      const result: unknown = JSON.parse(run.output);
      const lines = reconstructedLines(result, target.toString());
      const details = result as { scope: unknown; coherence: unknown; divergences: unknown[]; why?: WhyNode };
      this.replay = { uri: target, lines, capture: selected, instance: db, hover: "Historical reconstruction; PLC execution unverified.\n" + JSON.stringify({ scope: details.scope,
        coherence: details.coherence, divergences: details.divergences.slice(0, 20) }, null, 2).slice(0, 16_384) };
      void vscode.commands.executeCommand("setContext", "rung.monitoring", true);
      this.render(); this.changed.fire();
      return details.why;
    } catch (error) { void vscode.window.showWarningMessage(`Reconstruction unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    finally { if (generation === this.generation) this.replayPending = false; }
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
        const previous = s.programStatus;
        s.programStatus = m.programStatus;
        s.nativeLines = undefined;
        if (s.programStatus?.kind === "reconstructed") {
          const status = s.programStatus;
          if (status.freshness !== "native-sample" || status.coherence !== "subscription-sample"
            || !Number.isSafeInteger(status.observedAt) || status.observedAt <= 0 || !Number.isSafeInteger(status.sequence) || status.sequence < 0
            || m.state !== "live" || !m.scope || status.scope?.plc !== m.scope.device || status.scope?.epoch !== m.scope.epoch
            || s.plan?.instance && status.scope.instance.replace(/^"|"$/g, "") !== s.plan.instance.replace(/^"|"$/g, "")
            || vscode.workspace.textDocuments.some(d => d.isDirty && this.ws.rel(d.uri.fsPath))) s.programStatus = undefined;
          else {
            try {
              s.nativeLines = reconstructedLines(status, s.uri.toString());
              if (previous?.kind === "reconstructed" && previous.observedAt === status.observedAt && previous.sequence === status.sequence
                && previous.scope.epoch === status.scope.epoch && previous.scope.plc === status.scope.plc && previous.scope.instance === status.scope.instance)
                s.programStatus = previous;
            }
            catch { s.programStatus = undefined; }
          }
        }
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
      if (this.replay && ed.document.uri.toString() === this.replay.uri.toString()) {
        ed.setDecorations(this.deco, Object.entries(this.replay.lines).flatMap(([line, text]) => {
          const n = Number(line); if (n >= ed.document.lineCount) return [];
          const end = ed.document.lineAt(n).range.end;
          return [{ range: new vscode.Range(end, end), hoverMessage: this.replay!.hover, renderOptions: { after: { contentText: text } } }];
        }));
        continue;
      }
      if (s?.nativeLines && ed.document.uri.toString() === s.uri.toString()) {
        ed.setDecorations(this.deco, Object.entries(s.nativeLines).flatMap(([line, text]) => {
          const n = Number(line); if (n >= ed.document.lineCount) return [];
          const end = ed.document.lineAt(n).range.end;
          return [{ range: new vscode.Range(end, end), hoverMessage: s.programStatus?.reason ?? "Native subscription sample; PLC execution unverified", renderOptions: { after: { contentText: text } } }];
        }));
        continue;
      }
      if (!s?.plan || ed.document.uri.toString() !== s.uri.toString()) {
        ed.setDecorations(this.deco, []);
        continue;
      }
      const opts: vscode.DecorationOptions[] = [];
      for (const [line, labels] of Object.entries(s.plan.lines)) {
        const n = Number(line);
        if (n >= ed.document.lineCount) continue;
        const end = ed.document.lineAt(n).range.end;
        opts.push({ range: new vscode.Range(end, end), hoverMessage: `${s.scope ? `${s.scope.device} · ${s.scope.transport} · ${s.scope.address}\n` : ""}${s.programStatus?.reason ?? ""}\n${labels.map(name => s.errors[name]).filter(Boolean).join("\n")}`, renderOptions: { after: { contentText: lineText(labels, s.values, s.errors, s.display) } } });
      }
      ed.setDecorations(this.deco, opts);
    }
  }

  private clear(): void {
    for (const ed of vscode.window.visibleTextEditors) ed.setDecorations(this.deco, []);
  }

  async stop(why?: string): Promise<void> {
    this.generation++;
    this.replayPending = false;
    if (this.replay) { this.replay = undefined; this.clear(); void vscode.commands.executeCommand("setContext", "rung.monitoring", false); this.changed.fire(); }
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
