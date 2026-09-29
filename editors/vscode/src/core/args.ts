// SPDX-License-Identifier: MIT
// rung CLI arguments the extension builds, and parsers for the CLI output it reads back.
// The CLI is the backend (packages/cli/src/main.ts, plc.ts). No vscode import.
import type { DownloadDefaults, PlcConnection } from "./rungToml";

export const ALLOW_NAMES: Readonly<Record<string, string>> = {
  "stop-cpu": "stop the CPU",
  "stop-h-system": "stop the H system",
  "reinit-db": "reinitialise data blocks (actual values are lost)",
  "init-memory": "initialise memory",
  "reset-module": "reset the module (delete all)",
  "overwrite-system-data": "overwrite system data",
  "different-target": "download to a device whose configuration differs",
  "abort-active-test": "abort an active test or force job",
  "protection-level-changed": "continue although the protection level changed",
  "overwrite-memory-card": "overwrite the memory card",
  "switch-to-primary": "switch the backup CPU to primary",
  "selective-delete": "delete blocks that are not in the project",
};

const ALLOW_RE = /^[a-z][a-z0-9-]*$/;

export type HardwareChoice = "rungToml" | "include" | "exclude";

export interface DownloadOptions {
  device: string;
  hardware: HardwareChoice;
  software: boolean;
  allBlocks: boolean;
  startAfter: boolean;
  /** Extra --allow names on top of rung.toml [download].allow. */
  allow: readonly string[];
}

