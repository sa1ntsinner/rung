// SPDX-License-Identifier: BUSL-1.1
// rung_download_request: the handover a person needs before downloading an agent's change.
// The agent never downloads; this collects what changed, what TIA Portal will likely ask, and how to test.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileAtomic } from "@rung/core";
import { join } from "node:path";

const run = promisify(execFile);

export interface HandoverInput {
  root: string;
  device: string;
  summary?: string;
  testPlan?: string;
  connection?: { pcInterface: string; targetInterface?: string };
  compileErrors: { path?: string; line?: number; message: string }[];
  interfaceChanges?: string[];
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
  lines.push("rung and agents never download. A person reviews this, then runs `rung download` (it asks them to type the PLC name and answers TIA's questions only as they allow).", "");
  if (i.summary) lines.push("## What changed and why", "", i.summary.trim(), "");
  lines.push("## Changed files", "");
  if (files === null) lines.push("The workspace is not a git repository, so rung cannot list the changes since the last known-good state; review rung_status and the diffs.");
  else if (!files.length) lines.push("No uncommitted changes under plc/ (compared with the last git commit).");
  else for (const f of files) lines.push(`- ${f}`);
  lines.push("");
  lines.push("## Compile", "");
  if (i.compileErrors.length) {
    lines.push(`**${i.compileErrors.length} compile error(s): do not download.**`);
    for (const e of i.compileErrors) lines.push(`- ${e.path ?? ""}${e.line ? `:${e.line}` : ""} ${e.message}`);
  } else lines.push("No compile errors reported by the last sync.");
  lines.push("");
  const r = risks(files ?? [], i.interfaceChanges);
  lines.push("## What TIA Portal will likely ask", "");
  if (r.length) for (const x of r) lines.push(`- ${x}`);
  else lines.push("- Probably nothing beyond a normal download of changed blocks (no DB, UDT, interface or hardware change detected).");
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
