// SPDX-License-Identifier: BUSL-1.1
// rung report: what a bug report needs (versions, this PC's checks, the workspace's shape), as Markdown to paste into
// an issue. Nothing of the project goes in: no names of blocks, PLCs or projects, no paths, no addresses, no code.
import { readFile } from "node:fs/promises";
import { release as osRelease } from "node:os";
import { join } from "node:path";
import { loadConfig, readWrites, realProbes, runChecks, writesGranted, type CheckItem } from "@rung/core";
import { findWorkspace, type Io } from "./common.js";
import { VERSION } from "./main.js";

export interface ReportInput {
  dir: string;
  checks: CheckItem[];
  platform: string;
  release: string;
  node: string;
  home: string;
}

/** Paths, the user's home and IPv4 addresses out of a free text (check details name install folders). */
function scrub(text: string, home: string): string {
  let t = home ? text.split(home).join("~") : text;
  // a Windows path runs to the end of the text or to a separator (folders have spaces: Program Files)
  t = t.replace(/[A-Za-z]:\\.*?(?=$|,\s|;|\s\()/g, "<path>").replace(/(?:~|\/)[^\s,;)]*\/[^\s,;)]*/g, "<path>");
  return t.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<address>");
}

function count<T>(items: T[], key: (item: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const item of items) m.set(key(item), (m.get(key(item)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

async function workspaceLines(dir: string): Promise<string[]> {
  let root: string;
  try {
    root = await findWorkspace(dir);
  } catch {
    return ["no rung workspace here (run rung report inside one to include its shape)"];
  }
  const config = await loadConfig(root, { raw: true });
  const writes = writesGranted(await readWrites(root), config);
  const out = [
    "| | |", "|---|---|",
    `| engineering | ${config.project.tiaVersion} |`,
    `| PLCs mirrored | ${config.devices.length || "all"} |`,
    `| writes to the project | ${writes ? "on" : "off"} (import ${config.sync.import}, compile ${config.sync.compile}, backup ${config.sync.backup}) |`,
    `| TIA Portal start | ${config.tia.start}${config.bridge.host ? ", bridge over ssh" : ""}${config.bridge.command ? ", own bridge command" : ""} |`,
    `| download | ${config.download.enabled ? "enabled" : "off"} |`,
  ];
  for (const plc of Object.values(config.live?.plc ?? {}))
    out.push(`| online | ${plc.transport}, ${plc.readOnly || !plc.allowWrites ? "read-only" : "writes allowed"}, certificate ${plc.certificateSha256 ? "pinned" : "not pinned"} |`);
  if (config.live?.webapi) out.push("| online | webapi |");
  try {
    const doc = JSON.parse(await readFile(join(root, ".rung", "state.json"), "utf8")) as { objects: Record<string, { form: string; status: string; readOnly: boolean }> };
    const objects = Object.values(doc.objects);
    out.push(`| objects | ${objects.length} (${objects.filter((o) => o.readOnly).length} read-only) |`);
    for (const [status, n] of count(objects, (o) => o.status)) out.push(`| ${status} | ${n} |`);
    for (const [form, n] of count(objects, (o) => o.form)) out.push(`| ${form} files | ${n} |`);
  } catch {
    out.push("| objects | not pulled yet |");
  }
  return out;
}

export async function buildReport(input: ReportInput): Promise<string> {
  const lines = [
    "## rung report",
    "",
    `rung ${VERSION} · ${input.platform} ${input.release} · node ${input.node}`,
    "",
    "### This PC",
    "",
    "| check | status | found | fix |", "|---|---|---|---|",
    ...input.checks.map((c) => `| ${c.name} | ${c.status} | ${scrub(c.detail ?? "", input.home)} | ${c.status === "ok" ? "" : scrub(c.fix ?? "", input.home)} |`),
    "",
    "### Workspace",
    "",
    ...(await workspaceLines(input.dir)),
    "",
    "No code, names, paths or addresses from your project are in this report. Read it before you post it:",
    "https://github.com/sa1ntsinner/rung/issues/new",
    "",
  ];
  return lines.join("\n");
}

export async function cmdReport(dir: string, io: Io): Promise<number> {
  const { whitelistHere } = await import("./setup.js");
  const checks = await runChecks(realProbes(io.env, () => whitelistHere(io.env)));
  io.stdout(await buildReport({ dir, checks, platform: process.platform, release: osRelease(), node: process.version, home: io.env.USERPROFILE ?? io.env.HOME ?? "" }));
  return 0;
}
