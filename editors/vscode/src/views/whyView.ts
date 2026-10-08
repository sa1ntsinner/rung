// SPDX-License-Identifier: MIT
// "Why?" while debugging a test case: why a value is what it is. The statement that last wrote it, the values its
// operands had then (each explained in turn), the IF/CASE branch that made it run; from `rung debug`'s rungWhy.
import * as vscode from "vscode";

export interface WhyNode {
  kind: "value" | "write" | "condition" | "note";
  text: string;
  value?: string;
  at?: { uri: string; line: number; time: number };
  children: WhyNode[];
}

const ICON: Record<WhyNode["kind"], string> = { value: "symbol-variable", write: "edit", condition: "git-compare", note: "info" };

export class WhyView implements vscode.TreeDataProvider<WhyNode>, vscode.Disposable {
  private root?: WhyNode;
  private readonly changed = new vscode.EventEmitter<WhyNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<WhyNode>;
  private readonly subs: vscode.Disposable[] = [this.changed];

  constructor() {
    this.view = vscode.window.createTreeView("rung.why", { treeDataProvider: this, showCollapseAll: true });
    this.subs.push(
      this.view,
      vscode.commands.registerCommand("rung.why", (arg?: unknown) => this.ask(arg)),
      vscode.commands.registerCommand("rung.why.open", (n: WhyNode) => n?.at && this.open(n.at)),
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
    this.root = root;
    this.view.message = message;
    this.changed.fire(undefined);
  }

  /** Why? for a variable (from the Variables view), the selection in an editor, or a name typed in. */
  async ask(arg?: unknown): Promise<WhyNode | undefined> {
    const session = vscode.debug.activeDebugSession;
    if (session?.type !== "rung") {
      void vscode.window.showInformationMessage("Why? works while debugging a test case (Debug Test in the test explorer).");
      return undefined;
    }
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
    if (n.kind === "write" && n.at) item.description = `line ${n.at.line} · t = ${n.at.time} ms`;
    if (n.kind === "condition") item.description = n.value;
    if (n.kind === "write") item.tooltip = "The statement that last wrote it before this point; its operands below are as they were just before it ran.";
    if (n.kind === "note") item.tooltip = n.text;
    if (n.at) item.command = { command: "rung.why.open", title: "Open", arguments: [n] };
    return item;
  }
}
