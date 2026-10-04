// SPDX-License-Identifier: MIT
// The extension applies a table's planned edit only to the text it was planned against: the same document version
// and, under every range, the same old text. Anything else is refused and the view keeps its draft.

export interface Pos {
  line: number;
  character: number;
}
export interface Rng {
  start: Pos;
  end: Pos;
}

/** What the language server answers to rung/declarationEdit. */
export type ServerPlan = { ok: true; version: number; edits: { range: Rng; old: string; newText: string }[] } | { ok: false; reason: string };

/** The part of a TextDocument the check reads. */
export interface TextSnapshot {
  version: number;
  getText(range: Rng): string;
}

export const STALE = "The file changed. Review this value again.";

export function checkPlan(doc: TextSnapshot, plan: ServerPlan): { ok: true; edits: { range: Rng; newText: string }[] } | { ok: false; reason: string } {
  if (!plan.ok) return { ok: false, reason: plan.reason };
  if (plan.version !== doc.version) return { ok: false, reason: STALE };
  for (const e of plan.edits) if (doc.getText(e.range) !== e.old) return { ok: false, reason: STALE };
  return { ok: true, edits: plan.edits.map((e) => ({ range: e.range, newText: e.newText })) };
}
