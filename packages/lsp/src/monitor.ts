// SPDX-License-Identifier: BUSL-1.1
import { CodeActionKind, type CodeAction, type InlayHint, type Range } from "vscode-languageserver/node.js";
import type { WorkspaceIndex } from "./workspace.js";
import { lineText } from "./monitorText.js";

export interface MonitorPlan {
  block: string;
  instance?: string;
  vars: Record<string, string>;
  lines: Record<number, string[]>;
}

export interface MonitorValues {
  values: Record<string, unknown>;
  errors: Record<string, string>;
  display?: Record<string, string>;
}

export interface MonitorReader {
  read(): Promise<MonitorValues>;
  subscribe?(onValues: (values: MonitorValues) => void): () => void;
  close(): Promise<void>;
}

export interface MonitorProvider {
  plan(index: WorkspaceIndex, uri: string, instance?: string): MonitorPlan;
  instances(index: WorkspaceIndex, uri: string): string[];
  open(uri: string, plan: MonitorPlan): Promise<MonitorReader>;
  error?(error: unknown): string;
}

export const MONITOR_COMMAND = "rung.lsp.monitor";
export const STOP_MONITOR_COMMAND = "rung.lsp.stopMonitoring";

interface Session {
  uri: string;
  plan?: MonitorPlan;
  opening?: Promise<MonitorReader>;
  reader?: MonitorReader;
  latest?: MonitorValues;
  reading?: Promise<MonitorValues>;
  timer?: NodeJS.Timeout;
  unsubscribe?: () => void;
}

export class Monitoring {
  private session?: Session;
  private readonly closing = new Set<Promise<void>>();

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly provider: MonitorProvider,
    private readonly refresh: () => void,
    private readonly showError: (message: string) => void,
  ) {}

  actions(uri: string): CodeAction[] {
    if (this.session?.uri === uri) return [this.action("Stop monitoring", STOP_MONITOR_COMMAND, uri)];
    try {
      const instances = this.provider.instances(this.index, uri);
      if (instances.length > 1)
        return instances.filter((instance) => this.hasValues(uri, instance)).map((instance) => this.action(
          'Monitor values through ' + (instance.startsWith('"') ? instance : '"' + instance + '"'), MONITOR_COMMAND, uri, instance,
        ));
      return this.hasValues(uri) ? [this.action("Monitor values", MONITOR_COMMAND, uri)] : [];
    } catch {
      return [];
    }
  }

  private hasValues(uri: string, instance?: string): boolean {
    return Object.keys(this.provider.plan(this.index, uri, instance).vars).length > 0;
  }

  private action(title: string, command: string, uri: string, instance?: string): CodeAction {
    return { title, kind: CodeActionKind.Empty, command: { title, command, arguments: [uri, ...(instance ? [instance] : [])] } };
  }

  async start(uri: string, instance?: string): Promise<void> {
    this.stop();
    const session: Session = { uri };
    this.session = session;
    try {
      const plan = this.provider.plan(this.index, uri, instance);
      if (!Object.keys(plan.vars).length) throw new Error("this block has no values to monitor");
      session.opening = this.provider.open(uri, plan);
      const reader = await session.opening;
      if (this.session !== session) return; // stop() closes it
      session.plan = plan;
      session.reader = reader;
      if (reader.subscribe) session.unsubscribe = reader.subscribe((latest) => {
        if (this.session !== session) return;
        session.latest = latest;
        this.refresh();
      });
      else await this.read(session);
    } catch (error) {
      this.failed(session, error);
    }
  }

  private async read(session: Session): Promise<void> {
    try {
      session.reading = session.reader!.read();
      const latest = await session.reading;
      if (this.session !== session) return;
      session.latest = latest;
      this.refresh();
      session.timer = setTimeout(() => void this.read(session), 500);
    } catch (error) {
      this.failed(session, error);
    }
  }

  private failed(session: Session, error: unknown): void {
    if (this.session !== session) return;
    this.stop();
    this.showError(this.provider.error?.(error) ?? (error instanceof Error ? error.message : String(error)));
  }

  stop(uri?: string, refresh = true): void {
    const session = this.session;
    if (!session || (uri && session.uri !== uri)) return;
    this.session = undefined;
    clearTimeout(session.timer);
    session.unsubscribe?.();
    const closed = this.close(session).catch(() => undefined);
    this.closing.add(closed);
    void closed.then(() => this.closing.delete(closed));
    if (refresh) this.refresh();
  }

  /** An open or a read may still be logging in: close once they settle, so that login is logged out too. */
  private async close(session: Session): Promise<void> {
    const reader = await session.opening?.catch(() => undefined);
    await session.reading?.catch(() => undefined);
    await reader?.close();
  }

  /** Every stopped session closed, or `ms` passed (a PLC that does not answer must not hold up the editor). */
  async closed(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(this.closing), new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
  }

  hints(uri: string, range: Range): InlayHint[] {
    const session = this.session;
    const doc = this.index.docs.get(uri);
    if (session?.uri !== uri || !session.plan || !session.latest || !doc) return [];
    const lines = doc.text.split(/\r?\n/);
    return Object.entries(session.plan.lines).flatMap(([line, labels]) => {
      const n = Number(line);
      if (lines[n] === undefined) return [];
      const position = { line: n, character: lines[n]!.length };
      if (n < range.start.line || n > range.end.line ||
        (n === range.start.line && position.character < range.start.character) ||
        (n === range.end.line && position.character > range.end.character)) return [];
      return [{ position, label: lineText(labels, session.latest!.values, session.latest!.errors, session.latest!.display), paddingLeft: true }];
    });
  }
}
