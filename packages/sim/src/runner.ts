// SPDX-License-Identifier: BUSL-1.1
// rung test: YAML unit tests for SCL blocks, run on the offline simulator.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { deviceOfUri, scopedTo, unscoped, type GlobalSymbol, type WorkspaceIndex } from "@rung/lsp";
import { Simulator, SimError, toMs, type ArrayValue, type Instance, type Struct, type Value } from "./runtime.js";

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
 *         - set: { 'pts[2].x': 1.5 }             # array elements
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
  /** The PLC of the block when the workspace has several with one of that name (else tests/<PLC>/ says it). */
  plc?: string;
  cycle?: string | number;
  cases?: { name?: string; steps?: Record<string, unknown>[] }[];
}

/** Keys of a step run in this order when one step has several (`{ set: ..., cycle: 1, expect: ... }`). */
const STEP_ORDER = ["set", "cycle", "advance", "expect"] as const;

const approx = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)) : a === b;

function normalizeExpected(v: unknown): unknown {
  if (typeof v === "string" && /^(T|TIME|LT|LTIME)#/i.test(v)) return toMs(v);
  return v;
}

/** A path segment: member name, or array indices (`[2]`, `[1,2]`, or a bare number after a dot). */
type Seg = string | number[];

/** Splits `Name.member`, `"DB".member`, `arr[2].x`, `grid[1,2]` into a root and a path (case-insensitive). */
function splitName(name: string): { global: boolean; root: string; path: Seg[] } {
  const m = /^"([^"]+)"(.*)$/.exec(name);
  const global = !!m;
  let rest = m ? m[2]! : name;
  let root = "";
  if (!m) {
    const r = /^[^.[]+/.exec(rest);
    root = r ? r[0] : "";
    rest = rest.slice(root.length);
  } else root = m[1]!;
  const path: Seg[] = [];
  const re = /\.([^.[]+)|\[([^\]]*)\]/g;
  for (const x of rest.matchAll(re)) {
    if (x[1] !== undefined) path.push(/^\d+$/.test(x[1]) ? [Number(x[1])] : x[1]);
    else path.push(x[2]!.split(",").map((s) => Number(s.trim())));
  }
  return { global, root, path };
}

const isArrayValue = (v: Value): v is ArrayValue => typeof v === "object" && v !== null && (v as ArrayValue).__array === true;

/** Rejects `set` values whose kind differs from the variable's current value (BOOL vs number vs string). */
function checkKind(name: string, current: Value, value: Value) {
  if (current === undefined || typeof current === "object") return;
  const kind = (v: Value) => (typeof v === "boolean" ? "a BOOL (true/false)" : typeof v === "number" ? "a number" : "a string");
  if (typeof current !== typeof value) throw new SimError(`${name} expects ${kind(current)}, got ${JSON.stringify(value)}`);
}

const INT_RANGE: Record<string, [number, number]> = {
  SINT: [-128, 127], INT: [-32768, 32767], DINT: [-2147483648, 2147483647], LINT: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  USINT: [0, 255], UINT: [0, 65535], UDINT: [0, 4294967295], ULINT: [0, Number.MAX_SAFE_INTEGER],
  BYTE: [0, 255], WORD: [0, 65535], DWORD: [0, 4294967295], LWORD: [0, Number.MAX_SAFE_INTEGER],
};

/** Rejects a `set` value the variable's declared type cannot hold (40000 in an Int, 1.5 in a DInt, a number in a Bool). */
function checkType(name: string, type: string, value: Value) {
  const t = type.replace(/^"|"$/g, "").toUpperCase();
  const range = INT_RANGE[t];
  if (range) {
    if (typeof value !== "number" || !Number.isInteger(value)) throw new SimError(`${name} is ${type}: expects a whole number, got ${JSON.stringify(value)}`);
    if (value < range[0] || value > range[1]) throw new SimError(`${name} is ${type}: ${value} is outside ${range[0]}..${range[1]}`);
  } else if (t === "BOOL" && typeof value !== "boolean") throw new SimError(`${name} expects a BOOL (true/false), got ${JSON.stringify(value)}`);
  else if ((t === "REAL" || t === "LREAL") && typeof value !== "number") throw new SimError(`${name} is ${type}: expects a number, got ${JSON.stringify(value)}`);
}

