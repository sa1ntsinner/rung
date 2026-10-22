// SPDX-License-Identifier: BUSL-1.1
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { escapeSegment, loadConfig, unescapeSegment, WorkspaceError } from "@rung/core";
import { deviceOfUri, instanceDbText, nearest, WorkspaceIndex, workspaceNewObject, type NewKind } from "@rung/lsp";
import { findWorkspace, type Io } from "./common.js";

export async function cmdNew(args: string[], v: Record<string, unknown>, io: Io): Promise<number> {
  const kind = args[0]?.toUpperCase() as NewKind;
  const name = args[1];
  const refuse = (reason: string): never => { throw new WorkspaceError("BAD_ARGUMENT", reason); };
  if (!["FB", "FC", "OB", "DB", "UDT", "TAGS"].includes(kind) || name === undefined) return refuse("Use rung new <fb|fc|ob|db|udt|tags> <name>.");
  if (v.returns !== undefined && kind !== "FC") return refuse("--returns is only for fc.");
  if (v.of !== undefined && kind !== "DB") return refuse("--of is only for db.");
  const ws = await findWorkspace(resolve(io.cwd, String(v.dir ?? ".")));
  const cfg = await loadConfig(ws, { raw: true });
  const folders = await readdir(join(ws, "plc"), { withFileTypes: true }).catch(() => []);
  const plcs = [...new Set([...cfg.devices, ...folders.filter((f) => f.isDirectory()).map((f) => unescapeSegment(f.name))])];
  const plc = v.plc === undefined ? (plcs.length === 1 ? plcs[0] : undefined) : plcs.find((p) => p.toLowerCase() === String(v.plc).toLowerCase());
  if (!plc) return refuse(`${v.plc === undefined ? "Choose --plc" : `Unknown PLC ${v.plc}`}. PLCs: ${plcs.join(", ") || "none"}.`);
  const index = new WorkspaceIndex();
  await index.load(ws);
  const draft = await workspaceNewObject(index, ws, { kind, name, plc, ...(v.folder !== undefined ? { groups: String(v.folder).split("/") } : {}), ...(v.returns !== undefined ? { returnType: String(v.returns) } : {}) });
  if ("reason" in draft) return refuse(draft.reason);
  let text = draft.text;
  if (v.of !== undefined) {
    const fbs = index.allGlobals().filter((g) => g.kind === "FB" && deviceOfUri(g.uri)?.toLowerCase() === escapeSegment(plc).toLowerCase());
    const fb = fbs.find((g) => g.name.toLowerCase() === String(v.of).toLowerCase());
    if (!fb) {
      const near = nearest(String(v.of), fbs.map((g) => g.name));
      return refuse(`${plc} has no FB ${v.of}.${near ? ` Did you mean ${near}?` : ""}`);
    }
    text = instanceDbText(name, fb.name, index.docs.get(fb.uri)?.text ?? "");
  }
  const file = join(ws, draft.path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, { flag: "wx" });
  io.stdout(v.json ? JSON.stringify({ path: draft.path, kind }) + "\n" : draft.path + "\n");
  return 0;
}
