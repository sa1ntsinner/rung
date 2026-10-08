// SPDX-License-Identifier: MIT
// rung tests in VS Code's test explorer: one item per tests/**/*.test.yaml and one per case, run with
// `rung test --json` on the offline simulator; a failed expectation shows on the line of its step.
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import * as vscode from "vscode";
import { addLcov } from "./core/lcov";
import { blockOf, casesIn, failureText, parseResults, type FileResult } from "./core/testItems";
import { debugCase } from "./debug";
import type { RungCli } from "./runner/cli";
import type { RungWorkspace } from "./workspace";

export class RungTests implements vscode.Disposable {
  private readonly ctrl = vscode.tests.createTestController("rung", "rung tests (offline simulator)");
  /** the block each test file tests, by file id */
  private readonly blocks = new Map<string, string>();
  private readonly blocksChanged = new vscode.EventEmitter<void>();
  /** a test file came, went or names another block */
  readonly onDidChangeBlocks = this.blocksChanged.event;
  private readonly reported = new vscode.EventEmitter<{ file: string; running: number[]; cases?: FileResult["cases"]; error?: string }>();
  /** a run started (running: the cases' places) or ended with results, per file */
  readonly onDidReport = this.reported.event;
  private readonly subs: vscode.Disposable[] = [this.ctrl, this.blocksChanged, this.reported];
  /** the lines of the last coverage run, by file */
  private details = new Map<string, vscode.StatementCoverage[]>();

  constructor(
    private readonly ws: RungWorkspace,
    private readonly cli: RungCli,
  ) {
    this.ctrl.resolveHandler = async (item) => {
      if (!item) await this.discover();
      else await this.refresh(item);
    };
    this.ctrl.refreshHandler = () => this.discover();
    this.ctrl.createRunProfile("Run", vscode.TestRunProfileKind.Run, (request, token) => this.run(request, token), true);
    // which SCL lines the cases ran (rung test --coverage), shown in the editor and the Test Coverage view
    const coverage = this.ctrl.createRunProfile("Coverage", vscode.TestRunProfileKind.Coverage, (request, token) => this.run(request, token, true), true);
    coverage.loadDetailedCoverage = async (_run, file) => this.details.get(file.uri.toString()) ?? [];
    // one case at a time: the first case picked (a file: its first case), stopped at its first statement
    this.ctrl.createRunProfile("Debug", vscode.TestRunProfileKind.Debug, (request) => this.debug(request), true);
    const watcher = vscode.workspace.createFileSystemWatcher("**/tests/**/*.test.{yaml,yml}");
    const ours = (uri: vscode.Uri) => this.idOf(uri).startsWith("tests/");
    watcher.onDidCreate((uri) => ours(uri) && void this.add(uri));
    watcher.onDidChange((uri) => ours(uri) && void this.add(uri));
    watcher.onDidDelete((uri) => {
      this.ctrl.items.delete(this.idOf(uri));
      if (this.blocks.delete(this.idOf(uri))) this.blocksChanged.fire();
    });
    this.subs.push(watcher);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  /** Whether some test file tests a block of this name. */
  hasTests(block: string): boolean {
    const b = block.toLowerCase();
    for (const v of this.blocks.values()) if (v === b) return true;
    return false;
  }

  /** tests/…/x.test.yaml, relative to the rung workspace, as rung test names the file. */
  private idOf(uri: vscode.Uri): string {
    return relative(this.ws.root ?? "", uri.fsPath).split(sep).join("/");
  }

  /** Runs one case of a file (or the whole file) through the test explorer, as if picked there. */
  async runIn(uri: vscode.Uri, caseIndex?: number): Promise<void> {
    const file = await this.add(uri);
    let item = caseIndex === undefined ? file : file.children.get(`${file.id}#${caseIndex}`);
    // a case the explorer's quick reading did not list (cases written as [ … ]): rung test knows it
    if (!item && caseIndex !== undefined) {
      item = this.ctrl.createTestItem(`${file.id}#${caseIndex}`, `case ${caseIndex + 1}`, uri);
      file.children.add(item);
    }
    if (!item) return;
    await this.run(new vscode.TestRunRequest([item]), new vscode.CancellationTokenSource().token);
  }

  private async debug(request: vscode.TestRunRequest): Promise<void> {
    let item = request.include?.[0];
    if (!item?.uri) return;
    if (!item.parent) {
      await this.refresh(item);
      let first: vscode.TestItem | undefined;
      item.children.forEach((c) => void (first ??= c));
      if (!first) return void vscode.window.showWarningMessage(`${item.label} has no cases to debug.`);
      item = first;
    }
    await debugCase(this.ws, item.uri!, Number(item.id.slice(item.id.lastIndexOf("#") + 1)), item.label);
  }

  /** The lines of a file as the last coverage run counted them. */
  coverageOf(uri: vscode.Uri): readonly vscode.StatementCoverage[] | undefined {
    return this.details.get(uri.toString());
  }

  discoverNow(): Promise<void> {
    return this.discover();
  }

  private async discover(): Promise<void> {
    if (!this.ws.root) return;
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(this.ws.root, "tests/**/*.test.{yaml,yml}"));
    const seen = new Set<string>();
    for (const uri of files) seen.add((await this.add(uri)).id);
    this.ctrl.items.forEach((item) => {
      if (!seen.has(item.id)) this.ctrl.items.delete(item.id);
    });
  }

