// SPDX-License-Identifier: MIT
// What monitoring shows at the end of a line (pure, for tests).

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

/** The text after a line: `Lit = TRUE   On = TRUE`; a value that could not be read shows as ?. */
export function lineText(labels: readonly string[], values: Record<string, unknown>, errors: Record<string, string>): string {
  return labels.map((l) => `${l.replace(/^#/, "")} = ${l in errors ? "?" : formatValue(values[l])}`).join("   ");
}
