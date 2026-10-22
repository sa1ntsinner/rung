// SPDX-License-Identifier: BUSL-1.1
// rung_download_request: the handover a person needs before downloading an agent's change.
// This tool prepares a request; download permission is handled separately by agent modes.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { BlobStore, normalizeText, sha256, writeFileAtomic, type StateFile } from "@rung/core";
import { join } from "node:path";

const run = promisify(execFile);

export interface HandoverInput {
  root: string;
  device: string;
  summary?: string;
  testPlan?: string;
  connection?: { pcInterface: string; targetInterface?: string };
  /** The last compile record's errors; undefined when rung has none (never compiled through rung). */
  compileErrors?: { path?: string; line?: number; message: string }[];
  interfaceChanges?: string[];
  /** The device's mirrored objects as the state store has them (path and sync status). */
  objects?: { path: string; status: string; baseId?: string }[];
}

/** Files under plc/ that differ from the last git commit, or null when the workspace is not a git repository. */
export async function changedFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await run("git", ["status", "--porcelain", "--untracked-files=all", "--", "plc"], { cwd: root, windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()!)
      .filter((f) => !/\.(conflict|tia)$/.test(f));
  } catch {
    return null;
  }
}

/** Kinds of change that make TIA Portal ask questions or reinitialise data on download. */
export function risks(files: string[], interfaceChanges: string[] = []): string[] {
  const out: string[] = [];
  const dbs = files.filter((f) => /\.(db)$/.test(f));
  const udts = files.filter((f) => /\.(udt)$/.test(f) || /\/types\//.test(f));
  if (dbs.length) out.push(`Data blocks changed (${dbs.join(", ")}): if their structure changed, TIA reinitialises them and their current values go back to start values ("reinit-db").`);
  if (udts.length) out.push(`PLC data types changed (${udts.join(", ")}): every DB and instance that uses them may be reinitialised.`);
  if (interfaceChanges.length) out.push(`FB interfaces changed (${interfaceChanges.join(", ")}): their instance DBs are reinitialised; the CPU usually has to go to STOP ("stop-cpu").`);
  if (files.some((f) => /\/(hardware|hw)\//i.test(f))) out.push("Hardware configuration changed: download hardware too (rung download --hw); expect a CPU STOP.");
  return out;
}

export async function handover(i: HandoverInput): Promise<string> {
  const files = await changedFiles(i.root);
  const lines: string[] = [];
  lines.push(`# Download request: ${i.device}`, "");
  lines.push("The MCP server never downloads; `rung download` does. An agent may run it unless the person chose an agent mode that restricts it. RUNG_READ_ONLY and read-only locks always win. Review this, then run `rung download` (it asks for the PLC name and answers TIA's questions only as allowed).", "");
  if (i.summary) lines.push("## What changed and why", "", i.summary.trim(), "");
  // three different baselines: what TIA Portal has (the state store), what the PLC runs (rung keeps no record of
  // it), and git (what was committed, which says nothing about either)
  const objects = i.objects ?? [];
  const notInTia = [];
  const uncertain = [];
  for (const object of objects) {
    let matches = false;
    try {
      const base = JSON.parse((await new BlobStore(i.root).get(object.baseId!)).toString("utf8")) as StateFile[];
      matches = base.length > 0 && (await Promise.all(base.map(async f => {
        const bytes = await readFile(join(i.root, f.path));
        return sha256(bytes) === f.hash || sha256(normalizeText(bytes.toString("utf8"))) === f.hash;
      }))).every(Boolean);
    } catch { /* Missing base or files cannot establish agreement. */ }
    if (!matches) notInTia.push(object);
    else if (object.status !== "synced") uncertain.push(object);
  }
  lines.push("## Files and TIA Portal", "");
  if (!objects.length) lines.push("Unknown: nothing of this PLC is mirrored yet (rung pull), so rung cannot tell what TIA Portal has.");
  else if (!notInTia.length && uncertain.length) lines.push("Files match the last base, but current TIA Portal agreement is unknown: " + uncertain.map(o => o.path + " (" + o.status + ")").join(", ") + ". Sync first.");
  else if (!notInTia.length) lines.push(`TIA Portal has the files as they are: all ${objects.length} mirrored objects are synced.`);
  else {
    lines.push(`**${notInTia.length} object(s) differ between the files and TIA Portal**: sync first, or TIA Portal downloads its own version, not the files.`);
    for (const o of notInTia) lines.push(`- ${o.path} (${o.status})`);
  }
  lines.push("");
  lines.push("The file comparison uses the last imported or exported base. It does not establish a later compile or PLC download.", "");
  lines.push("## TIA Portal and the PLC", "");
  lines.push("Unknown: rung keeps no record of what the PLC runs. Before downloading, compare online (rung compare, or TIA Portal's online/offline comparison) to see which blocks the download replaces.", "");
  lines.push("## Changed since the last git commit", "");
  if (files === null) lines.push("The workspace is not a git repository.");
  else if (!files.length) lines.push("Nothing uncommitted under plc/. A committed change may still be missing on the PLC.");
  else for (const f of files) lines.push(`- ${f}`);
  lines.push("");
  lines.push("## Compile", "");
  if (i.compileErrors === undefined) lines.push("No source-bound compile record: current compile state is unknown. Compile (rung compile) before downloading.");
  else if (i.compileErrors.length) {
    lines.push(`**${i.compileErrors.length} compile error(s): do not download.**`, "These are the last recorded errors. They do not establish the current source or compile state.");
    for (const e of i.compileErrors) lines.push(`- ${e.path ?? ""}${e.line ? `:${e.line}` : ""} ${e.message}`);
  } else lines.push(notInTia.length ? "No compile errors in the last record. It does not prove these files were compiled: compile again after the sync." : "No compile errors in the last compile record.");
  lines.push("");
  const r = risks([...new Set([...(files ?? []), ...notInTia.map((o) => o.path)])], i.interfaceChanges);
  lines.push("## What TIA Portal will likely ask", "");
  if (r.length) for (const x of r) lines.push(`- ${x}`);
  else lines.push("- Unknown: the PLC deployment baseline is unknown, so DB reinitialisation, interface and hardware risks cannot be ruled out.");
  lines.push("");
  lines.push("## Connection", "");
  lines.push(i.connection ? `${i.connection.pcInterface}${i.connection.targetInterface ? ` → ${i.connection.targetInterface}` : ""} (from rung.toml)` : "Not saved yet: rung finds the PLC by its project address when the download starts (rung connect to choose).");
  lines.push("");
  lines.push("## Test on the machine", "");
  lines.push(i.testPlan?.trim() || "- Machine in manual or setup mode, area clear, emergency stop checked.\n- Exercise every behaviour the change touches, including stop and fault paths.\n- Watch the values with rung live read while testing.\n- Roll back by checking out the previous commit and downloading it the same way.");
  lines.push("");
  lines.push("## To download", "", "```", `rung download${r.some((x) => x.startsWith("Hardware")) ? " --hw" : ""}`, "```", "");
  const md = lines.join("\n");
  await writeFileAtomic(join(i.root, ".rung", "download-request.md"), md).catch(() => undefined);
  return md;
}
