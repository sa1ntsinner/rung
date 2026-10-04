// SPDX-License-Identifier: BUSL-1.1
// What a test of a block may name in set: and expect: (the test table's picker), and the keys of a test that name
// nothing in the block. Members of instances and globals ("DB".x, "Tag") are left to rung test, which knows them.
import type { DeclModel, DeclRow } from "./declarations.js";
import type { Part } from "./testEdit.js";
import type { TestModel } from "./testModel.js";

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
export function keyProblems(test: TestModel, symbols: TestSymbol[], temps: string[] = [], block = test.block?.value ?? "The block"): KeyProblem[] {
  const heads = new Set(symbols.map((s) => s.name.split(".")[0]!.toLowerCase()));
  const full = new Set(symbols.map((s) => s.name.toLowerCase()));
  const tempSet = new Set(temps.map((t) => t.toLowerCase()));
  const out: KeyProblem[] = [];
  for (const c of test.cases)
    for (const s of c.steps)
      for (const part of ["set", "expect"] as const)
        for (const e of s[part]?.entries ?? []) {
          if (e.key.startsWith('"')) continue;
          const head = e.key.split(/[.[]/)[0]!.toLowerCase();
          if (heads.has(head) || full.has(e.key.toLowerCase())) continue;
          const name = e.key.split(/[.[]/)[0]!;
          let message: string;
          if (tempSet.has(head)) message = `${block} has no ${name} (a temporary is not kept between cycles)`;
          else {
            const near = [...heads].map((h) => ({ h, d: distance(head, h) })).sort((a, b) => a.d - b.d)[0];
            const original = near && near.d <= Math.max(1, Math.ceil(head.length / 3)) ? symbols.find((x) => x.name.split(".")[0]!.toLowerCase() === near.h)?.name.split(".")[0] : undefined;
            message = `${block} has no ${name}${original ? ` (did you mean ${original}?)` : ""}`;
          }
          out.push({ case: c.index, step: s.index, part, key: e.key, message });
        }
  return out;
}
