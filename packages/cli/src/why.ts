// SPDX-License-Identifier: BUSL-1.1
// rung why <file> <name>: why a value has the value the PLC (or rung simulate) has now. The block's statements that
// write it, the branch each stands in, their operands, with values read once, now (read-only). Without a live
// connection ([live.webapi], or CODESYS), the code alone: who writes it, under which conditions.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceIndex } from "@rung/lsp";
import { explainStatic, type WhyNode } from "@rung/sim";
import { findWorkspace, type Io } from "./common.js";
import { liveError, liveReader } from "./live.js";
import { isIecMonitor, monitorPlan, monitorPlanIec } from "./monitor.js";

export interface WhyOptions {
  instance?: string;
  json?: boolean;
  depth?: number;
}

export function whyLines(n: WhyNode, pad = ""): string[] {
  const head =
    n.kind === "value" ? `${n.text} = ${n.value ?? "?"}` : n.kind === "write" ? `← ${n.text}${n.at ? `   (line ${n.at.line})` : ""}` : n.kind === "condition" ? `because ${n.text}${n.value ? `  → ${n.value}` : ""}` : `· ${n.text}`;
  return [pad + head, ...n.children.flatMap((c) => whyLines(c, pad + "  "))];
}

export async function cmdWhy(target: string | undefined, name: string | undefined, opts: WhyOptions, io: Io): Promise<number> {
  if (!target || !name) {
    io.stderr("rung: usage: rung why <block file> <name> [--instance <DB>] [--json]   e.g. rung why plc/PLC_1/blocks/FB_Motor.scl Running\n");
    return 1;
  }
  const file = resolve(io.cwd, target);
  // a folder without rung.toml (TwinCAT, plain ST, an example) is read as it is, like rung test reads it
  const ws = await findWorkspace(dirname(file)).catch(() => io.cwd);
  const uri = pathToFileURL(file).href;
  const index = new WorkspaceIndex();
  await index.load(ws);
  if (!index.docs.get(uri)) index.set(uri, await readFile(file, "utf8"), 0);
  // the values: read once, through the same names monitoring uses; none without a live connection
  const values = new Map<string, unknown>();
  let source = "values read now";
  try {
    const plan = (isIecMonitor(uri) ? monitorPlanIec : monitorPlan)(index, uri, opts.instance);
    const labels = Object.keys(plan.vars);
    const reader = await liveReader(uri, io, ws);
    try {
      const rows = await reader.read(labels.map((l) => plan.vars[l]!));
      rows.forEach((r, i) => {
        if (!r.error) values.set(labels[i]!.toUpperCase(), r.value);
        // a declaration's own label is its bare name; the code writes #name
        if (!r.error && !labels[i]!.startsWith("#") && !labels[i]!.startsWith('"')) values.set(`#${labels[i]!.toUpperCase()}`, r.value);
      });
      source = `values read ${new Date().toLocaleTimeString(undefined, { hour12: false })}${plan.instance ? ` through ${plan.instance}` : ""}`;
    } finally {
      await reader.close();
    }
  } catch (e) {
    source = `the code only (no values: ${liveError(e)})`;
  }
  let tree: WhyNode;
  try {
    tree = explainStatic(index, uri, name, (label) => values.get(label.toUpperCase()), Math.max(1, Math.min(6, opts.depth ?? 3)));
  } catch (e) {
    io.stderr(`rung: ${(e as Error).message}\n`);
    return 1;
  }
  if (opts.json) {
    io.stdout(JSON.stringify({ source, tree }, null, 2) + "\n");
    return 0;
  }
  io.stdout(`${whyLines(tree).join("\n")}\n(${source})\n`);
  return 0;
}
