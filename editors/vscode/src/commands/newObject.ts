// SPDX-License-Identifier: MIT
// New object…: a short native wizard (kind, PLC, folder, name, an FC's return type) for an FB, FC, DB, UDT or tag
// table. The language server gives the path and the text TIA Portal exports for it (rung/newObject); the file is
// written only at the end, never over another, and opened. Cancelling at any step writes nothing.
import { join } from "node:path";
import * as vscode from "vscode";
import type { Lsp } from "../lsp";
import type { RungWorkspace } from "../workspace";

type Kind = "FB" | "FC" | "DB" | "UDT" | "TAGS";
interface Request {
  kind: Kind;
  name: string;
  plc: string;
  unit?: string;
  groups?: string[];
  returnType?: string;
}
type Answer = { path: string; text: string } | { reason: string };

const KINDS: { kind: Kind; label: string; detail: string; icon: string; dir: string }[] = [
  { kind: "FB", label: "Function block", detail: "FB: code with its own memory (an instance per use)", icon: "symbol-class", dir: "blocks" },
  { kind: "FC", label: "Function", detail: "FC: code without memory, called with its parameters", icon: "symbol-method", dir: "blocks" },
  { kind: "DB", label: "Global data block", detail: "DB: data every block can use", icon: "database", dir: "blocks" },
  { kind: "UDT", label: "PLC data type", detail: "UDT: a structure to declare variables with", icon: "symbol-structure", dir: "types" },
  { kind: "TAGS", label: "PLC tag table", detail: "Tags at inputs, outputs and memory", icon: "tag", dir: "tags" },
];

const RETURN_TYPES = ["Void", "Bool", "Int", "DInt", "Real", "LReal", "Word", "DWord", "Time", "String"];

/** A folder name as the workspace writes it (%2F for "/", docs/format/README.md) back to the name it stands for. */
const unescape = (segment: string) => segment.replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** The folders (as group paths) below a directory, depth first; "" is the directory itself. */
async function folders(dir: vscode.Uri, prefix: string[] = []): Promise<string[][]> {
  const entries = await vscode.workspace.fs.readDirectory(dir).then((e) => e, () => [] as [string, vscode.FileType][]);
  const out: string[][] = [];
  for (const [name, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (type !== vscode.FileType.Directory || name.startsWith(".")) continue;
    const group = [...prefix, unescape(name)];
    out.push(group, ...(await folders(vscode.Uri.joinPath(dir, name), group)));
  }
  return out;
}

async function pick<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions & { step: number; steps: number }): Promise<T | undefined> {
  return vscode.window.showQuickPick(items, { ...options, title: `New object (${options.step}/${options.steps})`, ignoreFocusOut: true });
}

/** Creates a file with its text, or refuses when the file exists: never a check and then a write. */
export async function createNew(file: vscode.Uri, text: string): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(file, { overwrite: false, ignoreIfExists: false, contents: new TextEncoder().encode(text) });
  return vscode.workspace.applyEdit(edit).then((ok) => ok, () => false);
}

