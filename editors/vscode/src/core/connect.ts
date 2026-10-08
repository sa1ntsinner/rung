// SPDX-License-Identifier: MIT
// `rung connect` for editors: the JSON of `rung connect --json`, the NO_TARGET errors of `rung online` /
// `rung download`, and the arguments that save a chosen connection. No vscode import.
import type { PlcConnection } from "./rungToml";

export interface ConnectTarget {
  mode: string;
  pcInterface: string;
  pcInterfaceNumber?: number;
  targetInterface?: string;
}

export interface ConnectChoice {
  target: ConnectTarget;
  label: string;
  reason: "address-match" | "simulation" | "reachable" | string;
  found?: { name?: string; address?: string; deviceSeries?: string };
}

export interface ConnectReport {
  device: string;
  saved: ConnectTarget | null;
  configuredInTia: boolean;
  candidates: ConnectChoice[];
  reachable: ConnectChoice[];
  /** Explanation when nothing answered (candidates empty). */
  notFound: string | null;
}

/** Parses the output of `rung connect --json` (stderr lines around the JSON are ignored). */
export function parseConnectJson(output: string): ConnectReport | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const j = JSON.parse(output.slice(start, end + 1)) as Partial<ConnectReport>;
    if (typeof j.device !== "string" || !Array.isArray(j.candidates)) return undefined;
    const choices = (list: unknown): ConnectChoice[] =>
      (Array.isArray(list) ? list : []).filter((c): c is ConnectChoice => !!c && typeof c === "object" && typeof (c as ConnectChoice).target?.pcInterface === "string" && typeof (c as ConnectChoice).target?.mode === "string");
    return {
      device: j.device,
      saved: j.saved && typeof j.saved === "object" ? j.saved : null,
      configuredInTia: !!j.configuredInTia,
      candidates: choices(j.candidates),
      reachable: choices(j.reachable),
      notFound: typeof j.notFound === "string" ? j.notFound : null,
    };
  } catch {
    return undefined;
  }
}

export type NoTarget =
  /** Several ways (or only devices under other addresses) reach the PLC: the user has to choose. */
  | { kind: "choose"; message: string }
  /** Nothing answered; `message` is rung's explanation (several lines). */
  | { kind: "notFound"; message: string }
  /** No connection and nothing to decide from (e.g. "no connection chosen"). */
  | { kind: "other"; message: string };

/**
 * Recognises the NO_TARGET error of `rung online` / `rung download` in their output:
 * "rung: NO_TARGET: <message, possibly several lines>" (followed by an optional "hint:" line).
 */
export function parseNoTarget(output: string): NoTarget | undefined {
  const m = /^rung: NO_TARGET: ([\s\S]*)$/m.exec(output);
  if (!m) return undefined;
  const message = m[1]!
    .split(/\r?\n/)
    .filter((l) => !/^hint: /.test(l))
    .join("\n")
    .trim();
  if (/was not found on the network/.test(message)) return { kind: "notFound", message };
  if (/rung connect --pick/.test(message)) return { kind: "choose", message };
  return { kind: "other", message };
}

/** `rung connect --use …` saving `t` as [plc.<device>]. */
export function connectUseArgs(device: string, t: ConnectTarget): string[] {
  return [
    "connect",
    "--use",
    t.pcInterface,
    ...(t.targetInterface ? ["--target", t.targetInterface] : []),
    "--mode",
    t.mode,
    "--number",
    String(t.pcInterfaceNumber ?? 1),
    "--plc",
    device,
  ];
}

export function sameTarget(a: ConnectTarget | PlcConnection | null | undefined, b: ConnectTarget | PlcConnection | null | undefined): boolean {
  return !!a && !!b && a.mode === b.mode && a.pcInterface === b.pcInterface && (a.pcInterfaceNumber ?? 1) === (b.pcInterfaceNumber ?? 1) && (a.targetInterface ?? "") === (b.targetInterface ?? "");
}

/** The pick rung itself would make without asking: one address match, else one simulation. */
export function automaticChoice(r: ConnectReport): ConnectChoice | undefined {
  const matches = r.candidates.filter((c) => c.reason === "address-match");
  const sims = r.candidates.filter((c) => c.reason === "simulation");
  if (matches.length === 1) return matches[0];
  if (matches.length === 0 && sims.length === 1) return sims[0];
  return undefined;
}

/** "PLC_1 was not found on the network." + the rest, for a modal title and detail. */
export function splitExplanation(text: string): { title: string; detail: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { title: lines[0] ?? "The PLC was not found.", detail: lines.slice(1).join("\n\n") };
}
