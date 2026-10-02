// SPDX-License-Identifier: BUSL-1.1
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile, Simulator, type Instance } from "../src/index.js";

export const corpusDir = fileURLToPath(new URL("../../../tests/conformance/cases/", import.meta.url));

export interface ConformanceSource {
  file: string;
  text: string;
  block: string;
  cycles: number;
  results: { name: string; type: string }[];
}

export type RecordedValue = boolean | number | string;
export interface Recording {
  block: string;
  cycle: string;
  cases: [{ name: string; steps: [{ cycle: number }, { expect: Record<string, RecordedValue> }] }];
}

export async function corpus() {
  const index = new WorkspaceIndex();
  await index.load(corpusDir);
  const sources: ConformanceSource[] = [];
  for (const file of (await readdir(corpusDir)).filter((f) => f.endsWith(".st")).sort()) {
    const text = await readFile(join(corpusDir, file), "utf8");
    const block = /^PROGRAM\s+(PRG_\w+)\s*$/m.exec(text)?.[1];
    const cycles = Number(/^\s*cycles\s*:\s*UINT\s*:=\s*(\d+);/m.exec(text)?.[1]);
    const results = [...text.matchAll(/^\s*(r_\w+)\s*:\s*(\w+)(?:\(\d+\))?\s*;/gm)].map((m) => ({ name: m[1]!, type: m[2]!.toUpperCase() }));
    if (!block || !Number.isInteger(cycles) || cycles < 1 || !results.length) throw new Error(file + ": expected a PROGRAM, a positive cycles constant and r_ result variables");
    if (!index.global(block)?.block) throw new Error(file + ": PROGRAM was not indexed");
    sources.push({ file, text, block, cycles, results });
  }
  if (!sources.length) throw new Error("the conformance corpus is empty");
  return { index, sources };
}

export function recording(source: ConformanceSource, values: Record<string, RecordedValue>): Recording {
  const spec: Recording = { block: source.block, cycle: "10ms", cases: [{ name: "CODESYS", steps: [{ cycle: source.cycles }, { expect: values }] }] };
  validateRecording(source, spec);
  return spec;
}

export function validateRecording(source: ConformanceSource, value: unknown): asserts value is Recording {
  const spec = value as Recording | undefined;
  const steps = spec?.cases?.[0]?.steps;
  const expected = steps?.[1]?.expect;
  if (!spec || Object.keys(spec).sort().join() !== "block,cases,cycle" || spec.block !== source.block || spec.cycle !== "10ms" || spec.cases?.length !== 1 ||
      Object.keys(spec.cases[0]).sort().join() !== "name,steps" || typeof spec.cases[0].name !== "string" || steps?.length !== 2 ||
      Object.keys(steps[0]).join() !== "cycle" || steps[0].cycle !== source.cycles || Object.keys(steps[1]).join() !== "expect" || !expected || typeof expected !== "object")
    throw new Error(source.file + ": recording must contain one CODESYS case, its fixed cycle count and an expectation step (no stubs or writes)");
  const keys = ["done", "cycle", ...source.results.map((r) => r.name)].sort();
  if (Object.keys(expected).sort().join() !== keys.join() || expected.done !== true || expected.cycle !== source.cycles)
    throw new Error(source.file + ": recording must expect done, cycle and every result variable");
  for (const result of source.results) {
    if (normalizeValue(expected[result.name], result.type) !== expected[result.name]) throw new Error(source.file + ": invalid recorded value for " + result.name);
  }
}

export function serializeRecording(spec: Recording): string {
  // Decimal rendering of a double can differ from its exact integer (notably -2^63).
  const values = Object.fromEntries(Object.entries(spec.cases[0].steps[1].expect).map(([k, v]) => [k, typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v) ? BigInt(v) : v]));
  return "# SPDX-License-Identifier: BUSL-1.1\n" + stringify({ ...spec, cases: [{ ...spec.cases[0], steps: [spec.cases[0].steps[0], { expect: values }] }] });
}

