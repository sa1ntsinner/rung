// SPDX-License-Identifier: BUSL-1.1
// "Did you mean ...?": the name a typo most likely meant, for messages about a name that is not there.

/** Letters to insert, delete or change to turn a into b. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/**
 * The name a typo most likely meant, ignoring letter case: two letters off at most, one for names of up to three
 * letters (Strat → Start, pul → pull, Fx_Motr → Fx_Motor). Undefined when no name is that close.
 */
export function nearest(typed: string, names: Iterable<string>): string | undefined {
  const t = typed.toLowerCase();
  const most = Math.min(2, Math.max(1, typed.length - 2));
  let best: { name: string; d: number } | undefined;
  for (const name of names) {
    const d = distance(t, name.toLowerCase());
    if (d <= most && (!best || d < best.d)) best = { name, d };
  }
  return best?.name;
}
