// SPDX-License-Identifier: BUSL-1.1
// rung test: YAML unit tests for SCL blocks, run on the offline simulator.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkspaceIndex } from "@rung/lsp";
import { Simulator, SimError, toMs, type Instance, type Struct, type Value } from "./runtime.js";

/*
 * tests/motor.test.yaml
 *   block: Fx_Motor            # FB (instance kept across steps) or FC (called per cycle)
 *   cycle: 10ms                # optional, default 10ms
 *   cases:
 *     - name: latches
 *       steps:
 *         - set: { Start: true, SpeedSetpoint: 1500 }
 *         - cycle: 1           # run N cycles
 *         - expect: { Running: true, SpeedOut: 1500 }
 *         - advance: 2s        # run cycles for this much virtual time
 *         - set: { '"Fx_Global".Ready': true }   # DB members and tags via their TIA names
 */

export interface TestFailure {
  step: number;
  name: string;
  expected: unknown;
  actual: unknown;
}

export interface CaseResult {
  name: string;
  passed: boolean;
  failures: TestFailure[];
  error?: string;
  ms: number;
}

export interface FileResult {
  file: string;
  block: string;
  cases: CaseResult[];
  error?: string;
}

interface TestFile {
  block?: string;
  cycle?: string | number;
  cases?: { name?: string; steps?: Record<string, unknown>[] }[];
}

const approx = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)) : a === b;

function normalizeExpected(v: unknown): unknown {
  if (typeof v === "string" && /^(T|TIME|LT|LTIME)#/i.test(v)) return toMs(v);
  return v;
}

/** Splits "Name.member" / '"DB".member' into a root and a member path (case-insensitive). */
function splitName(name: string): { global: boolean; root: string; path: string[] } {
  const m = /^"([^"]+)"(.*)$/.exec(name);
  if (m) return { global: true, root: m[1]!, path: m[2]!.split(".").filter(Boolean) };
  const parts = name.split(".");
  return { global: false, root: parts[0]!, path: parts.slice(1) };
}

