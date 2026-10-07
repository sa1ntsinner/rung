// SPDX-License-Identifier: MIT
// Cross-Reference in TIA Portal: who uses an object and what it uses, as TIA Portal's own cross-reference sees it
// (HMI screens, alarms and technology objects too, which the files cannot show). `rung xref --json`, read only.
import { join } from "node:path";
import * as vscode from "vscode";
import { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";

interface Row {
  relation: "used by" | "uses" | "overlaps" | "related";
  name: string;
  type: string;
  path?: string;
  access: string;
  location?: string;
}

const TITLE: Record<Row["relation"], string> = { "used by": "Used by", uses: "Uses", overlaps: "Shares addresses with", related: "Related" };

export async function crossReference(ws: RungWorkspace, cli: RungCli, arg?: unknown): Promise<Row[] | undefined> {
  const uri = arg instanceof vscode.Uri ? arg : arg && typeof arg === "object" && "resourceUri" in arg ? (arg as { resourceUri?: vscode.Uri }).resourceUri : vscode.window.activeTextEditor?.document.uri;
  if (!uri || !ws.root) {
    void vscode.window.showWarningMessage("Open a block, DB or data type of the workspace first.");
    return undefined;
  }
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Asking TIA Portal for the cross-reference…" }, () => cli.capture(["xref", uri.fsPath, "--json"], { quiet: true }));
  let rows: Row[];
  let cachedAt: string | undefined;
  try {
    ({ rows, cachedAt } = JSON.parse(r.output) as { rows: Row[]; cachedAt?: string });
  } catch {
    void vscode.window.showErrorMessage(`rung xref: ${RungCli.summary(r.output) || "TIA Portal did not answer"}`);
    return undefined;
  }
  const name = uri.path.replace(/^.*\//, "").replace(/\..*$/, "");
  if (!rows.length) {
    void vscode.window.showInformationMessage(`TIA Portal knows no cross references of ${name}.`);
    return rows;
  }
  type Item = vscode.QuickPickItem & { row?: Row };
  const items: Item[] = [];
  for (const rel of ["used by", "uses", "overlaps", "related"] as const) {
    const group = rows.filter((x) => x.relation === rel);
    if (!group.length) continue;
    items.push({ label: TITLE[rel], kind: vscode.QuickPickItemKind.Separator });
    for (const row of group) items.push({ row, label: row.name, description: `${row.access} · ${row.type}`, ...(row.location ? { detail: row.location } : {}), ...(row.path ? { iconPath: new vscode.ThemeIcon("go-to-file") } : {}) });
  }
  const pick = await vscode.window.showQuickPick(items, { title: `${name} in TIA Portal's cross-reference${cachedAt ? ` (its answer of ${new Date(cachedAt).toLocaleTimeString()}; nothing mirrored changed since)` : ""}`, placeHolder: "Pick one to open its file (when rung mirrors it)", matchOnDescription: true, matchOnDetail: true });
  if (pick?.row?.path) await vscode.window.showTextDocument(vscode.Uri.file(join(ws.root, pick.row.path)));
  return rows;
}
