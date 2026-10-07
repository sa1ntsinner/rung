// SPDX-License-Identifier: MIT
// lcov tracefiles (`rung test --coverage`): line counts by file, summed over several runs.

/** Adds the lines of an lcov text into `into` (path as written → line → count). */
export function addLcov(text: string, into: Map<string, Map<number, number>> = new Map()): Map<string, Map<number, number>> {
  let lines: Map<number, number> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("SF:")) {
      const path = raw.slice(3);
      lines = into.get(path);
      if (!lines) into.set(path, (lines = new Map()));
    } else if (raw.startsWith("DA:") && lines) {
      const [line, count] = raw.slice(3).split(",").map(Number);
      if (Number.isInteger(line) && Number.isFinite(count)) lines.set(line!, (lines.get(line!) ?? 0) + count!);
    } else if (raw === "end_of_record") lines = undefined;
  }
  return into;
}
