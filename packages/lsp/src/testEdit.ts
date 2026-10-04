// SPDX-License-Identifier: BUSL-1.1
// The text edits a test table makes (rung/testEdit): each changes only its own text, in the style the file already
// uses (flow { a: 1 } or block maps), keeps comments, blank lines and CRLF, and quotes only what YAML needs quoted.
// Every edit carries the old text it replaces, so the editor refuses it on text that has changed since.
import type { TCase, TEntry, TMap, TRange, TStep, TestModel } from "./testModel.js";

export type Part = "set" | "expect";
export type RunKind = "cycle" | "advance";

export type TestOp =
  | { op: "setValue"; case: number; step: number; part: Part; key: string; value: string }
  | { op: "setKey"; case: number; step: number; part: Part; key: string; newKey: string }
  | { op: "addEntry"; case: number; step: number; part: Part; key: string; value: string }
  | { op: "removeEntry"; case: number; step: number; part: Part; key: string }
  /** value null removes the cycle count or the time */
  | { op: "setRun"; case: number; step: number; kind: RunKind; value: string | null }
  | { op: "addStep"; case: number; after?: number; kind: Part | RunKind }
  | { op: "removeStep"; case: number; step: number }
  | { op: "moveStep"; case: number; step: number; by: -1 | 1 }
  | { op: "addCase"; name: string; after?: number }
  | { op: "renameCase"; case: number; name: string }
  | { op: "duplicateCase"; case: number; name: string }
  | { op: "removeCase"; case: number };

export interface TestEdit {
  start: number;
  end: number;
  old: string;
  text: string;
}

export type TestPlan = { ok: true; edits: TestEdit[] } | { ok: false; reason: string };

const lineStart = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1;
/** just past the line's EOL (or the text's end) */
const lineEnd = (text: string, at: number) => {
  const n = text.indexOf("\n", at);
  return n < 0 ? text.length : n + 1;
};
const indentAt = (text: string, at: number) => /^[ \t]*/.exec(text.slice(lineStart(text, at)))![0];
const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");
const column = (text: string, at: number) => at - lineStart(text, at);

/**
 * A scalar as YAML reads it back unchanged: plain when it can be, else single-quoted. In a flow map ({ … }) commas
 * and brackets need quotes too. Values are kept as typed (true, 1.5, T#500ms, -3); only syntax decides the quotes.
 */
