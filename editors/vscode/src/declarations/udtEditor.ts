// SPDX-License-Identifier: MIT
// A UDT file opened as a table (Open With… → UDT Table): the declarations view on that one document, as its editor.
// The text stays the file: every edit is a text edit of it, saved, undone and redone as VS Code does for any text.
import * as vscode from "vscode";
import type { Lsp } from "../lsp";
import type { RungWorkspace } from "../workspace";
import { declarationsHtml, declarationsOptions } from "./panel";
import { DeclarationsSession } from "./session";

export const UDT_TABLE = "rung.udtTable";

export class UdtTableEditor implements vscode.CustomTextEditorProvider {
  /** the open tables by document (for the integration tests) */
  static readonly sessions = new Map<string, DeclarationsSession>();

  static register(ctx: vscode.ExtensionContext, deps: { lsp: Lsp; ws: RungWorkspace }): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(UDT_TABLE, new UdtTableEditor(ctx, deps), { webviewOptions: { retainContextWhenHidden: false } });
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly deps: { lsp: Lsp; ws: RungWorkspace },
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const uri = document.uri.toString();
    panel.webview.options = declarationsOptions(this.ctx);
    const session = new DeclarationsSession(panel.webview, this.deps, {
      uri: () => uri,
      position: () => undefined,
      visible: () => panel.visible,
      title: () => undefined,
      pinned: () => undefined,
      focus: () => panel.reveal(panel.viewColumn, false),
      // this view is the document's editor: VS Code's undo applies to it as it is
      undo: (kind) => vscode.commands.executeCommand(kind),
    });
    panel.webview.html = declarationsHtml(this.ctx, panel.webview);
    UdtTableEditor.sessions.set(uri, session);
    const subs = [
      session,
      panel.onDidChangeViewState((e) => {
        if (!e.webviewPanel.visible) session.hidden();
      }),
    ];
    panel.onDidDispose(() => {
      if (UdtTableEditor.sessions.get(uri) === session) UdtTableEditor.sessions.delete(uri);
      for (const s of subs) s.dispose();
    });
  }
}
