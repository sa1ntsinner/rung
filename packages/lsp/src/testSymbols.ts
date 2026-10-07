// SPDX-License-Identifier: BUSL-1.1
// What a test of a block may name in set: and expect: (the test table's picker), and the keys of a test that name
// nothing in the block. Members of instances and globals ("DB".x, "Tag") are left to rung test, which knows them.
import type { DeclModel, DeclRow } from "./declarations.js";
import type { Part } from "./testEdit.js";
import type { TestModel } from "./testModel.js";
import { integer } from "./testSkeleton.js";

export interface TestSymbol {
  /** as a test writes it: Start, Cfg.Speed */
  name: string;
  type: string;
  section: string;
}

export function testSymbols(model: DeclModel): TestSymbol[] {
  const out: TestSymbol[] = [];
  const ret = model.block?.returnType;
  if (model.block?.kind === "FC" && ret && !/^void$/i.test(ret)) out.push({ name: model.block.name, type: ret, section: "Return" });
  const walk = (rows: DeclRow[], prefix: string, section: string) => {
    for (const r of rows) {
      const name = prefix + r.name;
      // a structure is set member by member; an instance's members (Timer.PT) are its type's
      if (r.kind === "struct" && r.children) walk(r.children, `${name}.`, section);
      else out.push({ name, type: r.type, section });
    }
  };
  for (const s of model.sections) if (s.title !== "Temp" && s.title !== "Constant") walk(s.rows, "", s.title);
  return out;
}

const INT_RANGE: Record<string, [number, number]> = {
  SINT: [-128, 127], INT: [-32768, 32767], DINT: [-2147483648, 2147483647], USINT: [0, 255], UINT: [0, 65535], UDINT: [0, 4294967295],
  BYTE: [0, 255], WORD: [0, 65535], DWORD: [0, 4294967295],
};

/** Why a value written in a test does not fit a variable of this type (as rung test checks it), or undefined. */
export function valueProblem(type: string, value: string): string | undefined {
  const t = type.trim().toUpperCase();
  const v = value.trim().replace(/^'(.*)'$|^"(.*)"$/, "$1$2");
  if (t === "BOOL") return /^(true|false)$/i.test(v) ? undefined : `${type} takes true or false.`;
  const range = INT_RANGE[t];
  if (range) {
    // 7, 16#00F3, 2#0000_0101, INT#16#7F: as rung test reads them
    const whole = integer(v);
    if (whole === undefined) return `${type} takes a whole number.`;
    const n = Number(whole);
    return n < range[0] || n > range[1] ? `${v} does not fit an ${type} (${range[0]} to ${range[1]}).` : undefined;
  }
  if (/^(LINT|ULINT|LWORD)$/.test(t)) return integer(v) !== undefined ? undefined : `${type} takes a whole number.`;
  if (/^L?REAL$/.test(t)) return v !== "" && Number.isFinite(Number(v)) ? undefined : `${type} takes a number.`;
  if (/^L?TIME$/.test(t)) return /^(L?T#)?-?(\d+(\.\d+)?(ms|s|m|h|d)_?)+$/i.test(v) ? undefined : `${type} takes a time with its unit (500ms, 2s, T#1m).`;
  const len = /^W?STRING\s*\[\s*(\d+)\s*\]$/.exec(t);
  if (len && v.length > Number(len[1])) return `${type} holds at most ${len[1]} characters.`;
  if (/^W?CHAR$/.test(t) && v.length !== 1) return `${type} holds one character.`;
  return undefined;
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length]!;
}

export interface KeyProblem {
  case: number;
  step: number;
  part: Part;
  key: string;
  message: string;
}

/** The set:/expect: keys whose first name the block does not have (a global "…" or an instance's member is not checked). */
/** Why a key of set:/expect: names nothing in the block (a global "…" or an instance's member is not checked), or undefined. */
export function keyProblem(key: string, symbols: TestSymbol[], temps: string[] = [], block = "The block"): string | undefined {
  if (key.startsWith('"')) return undefined;
  const heads = new Set(symbols.map((s) => s.name.split(".")[0]!.toLowerCase()));
  const head = key.split(/[.[]/)[0]!.toLowerCase();
  if (heads.has(head) || symbols.some((s) => s.name.toLowerCase() === key.toLowerCase())) return undefined;
  const name = key.split(/[.[]/)[0]!;
  if (temps.some((t) => t.toLowerCase() === head)) return `${block} has no ${name} (a temporary is not kept between cycles)`;
  const near = [...heads].map((h) => ({ h, d: distance(head, h) })).sort((a, b) => a.d - b.d)[0];
  const original = near && near.d <= Math.max(1, Math.ceil(head.length / 3)) ? symbols.find((x) => x.name.split(".")[0]!.toLowerCase() === near.h)?.name.split(".")[0] : undefined;
  return `${block} has no ${name}${original ? ` (did you mean ${original}?)` : ""}`;
}

/** The set:/expect: keys whose first name the block does not have. */
export function keyProblems(test: TestModel, symbols: TestSymbol[], temps: string[] = [], block = test.block?.value ?? "The block"): KeyProblem[] {
  const out: KeyProblem[] = [];
  for (const c of test.cases)
    for (const s of c.steps)
      for (const part of ["set", "expect"] as const)
        for (const e of s[part]?.entries ?? []) {
          const message = keyProblem(e.key, symbols, temps, block);
          if (message) out.push({ case: c.index, step: s.index, part, key: e.key, message });
        }
  return out;
}
