// SPDX-License-Identifier: MIT
// The test explorer's model of tests/**/*.test.yaml: the cases a file lists (found without running rung), and
// the results `rung test --json` prints, with the line of every case and of every step that failed.

export interface CaseEntry {
  name: string;
  /** Line of the case in the file, from 0. */
  line: number;
}

export interface TestFailure {
  step: number;
  name: string;
  expected: unknown;
  actual: unknown;
  /** Line of the step, from 1 (as rung prints it). */
  line?: number;
  /** within / always / never: when or how it broke. */
  note?: string;
}

export interface CaseResult {
  name: string;
  /** The case's place in its file, from 0 (rung test --case runs one and keeps its place). */
  index?: number;
  passed: boolean;
  failures: TestFailure[];
  error?: string;
  ms: number;
  line?: number;
  /** For an error: the step it stopped in (from 1) and that step's line (from 1). */
  errorStep?: number;
  errorLine?: number;
}

export interface FileResult {
  file: string;
  block: string;
  plc?: string;
  cases: CaseResult[];
  error?: string;
}

/** Exit 3 from rung test means no cases matched; errors use 1 and failures use 2. */
export function noTestsHint(name: string, code: number | null): string | undefined {
  return code === 3 ? `No tests for ${name}. --filter matches a test path substring or the exact block name. Add tests/${name}.test.yaml with block: ${name}.` : undefined;
}

/**
 * The cases of a test file, read line by line (the file may be half-written while it is edited; the run
 * brings rung's own reading of it): `- name: …` entries under `cases:`, and cases without a name as "case N".
 */
export function casesIn(text: string): CaseEntry[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^cases\s*:/.test(l));
  if (start < 0) return [];
  const out: CaseEntry[] = [];
  let indent: number | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\S/.test(l) && !/^-/.test(l)) break; // the next top-level key
    const m = /^(\s*)-\s*(\{\s*)?(.*)$/.exec(l);
    if (!m) continue;
    const depth = m[1]!.length;
    indent ??= depth;
    if (depth !== indent) continue; // a step or a list inside a case
    // - name: starts, latches and stops   /   - { name: stops, steps: [...] }
    const rest = m[3]!;
    const name = m[2] ? /(?:^|[\s,])name\s*:\s*("[^"]*"|'[^']*'|[^,}#]*)/.exec(rest)?.[1]?.trim() : /^name\s*:\s*("[^"]*"|'[^']*'|.*?)\s*(?:\s#.*)?$/.exec(rest)?.[1];
    out.push({ name: name ? unquote(name) : `case ${out.length + 1}`, line: i });
  }
  return out;
}

/** The block a test file tests (its top-level block:), if it names one. */
export function blockOf(text: string): string | undefined {
  const m = /^block\s*:\s*("[^"]*"|'[^']*'|[^#\r\n]*?)\s*(?:#.*)?$/m.exec(text);
  return m?.[1] ? unquote(m[1]) : undefined;
}

const unquote = (s: string) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);

/** The JSON `rung test --json` printed, out of everything the process wrote (warnings may come before it). */
export function parseResults(output: string): FileResult[] | undefined {
  const start = output.indexOf('{\n  "files"');
  const from = start >= 0 ? start : output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (from < 0 || end < from) return undefined;
  try {
    const r = JSON.parse(output.slice(from, end + 1)) as { files?: FileResult[] };
    return Array.isArray(r.files) ? r.files : undefined;
  } catch {
    return undefined;
  }
}

/** A failure as the explorer shows it: which step and name, and the two values to compare. */
export function failureText(f: TestFailure): { message: string; expected: string; actual: string } {
  const show = (v: unknown) => (typeof v === "string" && /^<.*>$/.test(v) ? v : JSON.stringify(v));
  return { message: `step ${f.step}: ${f.name} expected ${JSON.stringify(f.expected)} got ${show(f.actual)}${f.note ? ` (${f.note})` : ""}`, expected: show(f.expected), actual: show(f.actual) };
}