export function normalizeAllow(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names.flatMap((a) => a.split(","))) {
    const t = n.trim().toLowerCase();
    if (!t) continue;
    if (!ALLOW_RE.test(t)) throw new Error(`invalid --allow name: ${JSON.stringify(n)}`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * `rung download --yes …`. --yes skips the CLI's own prompt, so this is only called after the
 * extension's modal (and typed) confirmation.
 */
export function downloadArgs(o: DownloadOptions): string[] {
  if (!o.device) throw new Error("download needs a PLC name");
  if (!o.software && o.hardware === "exclude") throw new Error("nothing to download: software and hardware are both off");
  const args = ["download", "--yes", "--plc", o.device];
  if (o.hardware === "include") args.push("--hw");
  if (o.hardware === "exclude") args.push("--no-hw");
  if (!o.software) args.push("--no-sw");
  if (o.allBlocks) args.push("--all-blocks");
  if (!o.startAfter) args.push("--no-start");
  for (const a of normalizeAllow(o.allow)) args.push("--allow", a);
  return args;
}

/** What a download will do after rung.toml defaults are applied (same rules as cmdDownload). */
export function effectiveDownload(o: DownloadOptions, toml: DownloadDefaults) {
  const hardware = o.hardware === "include" ? true : o.hardware === "exclude" ? false : toml.hardware;
  const onlyChanges = o.allBlocks ? false : toml.onlyChanges;
  const startAfter = o.startAfter ? toml.startAfter : false;
  const allow = normalizeAllow([...toml.allow, ...o.allow]);
  return { hardware, software: o.software, onlyChanges, startAfter, allow, compileFirst: toml.compileFirst && o.software };
}

/** Title and detail of the modal that asks before a download. */
export function describeDownload(o: DownloadOptions, toml: DownloadDefaults, conn: PlcConnection | undefined): { message: string; detail: string } {
  const e = effectiveDownload(o, toml);
  const what = [e.software ? (e.onlyChanges ? "software (changes only)" : "software (all blocks)") : "", e.hardware ? "hardware configuration" : ""].filter(Boolean).join(" + ");
  const via = conn ? `${conn.pcInterface}${conn.targetInterface ? ` → ${conn.targetInterface}` : ""} (${conn.mode})` : "no connection in rung.toml";
  const allow = e.allow.length ? e.allow.map((a) => `${a} (${ALLOW_NAMES[a] ?? "as named"})`).join(", ") : "none. TIA Portal cancels if it wants to stop the CPU or reset data.";
  const lines = [
    `Downloads: ${what}`,
    `Connection: ${via}`,
    `Compile first: ${e.compileFirst ? "yes" : "no"}`,
    `Start the CPU afterwards: ${e.startAfter ? "yes, if this download stopped it" : "no"}`,
    `Questions answered "yes": ${allow}`,
    "",
    "This changes the program running on the machine. Only continue if it is safe to do so.",
  ];
  return { message: `Download to ${o.device}?`, detail: lines.join("\n") };
}

export interface RefusedQuestion {
  name: string;
  message?: string;
}

/** After exit code 3: the --allow names TIA asked for, from "run again with --allow a,b". */
export function parseNeedsAllow(output: string): string[] {
  const m = /run again with --allow ([a-z0-9,-]+)/i.exec(output);
  return m ? normalizeAllow([m[1]!]) : [];
}

/** Decision lines marked ✗ ("  ✗ pre  stop-cpu    NoAction  (message)"). */
export function parseRefused(output: string): RefusedQuestion[] {
  const out: RefusedQuestion[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*✗\s+\S+\s+(\S+)\s+\S+(?:\s+\((.*)\))?\s*$/.exec(line);
    if (m) out.push(m[2] ? { name: m[1]!, message: m[2] } : { name: m[1]! });
  }
  return out;
}

/** "PLC_1: Online" → { device, state } (last matching line). */
export function parseOnlineState(output: string): { device: string; state: string } | undefined {
  let found: { device: string; state: string } | undefined;
  for (const line of output.split(/\r?\n/)) {
    const m = /^(\S.*?): ([A-Za-z]+)\s*$/.exec(line);
    if (m && !line.startsWith("rung:") && !line.startsWith("hint:")) found = { device: m[1]!, state: m[2]! };
  }
  return found;
}

export interface CompileMessage {
  severity: "error" | "warning" | "info";
  file?: string;
  line?: number;
  where?: string;
  message: string;
}

/** Lines printed by `rung compile`: "  error    plc/A/blocks/Main.scl:12 — text". */
export function parseCompileOutput(output: string): CompileMessage[] {
  const out: CompileMessage[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^ {2}(error|warning|info)\s+(?:(.+?) — )?(.*)$/i.exec(line);
    if (!m) continue;
    const msg: CompileMessage = { severity: m[1]!.toLowerCase() as CompileMessage["severity"], message: m[3]!.trim() };
    const where = m[2];
    if (where) {
      const f = /^(plc\/.+?)(?::(\d+))?$/.exec(where);
      if (f) {
        msg.file = f[1]!;
        if (f[2]) msg.line = Number(f[2]);
      } else msg.where = where;
    }
    out.push(msg);
  }
  return out;
}

/** TIA's closing "Compiling finished (errors: 1; warnings: 0)" line, which rung prints as a message of its own. */
export const isCompileSummary = (message: string) => /^Compiling finished\b/i.test(message.trim());

export interface InterfaceOption {
  mode: string;
  pcInterface: string;
  pcInterfaceNumber: number;
  targetInterface: string;
  reachable: string[];
}

/** `rung interfaces --scan` output → one option per (mode, PG/PC interface, target interface). */
export function parseInterfaces(output: string): InterfaceOption[] {
  const out: InterfaceOption[] = [];
  let mode: string | undefined;
  let current: InterfaceOption[] = [];
  for (const line of output.split(/\r?\n/)) {
    const mm = /^mode "(.*)"\s*$/.exec(line);
    if (mm) {
      mode = mm[1]!;
      current = [];
      continue;
    }
    const pm = /^ {2}pc_interface "(.*?)" \(number (\d+)\)(?:\s+targets: (.*))?$/.exec(line);
    if (pm && mode !== undefined) {
      const targets = [...(pm[3] ?? "").matchAll(/"([^"]*)"/g)].map((t) => t[1]!);
      current = targets.map((t) => ({ mode: mode!, pcInterface: pm[1]!, pcInterfaceNumber: Number(pm[2]), targetInterface: t, reachable: [] }));
      out.push(...current);
      continue;
    }
    const rm = /^ {6}reachable: (.*)$/.exec(line);
    if (rm) for (const c of current) c.reachable.push(rm[1]!.trim());
  }
  return out;
}

/** Arguments for the simple commands, shared by palette, views, CodeLens and keys. */
export const Args = {
  compileFile: (file: string, device?: string) => ["compile", "--file", file, ...(device ? ["--plc", device] : [])],
  compilePlc: (device?: string) => ["compile", ...(device ? ["--plc", device] : [])],
  compileHardware: (device?: string) => ["compile", "--hw", ...(device ? ["--plc", device] : [])],
  testAll: () => ["test"],
  testBlock: (name: string) => ["test", "--filter", name],
  online: (device?: string) => ["online", ...(device ? ["--plc", device] : [])],
  offline: (device?: string) => ["online", "--off", ...(device ? ["--plc", device] : [])],
  onlineState: (device?: string) => ["online", "--state", ...(device ? ["--plc", device] : [])],
  interfaces: (device?: string, scan = true) => ["interfaces", ...(scan ? ["--scan"] : []), ...(device ? ["--plc", device] : [])],
  open: (file: string) => ["open", file],
  resolve: (file: string, mode: "ours" | "theirs") => ["resolve", file.replace(/\.(conflict|tia)$/, ""), `--${mode}`],
  init: (project: string) => ["init", "--project", project],
  compare: (device?: string) => ["compare", "--json", ...(device ? ["--plc", device] : [])],
  rename: (file: string, newName: string) => ["rename", file, newName],
} as const;

export interface CompareItem {
  path: string;
  name: string;
  state: "Different" | "OnlyInProject" | "OnlyOnPlc" | string;
  file?: string;
}

/** The JSON `rung compare --json` prints (stdout may be preceded by progress lines on stderr). */
export function parseCompare(output: string): { identical: number; items: CompareItem[] } | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    const r = JSON.parse(output.slice(start, end + 1)) as { identical?: number; items?: CompareItem[] };
    return Array.isArray(r.items) ? { identical: r.identical ?? 0, items: r.items } : undefined;
  } catch {
    return undefined;
  }
}

/** Workspace file of the renamed object, from `renamed A to B: old → new`. */
export function parseRenamed(output: string): string | undefined {
  return /^renamed .* → (\S.*)$/m.exec(output)?.[1]?.trim();
}

/** One line of `rung check --json`. */
export interface CheckItem {
  id: string;
  group: string;
  name: string;
  status: "ok" | "warn" | "missing";
  detail?: string;
  enables?: string;
  fix?: string;
  link?: string;
}

/** The JSON array `rung check --json` prints (progress lines may come before it). */
export function parseCheck(output: string): CheckItem[] | undefined {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) return undefined;
  try {
    const items = JSON.parse(output.slice(start, end + 1)) as CheckItem[];
    return Array.isArray(items) ? items : undefined;
  } catch {
    return undefined;
  }
}