  private async add(uri: vscode.Uri): Promise<vscode.TestItem> {
    const id = this.idOf(uri);
    let item = this.ctrl.items.get(id);
    if (!item) {
      item = this.ctrl.createTestItem(id, id.replace(/^tests\//, ""), uri);
      item.canResolveChildren = true;
      this.ctrl.items.add(item);
    }
    await this.refresh(item);
    return item;
  }

  /** The cases of one file, as its text lists them now. */
  private async refresh(file: vscode.TestItem): Promise<void> {
    if (!file.uri) return;
    const text = await readFile(file.uri.fsPath, "utf8").catch(() => "");
    const block = blockOf(text)?.toLowerCase();
    if (this.blocks.get(file.id) !== block) {
      if (block) this.blocks.set(file.id, block);
      else this.blocks.delete(file.id);
      this.blocksChanged.fire();
    }
    const items = casesIn(text).map((c, i) => {
      const t = this.ctrl.createTestItem(`${file.id}#${i}`, c.name, file.uri);
      t.range = new vscode.Range(c.line, 0, c.line, 0);
      return t;
    });
    file.children.replace(items);
  }

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken, coverage = false): Promise<void> {
    if (!this.ws.root) return;
    const run = this.ctrl.createTestRun(request);
    const lines = new Map<string, Map<number, number>>();
    // which files, and in them which cases (all when the file itself was asked for)
    const wanted = new Map<string, { file: vscode.TestItem; cases?: Set<string> }>();
    const want = (item: vscode.TestItem) => {
      const file = item.parent ?? item;
      const w = wanted.get(file.id);
      if (!item.parent) wanted.set(file.id, { file }); // the whole file
      else if (!w || w.cases) wanted.set(file.id, { file, cases: new Set([...(w?.cases ?? []), item.id]) });
    };
    if (request.include) request.include.forEach(want);
    else this.ctrl.items.forEach(want);
    const excluded = new Set((request.exclude ?? []).map((e) => e.id));
    const whole = !request.include && !excluded.size;
    const shown = (w: { file: vscode.TestItem; cases?: Set<string> }, id: string) => !excluded.has(id) && (!w.cases || w.cases.has(id));
    for (const w of wanted.values()) w.file.children.forEach((c) => shown(w, c.id) && run.enqueued(c));

    // everything: one run; a whole file: --filter on its path; picked cases: each exactly (--case file#n), so a case
    // nobody asked for never runs
    const runs: { file?: string; args: string[] }[] = whole
      ? [{ args: [] }]
      : [...wanted.values()].flatMap((w) =>
          w.cases
            ? [...w.cases].filter((id) => !excluded.has(id)).map((id) => ({ file: w.file.id, args: ["--case", id] }))
            : [{ file: w.file.id, args: ["--filter", w.file.id] }],
        );
    for (const one of runs) {
      if (token.isCancellationRequested) break;
      const mine = (w: { file: vscode.TestItem }) => !one.file || w.file.id === one.file;
      const started = (id: string) => one.args[0] !== "--case" || one.args[1] === id;
      for (const w of wanted.values()) if (mine(w)) w.file.children.forEach((c) => shown(w, c.id) && started(c.id) && run.started(c));
      for (const w of wanted.values())
        if (mine(w)) {
          const running: number[] = [];
          w.file.children.forEach((c) => {
            if (shown(w, c.id) && started(c.id)) running.push(Number(c.id.slice(c.id.lastIndexOf("#") + 1)));
          });
          this.reported.fire({ file: w.file.id, running });
        }
      const lcov = coverage ? join(tmpdir(), `rung-coverage-${process.pid}-${Date.now()}.info`) : undefined;
      const r = await this.cli.capture(["test", "--json", ...one.args, ...(lcov ? ["--coverage", lcov] : [])], { quiet: true, token });
      if (lcov) {
        addLcov(await readFile(lcov, "utf8").catch(() => ""), lines);
        await rm(lcov, { force: true }).catch(() => undefined);
      }
      const results = parseResults(r.output);
      if (!results) {
        for (const w of wanted.values()) if (mine(w)) this.reported.fire({ file: w.file.id, running: [], error: "rung test did not answer" });
        const message = new vscode.TestMessage(`rung test did not answer (exit ${r.code ?? "killed"}); see the rung output`);
        for (const w of wanted.values()) if (mine(w)) run.errored(w.file, message);
        continue;
      }
      for (const f of results) {
        const w = wanted.get(f.file);
        if (w && mine(w)) this.report(run, w, f, shown, one.args[0] !== "--case");
      }
    }
    if (coverage) {
      this.details = new Map();
      for (const [path, counts] of lines) {
        const uri = vscode.Uri.file(join(this.ws.root, path));
        const details = [...counts].sort((a, b) => a[0] - b[0]).map(([line, n]) => new vscode.StatementCoverage(n, new vscode.Position(line - 1, 0)));
        this.details.set(uri.toString(), details);
        run.addCoverage(vscode.FileCoverage.fromDetails(uri, details));
      }
    }
    run.end();
  }

  private report(run: vscode.TestRun, w: { file: vscode.TestItem; cases?: Set<string> }, f: FileResult, shown: (w: { file: vscode.TestItem; cases?: Set<string> }, id: string) => boolean, allCases: boolean) {
    const uri = w.file.uri!;
    this.reported.fire({ file: w.file.id, running: [], cases: f.cases, ...(f.error ? { error: f.error } : {}) });
    if (f.error) {
      run.errored(w.file, new vscode.TestMessage(f.error));
      return;
    }
    // rung's reading of the file is the one that counts: names and lines as it ran them, each case at its own place
    const items = f.cases.map((c, i) => {
      const id = `${w.file.id}#${c.index ?? i}`;
      const t = w.file.children.get(id) ?? this.ctrl.createTestItem(id, c.name, uri);
      t.label = c.name;
      if (c.line) t.range = new vscode.Range(c.line - 1, 0, c.line - 1, 0);
      return t;
    });
    // a run of the whole file lists its cases anew; a run of one case changes only that case
    if (allCases) w.file.children.replace(items);
    else for (const t of items) w.file.children.add(t);
    f.cases.forEach((c, i) => {
      const item = items[i]!;
      if (!shown(w, item.id)) return;
      if (c.passed) return run.passed(item, c.ms);
      const at = (line?: number) => new vscode.Location(uri, new vscode.Position(Math.max(0, (line ?? c.line ?? 1) - 1), 0));
      if (c.error) {
        const m = new vscode.TestMessage(c.errorStep ? `step ${c.errorStep}: ${c.error}` : c.error);
        m.location = at(c.errorLine);
        return run.failed(item, m, c.ms);
      }
      const messages = c.failures.map((x) => {
        const t = failureText(x);
        const m = vscode.TestMessage.diff(t.message, t.expected, t.actual);
        m.location = at(x.line);
        return m;
      });
      run.failed(item, messages, c.ms);
    });
  }
}

/** Test explorer for the workspace's rung tests, when the folder has any. */
export function registerTests(context: vscode.ExtensionContext, ws: RungWorkspace, cli: RungCli): RungTests | undefined {
  if (!ws.root) return undefined;
  const tests = new RungTests(ws, cli);
  context.subscriptions.push(tests);
  // the explorer reads the files when it is opened; Create test needs to know them before
  void tests.discoverNow();
  return tests;
}