export async function newObjectCommand(lsp: Lsp, ws: RungWorkspace): Promise<vscode.Uri | undefined> {
  if (!ws.root) {
    void vscode.window.showWarningMessage("New objects are made in a rung workspace (a folder with rung.toml).");
    return undefined;
  }
  const root = vscode.Uri.file(ws.root);
  const steps = 4;
  const kind = await pick(
    KINDS.map((k) => ({ label: `$(${k.icon}) ${k.label}`, detail: k.detail, k })),
    { step: 1, steps, placeHolder: "What to make" },
  );
  if (!kind) return undefined;
  const k = kind.k;

  // the PLC (and its software unit), when the workspace has more than one place for it
  const plcs = (await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, "plc")).then((e) => e, () => [])).filter(([, t]) => t === vscode.FileType.Directory).map(([n]) => n);
  if (!plcs.length) {
    void vscode.window.showWarningMessage("This workspace has no PLC yet: rung pull mirrors the TIA Portal project first.");
    return undefined;
  }
  // folder names as written (for the paths) and the names they stand for (for people and the language server)
  const places: { label: string; plc: string; unit?: string; dir: string[] }[] = [];
  for (const raw of plcs) {
    const plc = unescape(raw);
    places.push({ label: plc, plc, dir: ["plc", raw] });
    const units = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, "plc", raw, "units")).then((e) => e, () => []);
    for (const [u, t] of units) if (t === vscode.FileType.Directory) places.push({ label: `${plc} / ${unescape(u)}`, plc, unit: unescape(u), dir: ["plc", raw, "units", u] });
  }
  const place = places.length === 1 ? places[0] : await pick(places.map((p) => ({ ...p, description: p.unit ? "software unit" : "PLC" })), { step: 2, steps, placeHolder: "Where: the PLC, or one of its software units" });
  if (!place) return undefined;

  // the folder: one that exists, the top, or one typed in (Line/Valves)
  const base = vscode.Uri.joinPath(root, ...place.dir, k.dir);
  const existing = await folders(base);
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { groups: string[] }>();
  qp.title = `New object (3/${steps})`;
  qp.placeholder = "Folder: pick one, or type a new path (Line/Valves)";
  qp.ignoreFocusOut = true;
  const listed = [{ label: "$(root-folder) Top level", groups: [] as string[] }, ...existing.map((g) => ({ label: `$(folder) ${g.join(" / ")}`, groups: g }))];
  qp.items = listed;
  qp.onDidChangeValue((v) => {
    const typed = v.split("/").map((s) => s.trim()).filter(Boolean);
    qp.items = typed.length ? [...listed, { label: `$(new-folder) ${typed.join(" / ")}`, description: "new folder", groups: typed, alwaysShow: true }] : listed;
  });
  const folder = await new Promise<{ groups: string[] } | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!folder) return undefined;

  const request = (name: string): Request => ({ kind: k.kind, name, plc: place.plc, ...(place.unit ? { unit: place.unit } : {}), groups: folder.groups });
  const ask = (r: Request) => lsp.request<Answer>("rung/newObject", r).catch(() => ({ reason: "The rung language server is not running." }) as Answer);
  const name = await vscode.window.showInputBox({
    title: `New object (4/${steps})`,
    prompt: `Name of the ${k.label.toLowerCase()}`,
    ignoreFocusOut: true,
    validateInput: async (v) => {
      if (!v) return undefined;
      const a = await ask(request(v));
      return a && "reason" in a ? a.reason : undefined;
    },
  });
  if (!name) return undefined;
  let returnType: string | undefined;
  if (k.kind === "FC") {
    const rt = await vscode.window.showQuickPick(RETURN_TYPES, { title: "New object: the function's return type", placeHolder: "Void: the function returns nothing", ignoreFocusOut: true });
    if (!rt) return undefined;
    returnType = rt;
  }
  const answer = await ask({ ...request(name), ...(returnType ? { returnType } : {}) });
  if (!answer || "reason" in answer) {
    void vscode.window.showWarningMessage(answer?.reason ?? "The rung language server is not running.");
    return undefined;
  }
  const file = vscode.Uri.file(join(ws.root, answer.path));
  // created in one step that refuses a file already there (one that appeared meanwhile is never written over)
  if (!(await createNew(file, answer.text))) {
    void vscode.window.showWarningMessage(`${answer.path} is already there.`);
    return undefined;
  }
  if (k.kind === "UDT") await vscode.commands.executeCommand("vscode.openWith", file, "rung.udtTable");
  else await vscode.window.showTextDocument(file, { preview: false });
  void vscode.window.setStatusBarMessage(`rung: ${answer.path} created; rung sync (or rung watch) brings it into TIA Portal`, 5000);
  return file;
}
