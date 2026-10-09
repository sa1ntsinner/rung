// SPDX-License-Identifier: MIT
// What monitoring shows at the end of a line (pure, for tests).
import { fileURLToPath } from "node:url";

export interface MonitorPlan {
  block: string;
  instance?: string;
  vars: Record<string, string>;
  lines: Record<string, string[]>;
}

/** How a value reads at the end of a line: TRUE/FALSE like TIA Portal, reals shortened, strings quoted. */
export function formatValue(v: unknown): string {
  if (v === undefined) return "…";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
  if (typeof v === "string") return `'${v}'`;
  return JSON.stringify(v);
}

/** Historical replay uses its own labels; live observed values never enter this display. */
export function reconstructedLines(result: unknown, uri: string): Record<number, string> {
  const r = result as { kind?: string; exact?: boolean; freshness?: string; reason?: string;
    trace?: { uri: string; line: number; kind: string; value?: unknown }[]; divergences?: unknown[] } | null;
  if (r?.kind !== "reconstructed" || r.exact !== false || !["capture-only", "native-sample"].includes(r.freshness ?? "")
    || !Array.isArray(r.trace) || r.trace.length > 10_000 || !Array.isArray(r.divergences)) throw new Error(r?.reason ?? "Invalid reconstruction result");
  const lines: Record<number, string> = { 0: `reconstructed: ${r.freshness === "native-sample" ? "native sample" : "historical capture"} · ${r.divergences.length} divergence(s) · PLC execution unverified` };
  const values = new Map<number, string[]>();
  const sourcePath = (source: string) => process.platform === "win32" ? fileURLToPath(source).toLowerCase() : fileURLToPath(source);
  for (const entry of r.trace) {
    if (sourcePath(entry.uri) !== sourcePath(uri)) continue;
    if (!Number.isSafeInteger(entry.line) || entry.line < 1) throw new Error("Invalid reconstruction source line");
    const line = entry.line - 1;
    if (entry.kind === "statement") lines[line] ??= "reconstructed: executed";
    if (entry.kind === "expression") {
      const row = values.get(line) ?? [];
      // ponytail: eight values per line; the complete trace remains in CLI JSON.
      if (row.length < 8) row.push(formatValue(entry.value).slice(0, 120));
      values.set(line, row);
    }
  }
  for (const [line, row] of values) lines[line] = `${lines[line] ?? "reconstructed"} · ${row.join(" → ")}`;
  return lines;
}

/** Each declaration row's value while monitoring: the plan labels a row by its path of names (Motor.Speed). */
export function rowValues(sections: readonly { rows: readonly MonitoredRow[] }[], plan: Pick<MonitorPlan, "vars">, values: Record<string, unknown>, errors: Record<string, string>, display?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rows: readonly MonitoredRow[], prefix: string) => {
    for (const r of rows) {
      const label = prefix ? `${prefix}.${r.name}` : r.name;
      if (label in plan.vars) out[r.id] = label in errors ? "?" : display?.[label] ?? formatValue(values[label]);
      else {
        // an array: the page of elements monitoring reads, in order
        const elements = Object.keys(plan.vars).filter((k) => k.startsWith(`${label}[`));
        if (elements.length) out[r.id] = `[${elements.map((k) => (k in errors ? "?" : display?.[k] ?? formatValue(values[k]))).join(", ")}${elements.length >= 16 ? ", …" : ""}]`;
      }
      if (r.children) walk(r.children, label);
    }
  };
  for (const s of sections) walk(s.rows, "");
  return out;
}

export interface MonitoredRow {
  id: string;
  name: string;
  children?: readonly MonitoredRow[];
}

/** The text after a line: `Lit = TRUE   On = TRUE`; a value that could not be read shows as ?. */
export function lineText(labels: readonly string[], values: Record<string, unknown>, errors: Record<string, string>, display?: Record<string, string>): string {
  return labels.map((l) => `${l.replace(/^#/, "")} = ${l in errors ? "?" : display?.[l] ?? formatValue(values[l])}`).join("   ");
}

/** A read error in words: the Web API's code number dropped, "Address does not exist" said as what it means. */
export function readError(e: string): string {
  const text = e.replace(/^\s*-?\d+\s*:\s*/, "");
  const missing = /^Address does not exist\s*:?\s*(.*)$/i.exec(text);
  return missing ? `not in the PLC's program (a typo, or not downloaded yet)${missing[1] ? `: ${missing[1]}` : ""}` : text;
}
