// SPDX-License-Identifier: MIT
// A test file opened as a table (Open as Table, or Open With… → Test Table): cases, steps and their values, edited
// as minimal text edits of the file (planned by the language server, rung/testEdit), run through the test explorer.
// The text stays the file: saved, undone and redone as VS Code does for any text.
import * as vscode from "vscode";
import { checkPlan, STALE, type Rng, type ServerPlan } from "../declarations/edits";
import { nonce, webviewHtml } from "../host/webviewHtml";
import type { Lsp } from "../lsp";
import { isTestViewToHost, type CaseRun, type Part, type TestFileModel, type TestHostToView, type TestOp, type TestViewToHost } from "../protocol/tests";
import type { RungTests } from "../testing";
import type { RungWorkspace } from "../workspace";

export const TEST_TABLE = "rung.testTable";

/** A value to start with for a name of this type: what rung test accepts for it. */
export function defaultFor(type: string): string {
  const t = type.trim();
  if (/^bool$/i.test(t)) return "false";
  if (/^l?real$/i.test(t)) return "0.0";
  if (/^l?time$/i.test(t)) return "T#0ms";
  if (/^(s|u|us|d|ud|l|ul)?int$|^(byte|word|dword|lword)$/i.test(t)) return "0";
  // empty text: the table writes it as '' (quoting is the language server's)
  if (/^w?(string|char)/i.test(t)) return "";
  return "0";
}

type Deps = { lsp: Lsp; ws: RungWorkspace; tests: () => RungTests | undefined };

class TestTable implements vscode.Disposable {
  private file: TestFileModel | undefined;
  private ready = false;
  private seq = 0;
  private timer: NodeJS.Timeout | undefined;
  /** the last run of each case, by its name (a case's place changes when cases are added or deleted) */
  private runs = new Map<string, CaseRun>();
  /** the view's messages, one after another: Run waits for the edit sent before it */
  private queue: Promise<unknown> = Promise.resolve();
  private running: number[] = [];
  private last: TestHostToView | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly doc: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: Deps,
  ) {
    const uri = doc.uri.toString();
    this.subs.push(
      panel.webview.onDidReceiveMessage((m: unknown) => {
        if (isTestViewToHost(m)) this.queue = this.queue.then(() => this.handle(m)).catch(() => undefined);
      }),
      panel.onDidChangeViewState((e) => {
        if (!e.webviewPanel.visible) this.ready = false;
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === uri) this.schedule(150);
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.toString() === uri) this.schedule(0);
      }),
    );
    const tests = deps.tests();
    if (tests)
      this.subs.push(
        tests.onDidReport((r) => {
          if (!deps.ws.root || vscode.Uri.joinPath(vscode.Uri.file(deps.ws.root), r.file).toString() !== uri) return;
          this.running = r.running;
          if (r.cases) {
            // results of the cases that ran replace theirs; the others keep their last run
            for (const [i, c] of r.cases.entries()) {
              const index = c.index ?? i;
              this.runs.set(c.name, { index, passed: c.passed, ...(c.error ? { error: c.error } : {}), ...(c.errorStep ? { errorStep: c.errorStep } : {}), failures: c.failures.map((x) => ({ step: x.step, name: x.name, expected: x.expected, actual: x.actual })) });
            }
          }
          this.postRuns();
        }),
      );
  }

  /** The model the table shows (for the integration tests). */
  get shown(): TestFileModel | undefined {
    return this.file;
  }

  /** A message as if the table sent it; the answer it would get (for the integration tests). */
  async receive(m: unknown): Promise<TestHostToView | undefined> {
    if (!isTestViewToHost(m)) return undefined;
    await this.queue;
    this.last = undefined;
    const done = this.handle(m);
    this.queue = done.catch(() => undefined);
    await done;
    return this.last;
  }

  private post(m: TestHostToView) {
    this.last = m;
    if (this.ready) void this.panel.webview.postMessage(m);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), ms);
  }

  private async refresh(): Promise<void> {
    if (!this.ready) return;
    const seq = ++this.seq;
    const file = await this.deps.lsp.request<TestFileModel | null>("rung/testModel", { textDocument: { uri: this.doc.uri.toString() } }).catch(() => undefined);
    if (seq !== this.seq) return;
    if (!file) {
      this.post({ v: 1, kind: "state", state: "noServer" });
      // the language server may still be starting, or not have the file yet
      this.schedule(1000);
      return;
    }
    this.file = file;
    const rel = (this.deps.ws.rel(this.doc.uri.fsPath) ?? vscode.workspace.asRelativePath(this.doc.uri)).replace(/\\/g, "/");
    this.post({ v: 1, kind: "model", file, context: { file: rel, dirty: this.doc.isDirty } });
    if (this.runs.size || this.running.length) this.postRuns();
  }

  /** The last runs, placed at the cases' places in the model shown now (a case renamed or deleted has none). */
  private postRuns() {
    const cases = this.file?.model.cases ?? [];
    const runs = cases.flatMap((c) => {
      const r = c.name && this.runs.get(c.name.value);
      return r ? [{ ...r, index: c.index }] : [];
    });
    this.post({ v: 1, kind: "runs", running: this.running, runs });
  }

  private async handle(m: TestViewToHost) {
    switch (m.kind) {
      case "ready":
        this.ready = true;
        await this.refresh();
        return;
      case "edit":
        this.post({ v: 1, kind: "result", req: m.req, ...(await this.apply(m.uri, m.version, m.op)) });
        return;
      case "pick": {
        const r = await this.pick(m.case, m.step, m.part);
        if (!r) return this.post({ v: 1, kind: "result", req: m.req, ok: false });
        this.post({ v: 1, kind: "result", req: m.req, ...(await this.apply(m.uri, m.version, { op: "addEntry", case: m.case, step: m.step, part: m.part, key: r.key, value: r.value })) });
        return;
      }
      case "run": {
        const tests = this.deps.tests();
        if (!tests) return void vscode.window.showWarningMessage("Tests run in a rung workspace (a folder with rung.toml).");
        // the run reads the file on disk: what the table shows is saved first
        if (this.doc.isDirty && !(await this.doc.save())) return;
        await tests.runIn(this.doc.uri, m.case);
        return;
      }
      case "openText": {
        const sel = m.line !== undefined ? new vscode.Range(m.line, 0, m.line, 0) : undefined;
        await vscode.window.showTextDocument(this.doc.uri, { viewColumn: vscode.ViewColumn.Beside, ...(sel ? { selection: sel } : {}) });
        return;
      }
      case "undo":
      case "redo":
        await vscode.commands.executeCommand(m.kind);
        return;
    }
  }

  /** A name of the block under test (or one typed in), and a value that fits its type. */
  private async pick(caseIndex: number, step: number, part: Part): Promise<{ key: string; value: string } | undefined> {
    const taken = new Set((this.file?.model.cases[caseIndex]?.steps[step]?.[part]?.entries ?? []).map((e) => e.key.toLowerCase()));
    const symbols = (this.file?.symbols ?? []).filter((s) => !taken.has(s.name.toLowerCase()));
    type Item = vscode.QuickPickItem & { type?: string };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = part === "set" ? "Set" : "Expect";
    qp.placeholder = "A name of the block, a member (Timer.PT) or a global (\"DB\".x)";
    const base: Item[] = symbols.map((s) => ({ label: s.name, description: s.type, detail: s.section, type: s.type }));
    qp.items = base;
    qp.matchOnDescription = true;
    // a name that is not in the list (an instance's member, a global) is taken as typed
    qp.onDidChangeValue((v) => {
      const typed = v.trim();
      qp.items = typed && !base.some((b) => b.label.toLowerCase() === typed.toLowerCase()) ? [...base, { label: typed, description: "as typed", alwaysShow: true }] : base;
    });
    const picked = await new Promise<Item | undefined>((resolve) => {
      qp.onDidAccept(() => resolve(qp.selectedItems[0]));
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    if (!picked) return undefined;
    return { key: picked.label, value: defaultFor(picked.type ?? "") };
  }

  /** Plans an edit in the language server and applies it, unless the file moved on since the table's model. */
  private async apply(uri: string, version: number, op: TestOp): Promise<{ ok: boolean; reason?: string }> {
    if (uri !== this.doc.uri.toString()) return { ok: false, reason: STALE };
    if (version !== this.doc.version) return { ok: false, reason: STALE };
    return applyTestOp(this.deps.lsp, this.doc, op);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const s of this.subs) s.dispose();
  }
}

