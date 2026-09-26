// SPDX-License-Identifier: MIT
// Shared helpers for the integration tests: the extension's API, dialog stubs, CLI capture, tree outlines.
import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { RungExtensionApi } from "../../src/extension";
import type { Finished } from "../../src/runner/cli";

export const EXTENSION_ID = "sa1ntsinner.rung-scl";

export async function rungApi(): Promise<RungExtensionApi> {
  const ext = vscode.extensions.getExtension<RungExtensionApi>(EXTENSION_ID);
  assert.ok(ext, `${EXTENSION_ID} is not loaded`);
  return ext.isActive ? ext.exports : await ext.activate();
}

export function root(): string {
  const f = vscode.workspace.workspaceFolders?.[0];
  assert.ok(f, "no workspace folder");
  return f.uri.fsPath;
}

export const file = (rel: string) => vscode.Uri.file(join(root(), ...rel.split("/")));

export async function waitFor<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 30_000, stepMs = 100): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------- dialogs

export interface DialogCall {
  kind: "info" | "warning" | "error" | "quickPick" | "inputBox" | "openDialog" | "openExternal";
  message: string;
  detail?: string;
  modal?: boolean;
  /** Buttons of a message, or the quick pick items. */
  items: unknown[];
  options?: unknown;
}

type MessageAnswer = (call: DialogCall) => string | undefined | Promise<string | undefined>;
type PickAnswer = (items: readonly vscode.QuickPickItem[], options: vscode.QuickPickOptions | undefined, call: DialogCall) => unknown;
type InputAnswer = (options: vscode.InputBoxOptions | undefined) => string | undefined | Promise<string | undefined>;

/**
 * Replaces the dialogs of vscode.window (the extension shares this API object with the tests) with
 * scripted answers. Unscripted dialogs answer undefined (Esc). Every call is recorded.
 */
export class Dialogs {
  readonly calls: DialogCall[] = [];
  private readonly restore: (() => void)[] = [];
  private messages: MessageAnswer[] = [];
  private picks: PickAnswer[] = [];
  private inputs: InputAnswer[] = [];
  private opens: (vscode.Uri[] | undefined)[] = [];

  install(): void {
    const w = vscode.window as unknown as Record<string, unknown>;
    const replace = (target: Record<string, unknown>, name: string, fn: unknown) => {
      const old = target[name];
      target[name] = fn;
      assert.equal(target[name], fn, `could not stub ${name}`);
      this.restore.push(() => (target[name] = old));
    };
    const message =
      (kind: "info" | "warning" | "error") =>
      async (msg: string, ...rest: unknown[]): Promise<unknown> => {
        let options: vscode.MessageOptions | undefined;
        if (rest[0] && typeof rest[0] === "object" && !("title" in (rest[0] as object))) options = rest.shift() as vscode.MessageOptions;
        const items = rest.map((r) => (typeof r === "string" ? r : (r as vscode.MessageItem).title));
        const call: DialogCall = { kind, message: msg, items, ...(options?.detail ? { detail: options.detail } : {}), ...(options?.modal ? { modal: true } : {}) };
        this.calls.push(call);
        const answer = this.messages.shift();
        const title = answer ? await answer(call) : undefined;
        if (title === undefined) return undefined;
        assert.ok(items.includes(title), `answer "${title}" is not a button of "${msg}" (${items.join(", ")})`);
        const i = items.indexOf(title);
        return typeof rest[i] === "string" ? title : rest[i];
      };
    replace(w, "showInformationMessage", message("info"));
    replace(w, "showWarningMessage", message("warning"));
    replace(w, "showErrorMessage", message("error"));
    replace(w, "showQuickPick", async (items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>, options?: vscode.QuickPickOptions) => {
      const list = (await items).map((i) => (typeof i === "string" ? { label: i } : i));
      const call: DialogCall = { kind: "quickPick", message: options?.title ?? options?.placeHolder ?? "", items: list, options };
      this.calls.push(call);
      const answer = this.picks.shift();
      const r = answer ? await answer(list, options, call) : undefined;
      if (r === undefined) return undefined;
      const raw = await items;
      // return the caller's own objects (strings stay strings)
      const back = (x: unknown) => raw[list.indexOf(x as vscode.QuickPickItem)] ?? x;
      return Array.isArray(r) ? r.map(back) : back(r);
    });
    replace(w, "showInputBox", async (options?: vscode.InputBoxOptions) => {
      this.calls.push({ kind: "inputBox", message: options?.title ?? options?.prompt ?? "", items: [], options });
      const answer = this.inputs.shift();
      return answer ? answer(options) : undefined;
    });
    replace(w, "showOpenDialog", async (options?: vscode.OpenDialogOptions) => {
      this.calls.push({ kind: "openDialog", message: options?.title ?? "", items: [], options });
      return this.opens.shift();
    });
    replace(vscode.env as unknown as Record<string, unknown>, "openExternal", async (uri: vscode.Uri) => {
      this.calls.push({ kind: "openExternal", message: uri.toString(), items: [] });
      return true;
    });
  }

  uninstall(): void {
    for (const r of this.restore.reverse()) r();
    this.restore.length = 0;
  }

  /** Clears recorded calls and pending answers. */
  reset(): void {
    this.calls.length = 0;
    this.messages = [];
    this.picks = [];
    this.inputs = [];
    this.opens = [];
  }

  /** Next open dialog returns these files. */
  open(...files: vscode.Uri[]): this {
    this.opens.push(files);
    return this;
  }

