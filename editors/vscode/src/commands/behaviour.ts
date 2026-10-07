// SPDX-License-Identifier: MIT
// Compare Behaviour With…: today's tests on the code at a git revision and now (`rung test --against <rev> --json`);
// every case that behaves differently, with its first different value. Picking one opens the case.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { casesIn } from "../core/testItems";
import { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";

interface Divergence {
  file: string;
  case: string;
  index: number;
  differences: { step: number; name: string; before: unknown; after: unknown }[];
  verdict?: { before: string; after: string };
}

const run = promisify(execFile);
const shown = (v: unknown) => (v === undefined ? "—" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "string" ? v : JSON.stringify(v));

/** The revisions worth offering: the last commits and the branches. */
async function revisions(root: string): Promise<vscode.QuickPickItem[]> {
  const log = await run("git", ["-C", root, "log", "-8", "--format=%h%x09%s%x09%cr"], { windowsHide: true }).then((r) => r.stdout, () => "");
  const branches = await run("git", ["-C", root, "branch", "--format=%(refname:short)"], { windowsHide: true }).then((r) => r.stdout, () => "");
  const items: vscode.QuickPickItem[] = [];
  const commits = log.split(/\r?\n/).filter(Boolean);
  if (commits.length) items.push({ label: "Commits", kind: vscode.QuickPickItemKind.Separator });
  for (const c of commits) {
    const [hash, subject, when] = c.split("\t");
    items.push({ label: hash!, description: subject, detail: when });
  }
  const names = branches.split(/\r?\n/).filter(Boolean);
  if (names.length) items.push({ label: "Branches", kind: vscode.QuickPickItemKind.Separator });
  for (const b of names) items.push({ label: b });
  return items;
}

export async function compareBehaviour(ws: RungWorkspace, cli: RungCli, rev?: string): Promise<Divergence[] | undefined> {
  if (!ws.root) return undefined;
  const root = ws.root;
  if (!rev) {
    const items = await revisions(root);
    if (!items.length) {
      void vscode.window.showWarningMessage("This workspace is not in a git repository: behaviour is compared with a git revision.");
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(items, { title: "Compare behaviour with…", placeHolder: "The code at this revision runs today's tests too" });
    rev = pick?.label;
  }
  if (!rev) return undefined;
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running the tests on the code at ${rev} and now…` }, () => cli.capture(["test", "--against", rev!, "--json"], { quiet: true }));
  let d: Divergence[];
  let cases = 0;
  try {
    const j = JSON.parse(r.output) as { cases: number; divergences: Divergence[] };
    d = j.divergences;
    cases = j.cases;
  } catch {
    void vscode.window.showErrorMessage(`rung test --against: ${RungCli.summary(r.output) || "no answer"}`);
    return undefined;
  }
  if (!d.length) {
    void vscode.window.showInformationMessage(`All ${cases} test cases behave as they did at ${rev}.`);
    return d;
  }
  type Item = vscode.QuickPickItem & { d: Divergence };
  const items: Item[] = d.map((x) => {
    const first = x.differences[0];
    return {
      d: x,
      label: `${x.verdict?.after === "failed" || x.verdict?.after === "error" ? "$(error)" : "$(diff)"} ${x.case}`,
      description: x.file,
      detail: [x.verdict ? `${x.verdict.before} then, ${x.verdict.after} now` : "", first ? `step ${first.step}: ${first.name} ${shown(first.before)} → ${shown(first.after)}${x.differences.length > 1 ? ` (first of ${x.differences.length})` : ""}` : ""].filter(Boolean).join(" · "),
    };
  });
  const pick = await vscode.window.showQuickPick(items, { title: `${d.length} of ${cases} cases behave differently than at ${rev}`, matchOnDescription: true, matchOnDetail: true });
  if (pick) {
    const uri = vscode.Uri.file(join(root, pick.d.file));
    const text = await readFile(uri.fsPath, "utf8").catch(() => "");
    const line = casesIn(text)[pick.d.index]?.line ?? 0;
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0) });
  }
  return d;
}
