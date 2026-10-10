// SPDX-License-Identifier: BUSL-1.1
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isContained } from "@rung/core";
import { deviceOfUri, WorkspaceIndex } from "@rung/lsp";
import { reconstructCycle, reconstructionWhy, type CycleCapture } from "@rung/sim";
import { findWorkspace, readBoundedText, type Io } from "./common.js";
import { whyLines } from "./why.js";

/** Historical replay only: never opens an engineering/live connection. */
export async function cmdProgramStatus(target: string | undefined, opts: { capture?: string; instance?: string; json?: boolean; why?: string }, io: Io): Promise<number> {
  try {
    if (!target || !opts.capture || !opts.instance) throw new Error("Use rung program-status <block.scl> --capture <cycle.json> --instance <DB> [--json]");
    const file = resolve(io.cwd, target), uri = pathToFileURL(file).href;
    const root = await findWorkspace(dirname(file));
    const plc = deviceOfUri(uri);
    if (!plc || !file.toLowerCase().endsWith(".scl") || !await isContained(root, file)) throw new Error("Choose a mirrored SCL block inside the selected workspace PLC");
    const index = new WorkspaceIndex(); await index.load(root);
    const block = index.docs.get(uri)?.parsed?.blocks[0];
    const instance = index.global(opts.instance.replace(/^"|"$/g, ""), uri);
    if (!block || instance?.kind !== "DB" || instance.block?.dbOf?.toUpperCase() !== block.name.toUpperCase())
      throw new Error("Selected instance DB does not belong to this block");
    const capture = JSON.parse(await readBoundedText(resolve(io.cwd, opts.capture), "Capture")) as CycleCapture;
    const scope = { plc, instance: `"${instance.name}"`, epoch: capture?.scope?.epoch };
    const replay = reconstructCycle(index, uri, capture, scope);
    const result = { ...replay, freshness: "capture-only" as const, ...(opts.why ? { why: reconstructionWhy(replay, opts.why) } : {}) };
    if (opts.json) io.stdout(JSON.stringify(result, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Reconstructed value cannot be represented as finite JSON");
      return value;
    }) + "\n");
    else {
      io.stdout(`Reconstructed ${block.name} through ${scope.instance} from a historical capture; PLC execution is unverified.\n`);
      for (const entry of result.trace) if (entry.kind === "statement") io.stdout(`  ${entry.line}: ${entry.statement}\n`);
      for (const difference of result.divergences) io.stdout(`  ${difference.path}: reconstructed ${JSON.stringify(difference.reconstructed)}, observed ${JSON.stringify(difference.observed)}\n`);
      if (result.why) io.stdout(whyLines(result.why).join("\n") + "\n");
    }
    return result.divergences.length ? 2 : 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (opts.json) io.stdout(JSON.stringify({ kind: "unavailable", exact: false, freshness: "capture-only", reason }) + "\n");
    else io.stderr(`rung program-status: ${reason}\n`);
    return 1;
  }
}