export async function readRecording(source: ConformanceSource): Promise<{ text: string; spec: Recording } | undefined> {
  let text: string;
  try {
    text = await readFile(join(corpusDir, source.file.replace(/\.st$/, ".test.yaml")), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const spec: unknown = parse(text);
  validateRecording(source, spec);
  return { text, spec };
}

const integerType = /^(SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|BYTE|WORD|DWORD|LWORD)$/;

export function normalizeValue(value: unknown, type: string): RecordedValue {
  if (type === "STRING") {
    if (typeof value === "string") return value;
  } else if (type === "BOOL") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(?:BOOL#)?(?:TRUE|FALSE)$/i.test(value)) return /TRUE$/i.test(value);
  } else if (type === "TIME") {
    if (typeof value === "string" && /^(?:T|TIME)#/i.test(value)) return value;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return "T#" + value + "MS";
  } else if (integerType.test(type)) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    // Ask CODESYS for 64-bit integers as decimal strings, then reject loss of low bits at the JSON boundary.
    const text = String(value).replace(/^[A-Z]+#/i, "").replace(/_/g, "");
    const radix = /^(2|8|16)#([0-9a-f]+)$/i.exec(text);
    const big = radix ? BigInt((radix[1] === "2" ? "0b" : radix[1] === "8" ? "0o" : "0x") + radix[2]) : /^-?\d+$/.test(text) ? BigInt(text) : undefined;
    if (big !== undefined && Number.isFinite(Number(big)) && BigInt(Number(big)) === big) return Number(big);
  } else if (type === "REAL" || type === "LREAL") {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/^(?:L?REAL)#/i, "")) : NaN;
    if (Number.isFinite(n)) return n;
  }
  throw new Error("cannot record " + type + " value exactly: " + JSON.stringify(value));
}

export function refusal(error: string, source: ConformanceSource): boolean {
  const line = /Syntax error in .* \(line (\d+)\): Unexpected '\.'/.exec(error)?.[1];
  if (line && /\b\w+\.\d+\b/.test(source.text.split("\n")[Number(line) - 1] ?? "")) return true;
  const parameter = /^(RESET|LOAD|SET1|SET|RESET1) is not an input of the block \(in .*?, line (\d+)\)/.exec(error);
  if (parameter) {
    const call = /^\s*(\w+)\s*\(/.exec(source.text.split("\n")[Number(parameter[2]) - 1] ?? "")?.[1];
    const type = call && new RegExp("^\\s*" + call + "\\s*:\\s*(CTU|CTD|CTUD|SR|RS)\\s*;", "m").exec(source.text)?.[1];
    const inputs: Record<string, string[]> = { CTU: ["RESET"], CTD: ["LOAD"], CTUD: ["RESET", "LOAD"], SR: ["SET1", "RESET"], RS: ["SET", "RESET1"] };
    if (type && inputs[type]!.includes(parameter[1]!)) return true;
  }
  return /cannot be held exactly: the simulator keeps integers exact|function \w+ is not supported by the simulator|\w+ is not simulated:/.test(error) ||
    /(?:DELETE|INSERT|REPLACE): (?:L .* characters from P .* are not within|P .* is not a character of IN1)/.test(error);
}

export async function compareSimulator(index: WorkspaceIndex, source: ConformanceSource, text: string, spec: Recording) {
  const result = await runTestFile(index, source.file.replace(/\.st$/, ".test.yaml"), text);
  if (result.error) throw new Error(source.file + ": " + result.error);
  const test = result.cases[0];
  if (!test || result.cases.length !== 1) throw new Error(source.file + ": runner did not return its one case");
  const differences = test.failures.map((f) => f.name + ": expected " + JSON.stringify(f.expected) + ", got " + JSON.stringify(f.actual));
  if (test.error) {
    if (!refusal(test.error, source)) throw new Error(source.file + ": unexpected runner error: " + test.error);
    return { status: differences.length ? "differ" as const : "refused" as const, differences, reason: test.error };
  }
  // The normal runner tolerates all numbers. Compare integer results exactly as well, so a one-bit error cannot pass.
  const sim = new Simulator(index);
  const instance = sim.read({ root: { kind: "global", name: source.block }, path: [], start: 0 }, null) as Instance;
  for (let i = 0; i < source.cycles; i++) {
    sim.time += 10;
    sim.callBlock(instance);
  }
  for (const r of [...source.results, { name: "cycle", type: "UINT" }]) {
    if (!integerType.test(r.type)) continue;
    const actual = instance.mem[r.name.toUpperCase()];
    const expected = spec.cases[0].steps[1].expect[r.name];
    if (actual !== expected && !test.failures.some((f) => f.name === r.name)) differences.push(r.name + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
  return { status: differences.length ? "differ" as const : "match" as const, differences };
}
