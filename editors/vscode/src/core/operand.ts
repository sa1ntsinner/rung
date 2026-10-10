// SPDX-License-Identifier: MIT
// Operands as TIA Portal writes them ("Line_DB".Pos.x): where the dots are that quotes do not hide.

/** Index of the last dot outside quotes, -1 when there is none. */
export function lastDot(s: string): number {
  let quoted = false;
  let at = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') quoted = !quoted;
    else if (s[i] === "." && !quoted) at = i;
  }
  return at;
}

/** "Line_DB".Pos → ["Line_DB", "Pos"]: the parts between those dots, quotes taken off. */
export function splitPath(s: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let cur = "";
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    else if (c === "." && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}
