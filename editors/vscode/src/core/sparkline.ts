// SPDX-License-Identifier: MIT
const BARS = "▁▂▃▄▅▆▇█";

/** The last values as a little line: numbers scaled between their minimum and maximum, booleans low/high. */
export function sparkline(history: unknown[]): string {
  const xs = history.slice(-16).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : NaN));
  if (xs.length < 2 || xs.some((x) => Number.isNaN(x))) return "";
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return xs.map((x) => BARS[hi === lo ? 0 : Math.round(((x - lo) / (hi - lo)) * (BARS.length - 1))]).join("");
}