/** One edit of a test file, planned by the language server (rung/testEdit) for the document as it is now. */
export async function applyTestOp(lsp: Lsp, doc: vscode.TextDocument, op: TestOp): Promise<{ ok: boolean; reason?: string }> {
  const version = doc.version;
  const plan = await lsp.request<ServerPlan>("rung/testEdit", { textDocument: { uri: doc.uri.toString(), version }, op }).catch(() => undefined);
  const range = (r: Rng) => new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
  const checked = checkPlan({ version: doc.version, getText: (r) => doc.getText(range(r)) }, plan ?? { ok: false, reason: "The language server is not running." });
  if (!checked.ok) return checked;
  if (!checked.edits.length) return { ok: true };
  const edit = new vscode.WorkspaceEdit();
  for (const e of checked.edits) edit.replace(doc.uri, range(e.range), e.newText);
  return (await vscode.workspace.applyEdit(edit)) ? { ok: true } : { ok: false, reason: STALE };
}

export class TestTableEditor implements vscode.CustomTextEditorProvider {
  /** the open tables by document (for the integration tests) */
  static readonly tables = new Map<string, TestTable>();

  static register(ctx: vscode.ExtensionContext, deps: Deps): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(TEST_TABLE, new TestTableEditor(ctx, deps), { webviewOptions: { retainContextWhenHidden: false } });
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly deps: Deps,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const web = panel.webview;
    web.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "out", "webview")] };
    const asset = (f: string) => web.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "out", "webview", f)).toString();
    web.html = webviewHtml({ cspSource: web.cspSource, nonce: nonce(), script: asset("tests.js"), styles: [asset("codicon.css"), asset("tokens.css"), asset("rung.css")], title: "Test" });
    const table = new TestTable(document, panel, this.deps);
    const key = document.uri.toString();
    TestTableEditor.tables.set(key, table);
    panel.onDidDispose(() => {
      if (TestTableEditor.tables.get(key) === table) TestTableEditor.tables.delete(key);
      table.dispose();
    });
  }
}
