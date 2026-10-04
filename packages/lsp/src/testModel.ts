// SPDX-License-Identifier: BUSL-1.1
// A rung test file (tests/**/*.test.yaml) read for the test table (rung/testModel): the block under test, its stubs,
// the cases and their steps, every key and value with the exact text range a later edit replaces. Read with the yaml
// package's nodes (their source ranges); nothing is ever re-stringified, so comments and layout stay as written.
import { LineCounter, isMap, isPair, isScalar, isSeq, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";

/** UTF-16 offsets into the file's text. */
export interface TRange {
  start: number;
  end: number;
}

/** A scalar as written: its value as YAML reads it and its source range (quotes included). */
export interface TScalar {
  value: string;
  range: TRange;
}

export interface TEntry {
  key: string;
  value: string;
  /** the value as written (750.0, T#2s; a quoted text without its quotes): what the table shows */
  text: string;
  keyRange: TRange;
  /** the value as written, without a comment after it */
  valueRange: TRange;
  /** key .. value end */
  pairRange: TRange;
  /** the value is a map or a list (a stub's member set, a refused whole value): shown, not edited in place */
  complex?: boolean;
}

export interface TMap {
  /** written as { a: 1 } (else one key per line) */
  flow: boolean;
  /** the map's own text: { … } with its braces, or its block lines */
  range: TRange;
  entries: TEntry[];
  /** the key the map hangs on (set:, expect:) */
  keyRange: TRange;
}

export interface TStep {
  index: number;
  /** the step's map as written: `- set: …` lines or `- { set: …, cycle: 1 }` */
  flow: boolean;
  range: TRange;
  /** line of the step's dash, from 0 */
  line: number;
  set?: TMap;
  cycle?: TScalar & { keyRange: TRange };
  advance?: TScalar & { keyRange: TRange };
  expect?: TMap;
  /** keys rung test does not know (it refuses them), kept visible */
  unknown: string[];
}

export interface TCase {
  index: number;
  name?: TScalar;
  range: TRange;
  line: number;
  steps: TStep[];
  /** the steps: list itself, where new steps go */
  stepsRange?: TRange;
  /** written as { name: …, steps: … } (else one key per line) */
  flow: boolean;
  /** its steps written as [ … ] */
  stepsFlow: boolean;
}

export interface TStub {
  name: string;
  nameRange: TRange;
  /** line of its name, from 0 */
  line: number;
  entries: TEntry[];
  /** a hardware identifier: a number, not a map */
  value?: TScalar;
}

export interface TestModel {
  block?: TScalar;
  plc?: TScalar;
  cycle?: TScalar;
  stubs: TStub[];
  cases: TCase[];
  /** the cases: list itself, where new cases go */
  casesRange?: TRange;
  /** the cases written as [ … ] */
  casesFlow?: boolean;
  errors: { message: string; line: number; column: number }[];
}

const r = (n: { range?: [number, number, number] | null } | null | undefined): TRange => ({ start: n?.range?.[0] ?? 0, end: n?.range?.[1] ?? 0 });
const keyOf = (p: Pair): string => (isScalar(p.key) ? String(p.key.value) : String(p.key));
const scalar = (n: unknown): TScalar | undefined => (isScalar(n) ? { value: String(n.value), range: r(n) } : undefined);

function entries(map: YAMLMap, text: string): TEntry[] {
  return map.items.filter(isPair).map((p) => {
    const keyRange = r(p.key as Node);
    const v = p.value as Node | null;
    const valueRange = v ? r(v) : { start: keyRange.end, end: keyRange.end };
    return {
      key: keyOf(p),
      value: isScalar(v) ? String(v.value) : text.slice(valueRange.start, valueRange.end),
      text: isScalar(v) && v.type === "PLAIN" ? text.slice(valueRange.start, valueRange.end) : isScalar(v) ? String(v.value) : text.slice(valueRange.start, valueRange.end),
      keyRange,
      valueRange,
      pairRange: { start: keyRange.start, end: valueRange.end },
      ...(v && !isScalar(v) ? { complex: true } : {}),
    };
  });
}

function tmap(p: Pair, text: string): TMap | undefined {
  const v = p.value;
  if (!isMap(v)) return undefined;
  return { flow: !!v.flow, range: r(v), entries: entries(v, text), keyRange: r(p.key as Node) };
}

export function testModel(text: string): TestModel {
  const lines = new LineCounter();
  const doc = parseDocument(text, { keepSourceTokens: true, lineCounter: lines });
  const errors = doc.errors.map((e) => {
    const pos = lines.linePos(e.pos[0]);
    return { message: e.message, line: pos.line - 1, column: pos.col - 1 };
  });
  const model: TestModel = { stubs: [], cases: [], errors };
  const top = doc.contents;
  if (!isMap(top)) return model;
  const lineOf = (offset: number) => lines.linePos(offset).line - 1;
  for (const p of top.items.filter(isPair)) {
    const k = keyOf(p);
    if (k === "block" || k === "plc" || k === "cycle") {
      const s = scalar(p.value);
      if (s) model[k] = s;
    } else if (k === "stubs" && isMap(p.value)) {
      model.stubs = p.value.items.filter(isPair).map((sp) => ({
        name: keyOf(sp),
        nameRange: r(sp.key as Node),
        line: lineOf(r(sp.key as Node).start),
        entries: isMap(sp.value) ? entries(sp.value, text) : [],
        ...(isScalar(sp.value) ? { value: scalar(sp.value)! } : {}),
      }));
    } else if (k === "cases" && isSeq(p.value)) {
      model.casesRange = r(p.value);
      if (p.value.flow) model.casesFlow = true;
      model.cases = p.value.items.map((c, index): TCase => {
        const node = c as Node;
        const tc: TCase = { index, range: r(node), line: lineOf(r(node).start), steps: [], flow: isMap(c) && !!c.flow, stepsFlow: false };
        if (!isMap(c)) return tc;
        const name = scalar(c.get("name", true));
        if (name) tc.name = name;
        const steps = c.get("steps", true);
        if (isSeq(steps)) {
          tc.stepsRange = r(steps);
          tc.stepsFlow = !!steps.flow;
          tc.steps = steps.items.map((s, si): TStep => {
            const sn = s as Node;
            const step: TStep = { index: si, flow: isMap(s) && !!s.flow, range: r(sn), line: lineOf(r(sn).start), unknown: [] };
            if (!isMap(s)) return step;
            for (const sp of s.items.filter(isPair)) {
              const sk = keyOf(sp);
              if (sk === "set" || sk === "expect") {
                const m = tmap(sp, text);
                if (m) step[sk] = m;
                else step.unknown.push(sk);
              } else if (sk === "cycle" || sk === "advance") {
                const v = scalar(sp.value);
                if (v) step[sk] = { ...v, keyRange: r(sp.key as Node) };
              } else step.unknown.push(sk);
            }
            return step;
          });
        }
        return tc;
      });
    }
  }
  return model;
}
