// SPDX-License-Identifier: MIT
// "Why?" while debugging a test case: why a value is what it is. The statement that last wrote it, the values its
// operands had then (each explained in turn), the IF/CASE branch that made it run; from `rung debug`'s rungWhy.
import * as vscode from "vscode";
import { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";

export interface WhyNode {
  kind: "value" | "write" | "condition" | "note";
  text: string;
  value?: string;
  at?: { uri: string; line: number; time?: number };
  children: WhyNode[];
}

const ICON: Record<WhyNode["kind"], string> = { value: "symbol-variable", write: "edit", condition: "git-compare", note: "info" };

/** The answer as a Markdown list, for a report or a ticket: each statement with its file and line. */
export function whyMarkdown(root: WhyNode, note?: string): string {
  const lines: string[] = [];
  const walk = (n: WhyNode, depth: number) => {
    const where = n.at ? ` (${vscode.workspace.asRelativePath(vscode.Uri.parse(n.at.uri))}:${n.at.line}${n.at.time !== undefined ? `, t = ${n.at.time} ms` : ""})` : "";
    const text = n.kind === "value" ? `**\`${n.text}\`** = \`${n.value ?? "?"}\`` : n.kind === "write" ? `← \`${n.text}\`${where}` : n.kind === "condition" ? `because \`${n.text}\`${n.value ? ` → ${n.value}` : ""}` : n.text;
    lines.push(`${"  ".repeat(depth)}- ${text}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return `${lines.join("\n")}\n${note ? `\n_${note}_\n` : ""}`;
}

export class WhyView implements vscode.TreeDataProvider<WhyNode>, vscode.Disposable {
  captured?: () => { uri: string; identity: object; ask: (expression: string) => Promise<WhyNode | undefined> } | undefined;
  private captureShown?: object;
  private root?: WhyNode;
  private readonly changed = new vscode.EventEmitter<WhyNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<WhyNode>;
  /** the same answers in the rung sidebar, for Why? on a running PLC (outside a debug session) */
  private readonly panel: vscode.TreeView<WhyNode>;
  private readonly subs: vscode.Disposable[] = [this.changed];

  constructor(
    private readonly ws?: RungWorkspace,
    private readonly cli?: RungCli,
  ) {
    this.view = vscode.window.createTreeView("rung.why", { treeDataProvider: this, showCollapseAll: true });
    this.panel = vscode.window.createTreeView("rung.whyLive", { treeDataProvider: this, showCollapseAll: true });
    this.subs.push(
      this.view,
      this.panel,
      vscode.commands.registerCommand("rung.why", (arg?: unknown) => this.ask(arg)),
      vscode.commands.registerCommand("rung.why.open", (n: WhyNode) => n?.at && this.open(n.at)),
      vscode.commands.registerCommand("rung.why.copy", async () => {
        if (!this.root) return undefined;
        const md = whyMarkdown(this.root, this.panel.message ?? this.view.message);
        await vscode.env.clipboard.writeText(md);
        void vscode.window.setStatusBarMessage("Why? copied as Markdown", 3000);
        return md;
      }),
      // a new stop makes the answer old: it says so instead of showing stale values as current
      vscode.debug.onDidChangeActiveStackItem(() => {
        if (this.root) this.view.message = "The debugger moved on: run Why? again for the values here.";
      }),
      vscode.debug.onDidTerminateDebugSession(() => this.show(undefined)),
    );
  }

  /** The answer last shown (tests). */
  get shown(): WhyNode | undefined {
    return this.root;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  private show(root: WhyNode | undefined, message?: string) {
    this.captureShown = undefined;
    this.root = root;
    this.view.message = message;
    this.panel.message = message;
    void vscode.commands.executeCommand("setContext", "rung.why.shown", !!root || !!message);
    this.changed.fire(undefined);
  }

  invalidateCapture(): void {
    if (this.captureShown && this.captured?.()?.identity !== this.captureShown) this.show(undefined, "The capture or source changed: run Why? again.");
  }

  /** Why? on the running PLC (or rung simulate): the block's writers with the values read now (rung why). */
  private async askLive(arg?: unknown): Promise<WhyNode | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "scl" || !this.ws?.root || !this.cli) {
      void vscode.window.showInformationMessage("Why? works in an SCL block (with the PLC's values through [live.webapi], or rung simulate), or while debugging a test case.");
      return undefined;
    }
    const captured = this.captured?.();
    const selected = !editor.selection.isEmpty ? editor.document.getText(editor.selection) : editor.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active, /#?"?[A-Za-z_][\w."[\]]*"?/));
    const expression = typeof arg === "string" ? arg : await vscode.window.showInputBox({ title: "Why is this value what it is?", prompt: "A variable of this block, e.g. #Running or \"Plant\".Ready", value: selected ?? "" });
    if (!expression) return undefined;
    if (captured?.uri === editor.document.uri.toString()) {
      const tree = await captured.ask(expression);
      this.show(tree, tree ? "Recorded reconstruction; PLC execution unverified." : "Captured reconstruction unavailable or changed.");
      this.captureShown = tree ? this.captured?.()?.identity : undefined;
      await vscode.commands.executeCommand("rung.whyLive.focus");
      return tree;
    }
    const ask = async (instance?: string) => {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "rung: why?" }, () => this.cli!.capture(["why", editor.document.uri.fsPath, expression, "--json", ...(instance ? ["--instance", instance] : [])], { quiet: true }));
      return JSON.parse(r.output) as { source: string; tree: WhyNode };
    };
    try {
      let a = await ask();
      // an FB with several instances: read through the one the engineer means
      const several = /has \d+ instance DBs \(([^)]*)\); choose one/.exec(a.source);
      if (several) {
        const pick = await vscode.window.showQuickPick(several[1]!.split(", "), { title: "Read the values through which instance?" });
        if (pick) a = await ask(pick);
      }
      this.show(a.tree, a.source);
      await vscode.commands.executeCommand("rung.whyLive.focus");
      return a.tree;
    } catch (e) {
      this.show(undefined, `Why? ${expression}: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Why? for a variable (from the Variables view), the selection in an editor, or a name typed in. */
  async ask(arg?: unknown): Promise<WhyNode | undefined> {
    const session = vscode.debug.activeDebugSession;
    if (session?.type !== "rung") return this.askLive(arg);
    const fromVariables = arg && typeof arg === "object" && "variable" in arg ? (arg as { variable: { evaluateName?: string; name: string } }).variable : undefined;
    const editor = vscode.window.activeTextEditor;
    const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : editor ? editor.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active, /#?"?[A-Za-z_][\w."[\]]*"?/)) : undefined;
    const expression = typeof arg === "string" ? arg : fromVariables ? (fromVariables.evaluateName ?? fromVariables.name) : await vscode.window.showInputBox({ title: "Why is this value what it is?", prompt: "A variable, e.g. #Running or \"Plant\".Ready", value: selected ?? "" });
    if (!expression) return undefined;
    const frameId = (vscode.debug.activeStackItem as vscode.DebugStackFrame | undefined)?.frameId ?? 0;
    try {
      const root = (await session.customRequest("rungWhy", { expression, frameId, depth: 3 })) as WhyNode;
      this.show(root);
      await vscode.commands.executeCommand("rung.why.focus");
      return root;
    } catch (e) {
      this.show(undefined, `Why? ${expression}: ${(e as Error).message}`);
      return undefined;
    }
  }

  private async open(at: { uri: string; line: number }) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(at.uri));
    const line = Math.max(0, at.line - 1);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preserveFocus: false });
  }

  getChildren(n?: WhyNode): WhyNode[] {
    return n ? n.children : this.root ? [this.root] : [];
  }

  getTreeItem(n: WhyNode): vscode.TreeItem {
    const label = n.kind === "value" ? `${n.text} = ${n.value ?? "?"}` : n.kind === "condition" ? n.text : n.text;
    const item = new vscode.TreeItem(label, n.children.length ? (n.kind === "note" ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded) : vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(ICON[n.kind]);
    if (n.kind === "write" && n.at) item.description = n.at.time !== undefined ? `line ${n.at.line} · t = ${n.at.time} ms` : `line ${n.at.line}`;
    if (n.kind === "condition") item.description = n.value;
    if (n.kind === "write") item.tooltip = "The statement that last wrote it before this point; its operands below are as they were just before it ran.";
    if (n.kind === "note") item.tooltip = n.text;
    if (n.at) item.command = { command: "rung.why.open", title: "Open", arguments: [n] };
    return item;
  }
}
