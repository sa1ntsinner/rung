// SPDX-License-Identifier: BUSL-1.1
// Folding ranges of SCL and structured text, from the tokens: REGIONs as TIA Portal folds them, blocks, VAR sections,
// structures, multi-line statements and comments.
import type { Doc } from "./workspace.js";

export interface Fold {
  startLine: number;
  endLine: number;
  kind?: "region" | "comment";
}

/** Each opening keyword and the keyword that closes it. */
const CLOSER: Record<string, string> = {
  REGION: "END_REGION",
  IF: "END_IF",
  CASE: "END_CASE",
  FOR: "END_FOR",
  WHILE: "END_WHILE",
  REPEAT: "END_REPEAT",
  STRUCT: "END_STRUCT",
  VAR: "END_VAR",
  VAR_INPUT: "END_VAR",
  VAR_OUTPUT: "END_VAR",
  VAR_IN_OUT: "END_VAR",
  VAR_TEMP: "END_VAR",
  VAR_STAT: "END_VAR",
  VAR_GLOBAL: "END_VAR",
  VAR_EXTERNAL: "END_VAR",
  VAR_INST: "END_VAR",
  FUNCTION_BLOCK: "END_FUNCTION_BLOCK",
  FUNCTION: "END_FUNCTION",
  ORGANIZATION_BLOCK: "END_ORGANIZATION_BLOCK",
  DATA_BLOCK: "END_DATA_BLOCK",
  TYPE: "END_TYPE",
  PROGRAM: "END_PROGRAM",
  METHOD: "END_METHOD",
  PROPERTY: "END_PROPERTY",
  ACTION: "END_ACTION",
  INTERFACE: "END_INTERFACE",
  GET: "END_GET",
  SET: "END_SET",
};
const CLOSERS = new Set(Object.values(CLOSER));

const SOURCE = /\.(scl|db|udt|awl|st)$/i;

/** The folding ranges of a source document; none for SimaticML and SIMATIC SD files. */
export function foldingRanges(doc: Doc): Fold[] {
  if (!SOURCE.test(doc.uri) && doc.code === undefined) return [];
  const tokens = doc.parsed?.tokens ?? [];
  const line = (offset: number) => doc.lines.position(offset).line;
  const folds: Fold[] = [];
  const add = (startLine: number, endLine: number, kind?: Fold["kind"]) => {
    if (endLine > startLine) folds.push(kind ? { startLine, endLine, kind } : { startLine, endLine });
  };
  const open: { closer: string; line: number; kind?: Fold["kind"] }[] = [];
  // a run of comments, each on a line of its own, on consecutive lines
  let run: { first: number; last: number } | undefined;
  const endRun = () => {
    if (run) add(run.first, run.last, "comment");
    run = undefined;
  };
  let lastLine = -1; // the line the previous token ended on
  for (const t of tokens) {
    const first = line(t.start);
    const own = first > lastLine;
    lastLine = line(Math.max(t.start, t.end - 1));
    if (t.kind === "comment") {
      if (lastLine > first) {
        endRun();
        add(first, lastLine, "comment");
      } else if (own && run && first === run.last + 1) run.last = first;
      else {
        endRun();
        if (own) run = { first, last: first };
      }
      continue;
    }
    endRun();
    if (t.kind !== "ident") continue;
    const closer = CLOSER[t.upper];
    if (closer) {
      open.push({ closer, line: line(t.start), ...(t.upper === "REGION" ? { kind: "region" as const } : {}) });
      continue;
    }
    if (!CLOSERS.has(t.upper)) continue;
    // a closer without its opener (code still being typed) closes nothing
    const at = open.map((o) => o.closer).lastIndexOf(t.upper);
    if (at < 0) continue;
    const o = open[at]!;
    open.length = at;
    // up to the line before the closing keyword, so END_IF stays in sight
    add(o.line, first - 1, o.kind);
  }
  endRun();
  return folds.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}