export async function runTestFile(index: WorkspaceIndex, file: string, text: string): Promise<FileResult> {
  let spec: TestFile;
  try {
    spec = (parseYaml(text) ?? {}) as TestFile;
  } catch (e) {
    return { file, block: "?", cases: [], error: `invalid YAML: ${(e as Error).message}` };
  }
  const blockName = spec.block;
  if (!blockName) return { file, block: "?", cases: [], error: "missing `block:`" };
  const g = index.global(blockName);
  if (!g?.block) return { file, block: blockName, cases: [], error: `block ${blockName} not found (only SCL sources can be simulated)` };
  const cycleMs = spec.cycle !== undefined ? toMs(spec.cycle) : 10;
  const results: CaseResult[] = [];
  for (const [ci, c] of (spec.cases ?? []).entries()) {
    const t0 = Date.now();
    const sim = new Simulator(index);
    const failures: TestFailure[] = [];
    const isFb = g.block.kind === "FB";
    let inst: Instance | undefined;
    let fcInputs: Record<string, Value> = {};
    let fcOutputs: Struct = {};
    let fcReturn: Value;
    const getMem = (): Struct => (isFb ? inst!.mem : fcOutputs);
    const resolve = (name: string): { get: () => Value; set: (v: Value) => void } => {
      const { global, root, path } = splitName(name);
      const walk = (base: Struct, key: string, rest: string[]) => {
        let obj: Struct = base;
        let k = key.toUpperCase();
        for (const seg of rest) {
          let next = obj[k];
          if (next && typeof next === "object" && "__fb" in (next as object)) next = (next as Instance).mem;
          if (!next || typeof next !== "object") throw new SimError(`${name}: ${seg} is not reachable`);
          obj = next as Struct;
          k = seg.toUpperCase();
        }
        if (!(k in obj)) throw new SimError(`${name} does not exist`);
        return { get: () => obj[k], set: (v: Value) => void (obj[k] = v) };
      };
      if (global) {
        sim.read({ root: { kind: "global", name: root }, path: [], start: 0 }, null); // materialize DB/tag
        return walk(sim.globals, root, path);
      }
      if (!isFb && !path.length && root.toUpperCase() === g.block!.name.toUpperCase()) return { get: () => fcReturn, set: () => {} };
      if (!isFb && !path.length) return { get: () => fcOutputs[root.toUpperCase()] ?? fcInputs[root], set: (v) => void (fcInputs[root] = v) };
      return walk(getMem(), root, path);
    };
    const runCycle = () => {
      sim.time += cycleMs;
      if (isFb) sim.callBlock(inst!);
      else {
        const r = sim.callBlock(g.block!.name, fcInputs);
        fcOutputs = r.outputs;
        fcReturn = r.returnValue;
      }
    };
    try {
      if (isFb) inst = sim.newInstance(g.block.name);
      else if (g.block.kind !== "FC") throw new SimError(`${blockName} is a ${g.block.kind}; tests call FBs or FCs`);
      for (const [si, step] of (c.steps ?? []).entries()) {
        const [op, arg] = Object.entries(step)[0] ?? [];
        switch (op) {
          case "set":
            for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
              const target = resolve(k);
              target.set(normalizeExpected(v) as Value);
            }
            break;
          case "cycle":
            for (let n = 0; n < Number(arg ?? 1); n++) runCycle();
            break;
          case "advance": {
            const cycles = Math.max(1, Math.ceil(toMs(arg) / cycleMs));
            for (let n = 0; n < cycles; n++) runCycle();
            break;
          }
          case "expect":
            for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
              let actual: unknown;
              try {
                actual = resolve(k).get();
              } catch (e) {
                actual = `<${(e as Error).message}>`;
              }
              const expected = normalizeExpected(v);
              if (!approx(actual, expected)) failures.push({ step: si + 1, name: k, expected, actual });
            }
            break;
          default:
            throw new SimError(`step ${si + 1}: unknown step "${op}" (use set, cycle, advance, expect)`);
        }
      }
      results.push({ name: c.name ?? `case ${ci + 1}`, passed: failures.length === 0, failures, ms: Date.now() - t0 });
    } catch (e) {
      results.push({ name: c.name ?? `case ${ci + 1}`, passed: false, failures, error: e instanceof SimError ? `${e.message}${e.block ? ` (in ${e.block})` : ""}` : String(e), ms: Date.now() - t0 });
    }
  }
  return { file, block: blockName, cases: results };
}

/** Runs every tests/**\/*.test.yaml in the workspace (or the given files). */
export async function runTests(root: string, index: WorkspaceIndex, filter?: string): Promise<FileResult[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.test\.ya?ml$/.test(e.name)) files.push(p);
    }
  };
  await walk(join(root, "tests"));
  const out: FileResult[] = [];
  for (const f of files.sort()) {
    const rel = relative(root, f).split(sep).join("/");
    if (filter && !rel.includes(filter)) continue;
    out.push(await runTestFile(index, rel, await readFile(f, "utf8")));
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function toJUnit(results: FileResult[]): string {
  const cases = results.flatMap((f) => (f.error ? [{ f, c: { name: "(file)", passed: false, failures: [], error: f.error, ms: 0 } as CaseResult }] : f.cases.map((c) => ({ f, c }))));
  const failed = cases.filter((x) => !x.c.passed).length;
  const body = cases
    .map(({ f, c }) => {
      const inner = c.passed ? "" : c.error ? `<error message="${esc(c.error)}"/>` : `<failure message="${esc(c.failures.map((x) => `step ${x.step}: ${x.name} expected ${JSON.stringify(x.expected)} got ${JSON.stringify(x.actual)}`).join("; "))}"/>`;
      return `  <testcase classname="${esc(f.file)}" name="${esc(`${f.block}: ${c.name}`)}" time="${(c.ms / 1000).toFixed(3)}">${inner}</testcase>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="rung" tests="${cases.length}" failures="${failed}">\n${body}\n</testsuite>\n`;
}