export function yamlScalar(value: string, flow: boolean, asString = false): string {
  const t = value.trim();
  if (!t) return "''";
  const plain =
    !/^[\s'"#&*!|>%@`{}[\],?:]/.test(t) &&
    !(/^-/.test(t) && !/^-\d/.test(t)) &&
    !/:(\s|$)|\s#|[\r\n\t]/.test(t) &&
    !(flow && /[,[\]{}]/.test(t));
  // a text that YAML would read as a number, a Boolean or null stays text where the value is one (a name, a STRING)
  return plain && !(asString && NOT_TEXT.test(t)) ? t : `'${t.replace(/'/g, "''")}'`;
}

/** what YAML's core schema reads as something other than a string */
const NOT_TEXT = /^(true|false|null|~|[-+]?(\d[\d_]*|0x[0-9a-f]+|0o[0-7]+)(\.\d*)?([eE][-+]?\d+)?|[-+]?\.(inf|nan)|[-+]?\.\d+([eE][-+]?\d+)?)$/i;

/** A new value in the quotes the old one was written in ("…" stays "…", '…' stays '…'), else as yamlScalar. */
function styled(old: string, value: string, flow: boolean, asString = false): string {
  const t = value.trim();
  if (old.startsWith('"')) return JSON.stringify(t);
  if (old.startsWith("'")) return `'${t.replace(/'/g, "''")}'`;
  return yamlScalar(t, flow, asString);
}

const FLOW = "These cases or steps are written on one line ([ … ]): change their order or number in the text.";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The lines a step or case takes, with the comment lines just above it (they belong to it when it moves or goes). */
function region(text: string, r: TRange, floor: number): TRange {
  let start = lineStart(text, r.start);
  for (;;) {
    const prev = lineStart(text, start - 1);
    if (start === 0 || prev < floor || !/^\s*#/.test(text.slice(prev, start))) break;
    start = prev;
  }
  return { start, end: lineEnd(text, Math.max(r.start, r.end - 1)) };
}

/** A part of a step (set/expect/cycle/advance) as a pair: its key .. its value. */
function parts(step: TStep): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  for (const name of ["set", "expect"] as const) {
    const m = step[name];
    if (m) out.push({ name, start: m.keyRange.start, end: m.range.end });
  }
  for (const name of ["cycle", "advance"] as const) {
    const v = step[name];
    if (v) out.push({ name, start: v.keyRange.start, end: v.range.end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** isString: whether a key names a STRING/CHAR variable (its value is written as text whatever it looks like) */
export function planTestEdit(text: string, model: TestModel, op: TestOp, opts: { isString?: (key: string) => boolean } = {}): TestPlan {
  const ok = (...edits: TestEdit[]): TestPlan => ({ ok: true, edits });
  const edit = (start: number, end: number, t: string): TestEdit => ({ start, end, old: text.slice(start, end), text: t });
  const fail = (reason: string): TestPlan => ({ ok: false, reason });
  const eol = eolOf(text);
  if (model.errors.length) return fail("The file has YAML errors. Fix them in the text first.");

  if (op.op === "addCase") {
    const name = op.name.trim();
    if (!name) return fail("A case needs a name.");
    if (model.cases.some((c) => c.name && same(c.name.value, name))) return fail(`The file already has a case "${name}".`);
    const ref = model.cases[op.after ?? model.cases.length - 1];
    if (!ref) return fail("The file has no cases: list to add to. Add the first case in the text.");
    if (model.casesFlow || ref.flow) return fail(FLOW);
    const keyCol = column(text, ref.range.start);
    const dash = " ".repeat(Math.max(0, keyCol - 2));
    const stepDash = ref.steps[0] ? indentAt(text, ref.steps[0].range.start) : " ".repeat(keyCol + 2);
    const at = region(text, ref.range, 0).end;
    const lead = at === text.length && text.length && !text.endsWith("\n") ? eol : "";
    return ok(edit(at, at, `${lead}${dash}- name: ${yamlScalar(name, false, true)}${eol}${" ".repeat(keyCol)}steps:${eol}${stepDash}- cycle: 1${eol}`));
  }

  const c: TCase | undefined = model.cases[op.case];
  if (!c) return fail(`No case ${op.case + 1}.`);
  // cases or steps written on one line ([ … ], { … }): their values edit, their structure is the text's
  const structural = op.op === "duplicateCase" || op.op === "removeCase" ? model.casesFlow || c.flow : op.op === "addStep" || op.op === "removeStep" || op.op === "moveStep" ? c.flow || c.stepsFlow || model.casesFlow : false;
  if (structural) return fail(FLOW);
  const caseFloor = c.range.start;

  if (op.op === "renameCase" || op.op === "duplicateCase") {
    const name = op.name.trim();
    if (!name) return fail("A case needs a name.");
    if (model.cases.some((x) => x !== c && x.name && same(x.name.value, name)) || (op.op === "duplicateCase" && c.name && same(c.name.value, name))) return fail(`The file already has a case "${name}".`);
    if (!c.name) return fail("This case has no name: line to change. Edit it in the text.");
    if (op.op === "renameCase") return ok(edit(c.name.range.start, c.name.range.end, yamlScalar(name, false, true)));
    // the copy: the case's lines as they are, with the new name
    const from = lineStart(text, c.range.start);
    const to = lineEnd(text, Math.max(c.range.start, c.range.end - 1));
    let copy = text.slice(from, to);
    copy = copy.slice(0, c.name.range.start - from) + yamlScalar(name, false, true) + copy.slice(c.name.range.end - from);
    if (!copy.endsWith("\n")) copy += eol;
    const lead = to === text.length && !text.endsWith("\n") ? eol : "";
    return ok(edit(to, to, lead + copy));
  }

  if (op.op === "removeCase") {
    if (model.cases.length === 1) return fail("A test file needs a case. Delete the file instead.");
    const prev = model.cases[op.case - 1];
    const g = region(text, c.range, prev ? lineEnd(text, prev.range.end - 1) : 0);
    return ok(edit(g.start, g.end, ""));
  }

  if (op.op === "addStep") {
    const ref = c.steps[op.after ?? c.steps.length - 1];
    if (!ref) return fail("This case has no steps: list. Add the first step in the text.");
    const dash = indentAt(text, ref.range.start);
    const at = region(text, ref.range, caseFloor).end;
    const body = op.kind === "cycle" ? "cycle: 1" : op.kind === "advance" ? "advance: 100ms" : `${op.kind}: {}`;
    const lead = at === text.length && !text.endsWith("\n") ? eol : "";
    return ok(edit(at, at, `${lead}${dash}- ${body}${eol}`));
  }

  const step: TStep | undefined = c.steps[op.step];
  if (!step) return fail(`No step ${op.step + 1} in this case.`);
  const stepFloor = (i: number) => (i > 0 ? lineEnd(text, c.steps[i - 1]!.range.end - 1) : caseFloor);

  if (op.op === "removeStep") {
    if (c.steps.length === 1) return fail("A case needs a step. Delete the case instead.");
    const g = region(text, step.range, stepFloor(op.step));
    return ok(edit(g.start, g.end, ""));
  }

  if (op.op === "moveStep") {
    const j = op.step + op.by;
    const other = c.steps[j];
    if (!other) return fail("The step is already at that end of the case.");
    const [a, ai, b] = op.by < 0 ? [other, j, step] : [step, op.step, other];
    const ga = region(text, a.range, stepFloor(ai));
    const gb = region(text, b.range, ga.end);
    let ta = text.slice(ga.start, ga.end);
    let tb = text.slice(gb.start, gb.end);
    // the last line of the file may have no EOL: the swapped text still ends as the file did
    const lastNoEol = !tb.endsWith("\n");
    if (lastNoEol) tb += eol;
    if (lastNoEol) ta = ta.replace(/\r?\n$/, "");
    // what stands between them (a blank line) stays between them
    return ok(edit(ga.start, gb.end, tb + text.slice(ga.end, gb.start) + ta));
  }

  /** Removes a whole part (set:, cycle: …) from the step, in the step's own style. */
  const removePart = (name: string): TestPlan => {
    const list = parts(step);
    const i = list.findIndex((p) => p.name === name);
    if (i < 0) return ok();
    if (list.length === 1) return fail("A step needs something to do. Delete the step instead.");
    const p = list[i]!;
    if (step.flow) {
      // as an entry of the step's { … }: its comma goes with it
      if (i < list.length - 1) return ok(edit(p.start, list[i + 1]!.start, ""));
      return ok(edit(list[i - 1]!.end, p.end, ""));
    }
    // the first key stands on the step's dash line: the next key moves up there
    if (i === 0) return ok(edit(p.start, list[1]!.start, ""));
    return ok(edit(lineStart(text, p.start), lineEnd(text, p.end - 1), ""));
  };

  /** Adds a part the step does not have yet (expect: { … }, cycle: 2), in the step's own style. */
  const addPart = (body: string): TestPlan => {
    if (step.flow) {
      let at = step.range.end - 1;
      while (at > step.range.start && /\s/.test(text[at - 1]!)) at--;
      return ok(edit(at, at, `, ${body}`));
    }
    const at = lineEnd(text, step.range.end - 1);
    const lead = at === text.length && !text.endsWith("\n") ? eol : "";
    return ok(edit(at, at, `${lead}${" ".repeat(column(text, step.range.start))}${body}${eol}`));
  };

  if (op.op === "setRun") {
    const cur = step[op.kind];
    const v = op.value?.trim();
    if (!v) return removePart(op.kind);
    if (op.kind === "cycle" && !/^[1-9]\d*$/.test(v)) return fail("Cycles are a whole number, 1 or more.");
    if (op.kind === "advance" && !/^(L?T#)?(\d+(\.\d+)?(ms|s|m|h|d)_?)+$/i.test(v)) return fail(`"${v}" is not a time: write it with a unit (200ms, 2s, T#1m).`);
    if (cur) return ok(edit(cur.range.start, cur.range.end, yamlScalar(v, step.flow)));
    return addPart(`${op.kind}: ${yamlScalar(v, step.flow)}`);
  }

  const map: TMap | undefined = step[op.part];
  const find = (key: string): TEntry | undefined => map?.entries.find((e) => e.key === key);

  if (op.op === "addEntry") {
    const key = op.key.trim();
    if (!key) return fail("A name is needed.");
    if (map?.entries.some((e) => same(e.key, key))) return fail(`This step already ${op.part === "set" ? "sets" : "expects"} ${key}.`);
    const str = !!opts.isString?.(key);
    if (!map) return addPart(`${op.part}: { ${yamlScalar(key, true, true)}: ${yamlScalar(op.value, true, str)} }`);
    const last = map.entries[map.entries.length - 1];
    if (map.flow) {
      if (!last) return ok(edit(map.range.start, map.range.end, `{ ${yamlScalar(key, true, true)}: ${yamlScalar(op.value, true, str)} }`));
      return ok(edit(last.valueRange.end, last.valueRange.end, `, ${yamlScalar(key, true, true)}: ${yamlScalar(op.value, true, str)}`));
    }
    if (!last) return fail("Edit this empty map in the text.");
    const at = lineEnd(text, last.valueRange.end - 1);
    const lead = at === text.length && !text.endsWith("\n") ? eol : "";
    return ok(edit(at, at, `${lead}${" ".repeat(column(text, last.keyRange.start))}${yamlScalar(key, false, true)}: ${yamlScalar(op.value, false, str)}${eol}`));
  }

  const e = find(op.key);
  if (!map || !e) return fail(`This step does not ${op.part} ${op.key}.`);

  if (op.op === "setValue") {
    if (e.complex) return fail("This value is a map or a list. Edit it in the text.");
    return ok(edit(e.valueRange.start, e.valueRange.end, styled(text.slice(e.valueRange.start, e.valueRange.end), op.value, map.flow, !!opts.isString?.(e.key))));
  }
  if (op.op === "setKey") {
    const key = op.newKey.trim();
    if (!key) return fail("A name is needed.");
    if (map.entries.some((x) => x !== e && same(x.key, key))) return fail(`This step already ${op.part === "set" ? "sets" : "expects"} ${key}.`);
    return ok(edit(e.keyRange.start, e.keyRange.end, styled(text.slice(e.keyRange.start, e.keyRange.end), key, map.flow, true)));
  }
  // removeEntry
  const i = map.entries.indexOf(e);
  if (map.entries.length === 1) return removePart(op.part);
  if (map.flow) {
    if (i < map.entries.length - 1) return ok(edit(e.pairRange.start, map.entries[i + 1]!.pairRange.start, ""));
    return ok(edit(map.entries[i - 1]!.pairRange.end, e.pairRange.end, ""));
  }
  return ok(edit(lineStart(text, e.keyRange.start), lineEnd(text, e.valueRange.end - 1), ""));
}