/**
 * The block a test file means. With several PLCs a name can be in more than one: `plc:` in the test or the folder
 * tests/<PLC>/ says which; without either an ambiguous name is refused rather than guessed.
 */
function blockOf(index: WorkspaceIndex, name: string, plc: string | undefined, file: string): { symbol: GlobalSymbol } | { error: string } {
  const all = unscoped(index).allGlobals().filter((s) => s.block && s.name.toUpperCase() === name.toUpperCase());
  const devices = [...new Set(all.map((s) => deviceOfUri(s.uri)).filter((d): d is string => !!d))].sort();
  const folder = /^tests\/([^/]+)\//.exec(file)?.[1];
  const want = plc ?? (folder && devices.includes(folder) ? folder : undefined);
  if (want) {
    const hit = all.find((s) => deviceOfUri(s.uri) === want);
    return hit ? { symbol: hit } : { error: `block ${name} is not in PLC ${want}${devices.length ? ` (it is in ${devices.join(", ")})` : ""}` };
  }
  if (devices.length > 1) return { error: `block ${name} is in several PLCs (${devices.join(", ")}): add \`plc: ${devices[0]}\` to the test, or put it in tests/${devices[0]}/` };
  const g = index.global(name);
  return g?.block ? { symbol: g } : { error: `block ${name} not found (only SCL sources can be simulated)` };
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
  const found = blockOf(index, blockName, spec.plc, file);
  if ("error" in found) return { file, block: blockName, cases: [], error: found.error };
  const g = found.symbol;
  if (!g.block) return { file, block: blockName, cases: [], error: `block ${blockName} not found (only SCL sources can be simulated)` };
  const cycleMs = spec.cycle !== undefined ? toMs(spec.cycle) : 10;
  const results: CaseResult[] = [];
  for (const [ci, c] of (spec.cases ?? []).entries()) {
    const t0 = Date.now();
    // what the block calls and uses is its own PLC's (another PLC may have objects of the same names)
    const sim = new Simulator(scopedTo(index, g.uri));
    const failures: TestFailure[] = [];
    const isFb = g.block.kind === "FB" || g.block.kind === "PRG";
    const inOuts = g.block.vars.filter((v) => v.section === "InOut");
    let inst: Instance | undefined;
    let fcInputs: Record<string, Value> = {};
    let fcOutputs: Struct = {};
    let fcReturn: Value;
    const getMem = (): Struct => (isFb ? inst!.mem : fcOutputs);
    const resolve = (name: string): { get: () => Value; set: (v: Value) => void } => {
      let { global, root, path } = splitName(name);
      const gvar = !global && !(isFb && root.toUpperCase() in getMem()) ? index.global(root)?.gvar : undefined;
      if (gvar) ({ root, path } = { root: gvar.list, path: [root, ...path] }); // bare GVL variable
      const walk = (base: Struct, key: string, rest: Seg[]) => {
        let holder: Struct | Value[] = base;
        let k: string | number = key.toUpperCase();
        const at = (): Value => (holder as Record<string | number, Value>)[k];
        for (const seg of rest) {
          let cur = at();
          if (cur && typeof cur === "object" && "__fb" in (cur as object)) cur = (cur as Instance).mem;
          if (typeof seg === "string") {
            if (!cur || typeof cur !== "object" || isArrayValue(cur)) throw new SimError(`${name}: ${seg} is not reachable`);
            holder = cur as Struct;
            k = seg.toUpperCase();
            continue;
          }
          for (const [d, idx] of seg.entries()) {
            const arr = d === 0 ? cur : at();
            if (!isArrayValue(arr)) throw new SimError(`${name}: indexing a value that is not an array`);
            if (!Number.isInteger(idx) || idx < arr.lo || idx >= arr.lo + arr.items.length) throw new SimError(`${name}: index ${idx} out of range ${arr.lo}..${arr.lo + arr.items.length - 1}`);
            holder = arr.items;
            k = idx - arr.lo;
          }
        }
        if (!Array.isArray(holder) && !((k as string) in holder)) throw new SimError(`${name} does not exist`);
        const h = holder as Record<string | number, Value>;
        const kk = k;
        return { get: () => h[kk], set: (v: Value) => void (h[kk] = v) };
      };
      if (global || ((!isFb || !(root.toUpperCase() in getMem())) && sim.isIecGlobal(root))) {
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
        // IN_OUT parameters behave like the caller's variable: the value written by the FC is passed next cycle
        for (const v of inOuts) {
          const key = Object.keys(fcInputs).find((x) => x.toUpperCase() === v.name.toUpperCase()) ?? v.name;
          fcInputs[key] = fcOutputs[v.name.toUpperCase()];
        }
      }
    };
    const count = (op: string, v: unknown): number => {
      const n = Number(v ?? 1);
      if (!Number.isInteger(n) || n < 0) throw new SimError(`${op}: expected a whole number of cycles, got ${JSON.stringify(v)}`);
      return n;
    };
    try {
      if (g.block.kind === "PRG") inst = sim.read({ root: { kind: "global", name: g.block.name }, path: [], start: 0 }, null) as Instance; // one shared PROGRAM instance
      else if (isFb) inst = sim.newInstance(g.block.name);
      else if (g.block.kind !== "FC") throw new SimError(`${blockName} is a ${g.block.kind}; tests call FBs, FCs or PROGRAMs`);
      for (const [si, step] of (c.steps ?? []).entries()) {
        const unknown = Object.keys(step ?? {}).find((k) => !(STEP_ORDER as readonly string[]).includes(k));
        if (unknown !== undefined || !step || !Object.keys(step).length) throw new SimError(`step ${si + 1}: unknown step "${unknown ?? ""}" (use set, cycle, advance, expect)`);
        for (const op of STEP_ORDER) {
          if (!(op in step)) continue;
          const arg = step[op];
          switch (op) {
            case "set":
              for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
                const target = resolve(k);
                const value = normalizeExpected(v) as Value;
                // a variable of the block itself is checked against its declared type, others against their value
                const decl = /^[A-Za-z_]\w*$/.test(k) ? g.block.vars.find((x) => x.name.toUpperCase() === k.toUpperCase() && x.section !== "Temp" && !x.isArray && !x.members?.length) : undefined;
                if (decl) checkType(k, decl.type, value);
                else checkKind(k, target.get(), value);
                target.set(value);
              }
              break;
            case "cycle":
              for (let n = 0, max = count("cycle", arg); n < max; n++) runCycle();
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
          }
        }
      }
      results.push({ name: c.name ?? `case ${ci + 1}`, passed: failures.length === 0, failures, ms: Date.now() - t0 });
    } catch (e) {
      const where = e instanceof SimError && e.block ? ` (in ${e.block}${e.offset !== undefined && !/\(line \d+\)/.test(e.message) ? `, line ${sim.lineOf(e.block, e.offset) ?? "?"}` : ""})` : "";
      results.push({ name: c.name ?? `case ${ci + 1}`, passed: false, failures, error: e instanceof SimError ? `${e.message}${where}` : String(e), ms: Date.now() - t0 });
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
    const text = await readFile(f, "utf8");
    // --filter matches the file path or the block under test (rung test --filter Fx_Motor)
    if (filter && !rel.includes(filter) && !new RegExp(`^block:\\s*["']?${filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`, "m").test(text)) continue;
    out.push(await runTestFile(index, rel, text));
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