  /** Next message dialog answers with this button (or a function of the call). */
  answer(a: string | undefined | MessageAnswer): this {
    this.messages.push(typeof a === "function" ? a : () => a);
    return this;
  }

  pick(a: PickAnswer): this {
    this.picks.push(a);
    return this;
  }

  /** Picks the first item whose label (without $(icon)) matches. */
  pickLabel(re: RegExp): this {
    return this.pick((items) => {
      const it = items.find((i) => re.test(i.label.replace(/\$\([^)]*\)\s*/g, "")) && i.kind !== vscode.QuickPickItemKind.Separator);
      assert.ok(it, `no quick pick item matches ${re}: ${items.map((i) => i.label).join(" | ")}`);
      return it;
    });
  }

  input(a: string | undefined | InputAnswer): this {
    this.inputs.push(typeof a === "function" ? a : () => a);
    return this;
  }

  of(kind: DialogCall["kind"]): DialogCall[] {
    return this.calls.filter((c) => c.kind === kind);
  }

  /** Messages of any kind, for assertions ("did it explain?"). */
  get texts(): string[] {
    return this.calls.filter((c) => c.kind === "info" || c.kind === "warning" || c.kind === "error").map((c) => `${c.kind}: ${c.message}${c.detail ? `\n${c.detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------------------------- CLI

/** Records every rung CLI command the extension runs. */
export class CliLog implements vscode.Disposable {
  readonly runs: Finished[] = [];
  private readonly sub: vscode.Disposable;

  constructor(api: RungExtensionApi) {
    this.sub = api.cli.onDidFinish((f) => this.runs.push(f));
  }

  lines(): string[] {
    return this.runs.map((r) => r.args.join(" "));
  }

  find(cmd: string): Finished | undefined {
    return this.runs.find((r) => r.args[0] === cmd);
  }

  async next(pred: (f: Finished) => boolean, what: string, timeoutMs = 60_000): Promise<Finished> {
    return waitFor(what, () => this.runs.find(pred), timeoutMs);
  }

  clear(): void {
    this.runs.length = 0;
  }

  dispose(): void {
    this.sub.dispose();
  }
}

// ---------------------------------------------------------------------------------------------- trees

export interface TreeLike<T> {
  getChildren(e?: T): T[] | Thenable<T[]> | undefined | null;
  getTreeItem(e: T): vscode.TreeItem | Thenable<vscode.TreeItem>;
}

const labelOf = (i: vscode.TreeItem) => (typeof i.label === "string" ? i.label : (i.label?.label ?? ""));

/** "  label [description] {contextValue} <icon>" lines, depth-first. */
export async function outline<T>(tree: TreeLike<T>, maxDepth = 8): Promise<string[]> {
  const out: string[] = [];
  const walk = async (e: T | undefined, depth: number) => {
    for (const c of (await tree.getChildren(e)) ?? []) {
      const it = await tree.getTreeItem(c);
      const icon = it.iconPath instanceof vscode.ThemeIcon ? ` <${it.iconPath.id}>` : "";
      out.push(`${"  ".repeat(depth)}${labelOf(it)}${it.description ? ` [${it.description}]` : ""}${it.contextValue ? ` {${it.contextValue}}` : ""}${icon}`);
      if (depth < maxDepth && it.collapsibleState !== vscode.TreeItemCollapsibleState.None) await walk(c, depth + 1);
    }
  };
  await walk(undefined, 0);
  return out;
}

/** Finds a tree element by label path ("PLC_1", "Program blocks", "Fx_Motor"). */
export async function findItem<T>(tree: TreeLike<T>, ...path: (string | RegExp)[]): Promise<{ element: T; item: vscode.TreeItem }> {
  let parent: T | undefined;
  let found: { element: T; item: vscode.TreeItem } | undefined;
  for (const p of path) {
    found = undefined;
    for (const c of (await tree.getChildren(parent)) ?? []) {
      const it = await tree.getTreeItem(c);
      const l = labelOf(it);
      if (typeof p === "string" ? l === p : p.test(l)) {
        found = { element: c, item: it };
        break;
      }
    }
    assert.ok(found, `tree has no ${path.join(" > ")} (stuck at ${String(p)})`);
    parent = found.element;
  }
  return found!;
}

// ---------------------------------------------------------------------------------------------- workspace files

export function readText(rel: string): string {
  return readFileSync(join(root(), ...rel.split("/")), "utf8");
}

/** Removes every [plc.*] table from rung.toml (so the next online/download has to find the PLC). */
export function clearPlcTables(): void {
  const p = join(root(), "rung.toml");
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const out: string[] = [];
  let skip = false;
  for (const l of lines) {
    if (/^\s*\[/.test(l)) skip = /^\s*\[\s*plc\s*\./.test(l);
    if (!skip) out.push(l);
  }
  writeFileSync(p, out.join("\n").replace(/\n{3,}/g, "\n\n"));
}

export async function openDoc(rel: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(file(rel));
  return vscode.window.showTextDocument(doc, { preview: false });
}

/** Position of the first occurrence of `needle` (plus `offset` characters) in a document. */
export function positionOf(doc: vscode.TextDocument, needle: string, offset = 0, from = 0): vscode.Position {
  const i = doc.getText().indexOf(needle, from);
  assert.ok(i >= 0, `"${needle}" not in ${doc.uri.fsPath}`);
  return doc.positionAt(i + offset);
}

export async function closeAll(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}
