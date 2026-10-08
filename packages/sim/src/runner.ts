// SPDX-License-Identifier: BUSL-1.1
// rung test: YAML unit tests for SCL blocks, run on the offline simulator.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { LineCounter, isMap, isSeq, parseDocument } from "yaml";
import { STANDARD, STANDARD_BY_NAME, SYSTEM_TYPES, deviceOfUri, nearest as nearestSpelling, scopedTo, unscoped, type GlobalSymbol, type Member, type WorkspaceIndex } from "@rung/lsp";
import { SYSTEM_FUNCTIONS, Simulator, SimError, realText, splitArrayType, toMs, type ArrayValue, type Instance, type Struct, type Value } from "./runtime.js";
import { ELEMENTARY_TYPE } from "./system.js";

/*
 * tests/motor.test.yaml
 *   block: Fx_Motor            # FB (instance kept across steps) or FC (called per cycle)
 *   cycle: 10ms                # optional, default 10ms
 *   stubs:                     # optional: what the test stands in for, and the values its outputs start with
 *     RDREC: { VALID: true, STATUS: 0 }
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
  /** Line of the step in the test file (from 1). */
  line?: number;
}

export interface CaseResult {
  name: string;
  /** The case's place in its file's cases, from 0 (a selected case keeps its place). */
  index?: number;
  passed: boolean;
  failures: TestFailure[];
  error?: string;
  ms: number;
  /** Line of the case in the test file (from 1). */
  line?: number;
  /** For an error: the step it stopped in (from 1) and that step's line in the test file. */
  errorStep?: number;
  errorLine?: number;
  /** With `observe`: the block's outputs and statics after each step that ran cycles (from 1), as a test writes them. */
  observed?: { step: number; values: Record<string, boolean | number | string>; /** which of them are statics (memory, not results) */ statics?: string[] }[];
}

export interface FileResult {
  file: string;
  block: string;
  /** The PLC (plc/<device>/) of the block the file tested. */
  plc?: string;
  cases: CaseResult[];
  error?: string;
  /** Location of a file-level YAML error (from 1). */
  errorLine?: number;
  errorColumn?: number;
  /** The stubs the cases called (a technology object: used), with how often; `runs`: the simulator could have run it. */
  stubbed?: { name: string; calls: number; runs?: true }[];
  /** Stubs named but never called (probably a typo). */
  warnings?: string[];
}

interface TestFile {
  block?: string;
  /** The PLC of the block when the workspace has several with one of that name (else tests/<PLC>/ says it). */
  plc?: string;
  cycle?: string | number;
  /** What the test stands in for: a block, instruction or technology object, and the values its outputs start with. */
  stubs?: Record<string, Record<string, unknown> | null>;
  cases?: { name?: string; steps?: Record<string, unknown>[] }[];
}

/** Keys of a step run in this order when one step has several (`{ set: ..., cycle: 1, expect: ... }`). */
const STEP_ORDER = ["set", "cycle", "advance", "expect"] as const;
/** The cycles one step may run: a typo like advance: 1000d (or .inf) is refused instead of running for hours. */
const MAX_STEP_CYCLES = 10_000_000;

const approx = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)) : a === b;

/** Short PLC names often differ by two swapped letters or an expanded abbreviation (LENGTH/LEN). */
function nearest(name: string, names: Iterable<string>): string | undefined {
  const candidates = [...names];
  const upper = name.toUpperCase();
  for (let i = 0; i < upper.length - 1; i++) {
    const swapped = upper.slice(0, i) + upper[i + 1] + upper[i] + upper.slice(i + 2);
    const hit = candidates.find((n) => n.toUpperCase() === swapped);
    if (hit) return hit;
  }
  return nearestSpelling(name, candidates) ?? candidates.find((n) => n.length >= 3 && upper.startsWith(n.toUpperCase()));
}

function normalizeExpected(v: unknown, type?: string): unknown {
  if (typeof v === "string" && ((!type || isTime(type)) && /^(T|TIME|LT|LTIME)#/i.test(v) || isTime(type) && /^\d+(?:\.\d+)?(?:ms|s|m|h)$/i.test(v))) return toMs(v);
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
export function checkKind(name: string, current: Value, value: Value) {
  if (current === undefined || typeof current === "object") return;
  const kind = (v: Value) => (typeof v === "boolean" ? "a BOOL (true/false)" : typeof v === "number" ? "a number" : "a string");
  if (typeof current !== typeof value) throw new SimError(`${name} expects ${kind(current)}, got ${shown(value)}`);
}

const isTime = (type?: string) => /^(TIME|LTIME|S5TIME)$/i.test(type ?? "");
const isReal = (type?: string) => /^REAL$/i.test(type ?? "");
const shown = (v: unknown): string => v === undefined || v === null ? "no value" : JSON.stringify(v);

const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What is wrong with the shape of a test file, in the words of the file: steps outside a case, a case whose
 * steps slipped out of it by indentation (it would pass without testing anything), a cycle that is no time.
 */
function shapeProblem(spec: unknown): string | undefined {
  if (!plain(spec) || spec.block === undefined) return undefined; // "missing block:" says it
  const top = Object.keys(spec).find((k) => !["block", "plc", "cycle", "stubs", "cases"].includes(k));
  if (top) return `unknown key ${top}: a test file has block, plc, cycle, stubs and cases${top === "steps" ? " (the steps go in a case under cases:)" : ""}`;
  if (spec.stubs !== undefined) {
    if (!plain(spec.stubs)) return "stubs is a map: a block, instruction or technology object, then the values its outputs start with (RDREC: { VALID: true })";
    for (const [name, values] of Object.entries(spec.stubs)) {
      if (name.includes("~")) {
        // a hardware identifier ("Rack~Module"): a system constant from the device configuration, which rung does not have
        if (!Number.isInteger(values)) return `stubs.${name}: a hardware identifier stands for a number (its HW_IO value), such as 257`;
        continue;
      }
      if (values !== null && !plain(values)) return `stubs.${name} is a map of output values, such as { STATUS: 0 } (or {} for none)`;
      for (const [k, v] of Object.entries(values ?? {}))
        if (!["boolean", "number", "string"].includes(typeof v)) return `stubs.${name}.${k}: a value is true/false, a number or a string, not ${shown(v)}`;
    }
  }
  if (spec.cycle !== undefined) {
    let ms: number;
    try {
      ms = toMs(spec.cycle);
    } catch {
      return `cycle is the time of one cycle, such as 10ms; not ${String(spec.cycle)}`;
    }
    if (!Number.isFinite(ms)) return `cycle is the time of one cycle, such as 10ms; not ${String(spec.cycle)}`;
    if (!(ms > 0)) return `cycle is the time of one cycle, such as 10ms; ${String(spec.cycle)} runs no time`;
  }
  if (spec.cases === undefined || spec.cases === null) return "no cases: list them under cases:, each with a name and its steps";
  if (!Array.isArray(spec.cases)) return "cases is a list, one case per entry starting with -";
  const names = new Map<string, number>();
  for (const [i, c] of spec.cases.entries()) {
    const label = `case ${i + 1}${plain(c) && typeof c.name === "string" ? ` (${c.name})` : ""}`;
    if (!plain(c)) return `${label} is not a case: a case has name and steps`;
    const key = Object.keys(c).find((k) => k !== "name" && k !== "steps");
    if (key) return `${label}: unknown key ${key} (a case has name and steps)`;
    if (typeof c.name !== "string" || !c.name.trim()) return `${label}: missing name: give the case a name`;
    const earlier = names.get(c.name);
    if (earlier !== undefined) return `${label}: duplicate name ${shown(c.name)} (case ${earlier + 1} and case ${i + 1})`;
    names.set(c.name, i);
    if (Array.isArray(c.steps) && !c.steps.length) return `${label} has no steps`;
    if (c.steps === undefined || c.steps === null) return `${label} has no steps: indent them under the case, below its name`;
    if (!Array.isArray(c.steps)) return `${label}: steps is a list, one step per line starting with -`;
  }
  return undefined;
}

const INT_RANGE: Record<string, [number, number]> = {
  SINT: [-128, 127], INT: [-32768, 32767], DINT: [-2147483648, 2147483647], LINT: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  USINT: [0, 255], UINT: [0, 65535], UDINT: [0, 4294967295], ULINT: [0, Number.MAX_SAFE_INTEGER],
  BYTE: [0, 255], WORD: [0, 65535], DWORD: [0, 4294967295], LWORD: [0, Number.MAX_SAFE_INTEGER],
};

/** Rejects a `set` value the variable's declared type cannot hold (40000 in an Int, 1.5 in a DInt, a number in a Bool). */
export function checkType(name: string, type: string, value: Value) {
  const t = type.replace(/^"|"$/g, "").toUpperCase();
  if (/^(ARRAY|STRUCT)\b/.test(t)) throw new SimError(`${name} is ${type}: set its ${/^ARRAY\b/.test(t) ? "elements" : "members"} in the test steps`);
  const range = INT_RANGE[t];
  if (range) {
    if (typeof value !== "number" || !Number.isInteger(value)) throw new SimError(`${name} is ${type}: expects a whole number, got ${shown(value)}`);
    if (value < range[0] || value > range[1]) throw new SimError(`${name} is ${type}: ${value} is outside ${range[0]}..${range[1]}`);
  } else if (isTime(t) && typeof value !== "number") throw new SimError(`${name} is ${type}: expects a duration, such as T#500ms, got ${shown(value)}`);
  else if (t === "BOOL" && typeof value !== "boolean") throw new SimError(`${name} expects a BOOL (true/false), got ${shown(value)}`);
  else if (/^(W?STRING|W?CHAR)(?:\[\s*\d+\s*\])?$/.test(t)) {
    if (typeof value !== "string") throw new SimError(`${name} is ${type}: expects text, got ${shown(value)}`);
    const max = /CHAR$/.test(t) ? 1 : Number(/\[\s*(\d+)\s*\]/.exec(t)?.[1] ?? 254);
    if (value.length > max) throw new SimError(`${name} is ${type}: ${value.length} characters is longer than ${max}`);
  }
  else if ((t === "REAL" || t === "LREAL") && typeof value !== "number") throw new SimError(`${name} is ${type}: expects a number, got ${shown(value)}`);
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
  // a typo (block: Fx_Motr): the block a test can call whose name is closest
  const near = (device?: string) =>
    nearest(name, unscoped(index).allGlobals().filter((s) => s.block && /^(FB|FC|PRG)$/.test(s.block.kind) && (!device || deviceOfUri(s.uri) === device)).map((s) => s.name));
  if (want) {
    const hit = all.find((s) => deviceOfUri(s.uri) === want);
    const typo = devices.length ? undefined : near(want);
    return hit ? { symbol: hit } : { error: `block ${name} is not in PLC ${want}${devices.length ? ` (it is in ${devices.join(", ")})` : typo ? ` (did you mean ${typo}?)` : ""}` };
  }
  if (devices.length > 1) return { error: `block ${name} is in several PLCs (${devices.join(", ")}): add \`plc: ${devices[0]}\` to the test, or put it in tests/${devices[0]}/` };
  const g = index.global(name);
  if (g?.block) return { symbol: g };
  if (g) return { error: `${name} has no code the simulator can run (a technology object or a know-how protected block)` };
  const typo = near();
  return { error: `block ${name} not found${typo ? ` (did you mean ${typo}?)` : ""}` };
}

/**
 * For a `set`/`expect` name the block does not have (Strat, "Fx_Dta".Level, Motor.Sped): the closest name there is,
 * written as the test writes it; undefined when nothing is close or the name is there.
 */
function closestName(index: WorkspaceIndex, g: GlobalSymbol, typed: string, op: "set" | "expect"): string | undefined {
  const { global, root, path } = splitName(typed);
  const b = g.block!;
  const seen = scopedTo(index, g.uri);
  const show = (r: string, p: Seg[]) => (global ? `"${r}"` : r) + p.map((s) => (typeof s === "string" ? `.${s}` : `[${s.join(",")}]`)).join("");
  let members: Member[];
  if (global) {
    const target = seen.global(root);
    if (!target) {
      const near = nearest(root, seen.allGlobals().filter((s) => s.kind === "DB" || s.kind === "TAG").map((s) => s.name));
      return near ? show(near, path) : undefined;
    }
    members = seen.membersOfType(target.name);
  } else {
    // what a test reaches in the block: an FB's interface and statics; an FC's inputs (set), outputs and return value (expect)
    const fc = b.kind === "FC";
    const sections = fc ? (op === "set" ? ["Input", "InOut"] : ["Input", "InOut", "Output"]) : ["Input", "Output", "InOut", "Static"];
    const own = b.vars.filter((v) => sections.includes(v.section));
    const decl = own.find((v) => v.name.toUpperCase() === root.toUpperCase());
    if (!decl) {
      if (fc && op === "expect" && root.toUpperCase() === b.name.toUpperCase()) return undefined;
      const near = nearest(root, [...own.map((v) => v.name), ...(fc && op === "expect" ? [b.name] : [])]);
      return near ? show(near, path) : undefined;
    }
    members = seen.membersOf({ ...decl, uri: g.uri });
  }
  for (const [i, seg] of path.entries()) {
    if (typeof seg !== "string") continue; // an array element has the members of the array's type
    const hit = members.find((m) => m.name.toUpperCase() === seg.toUpperCase());
    if (hit) {
      members = seen.membersOf(hit);
      continue;
    }
    const near = nearest(seg, members.map((m) => m.name));
    return near ? show(root, path.map((s, j) => (j === i ? near : s))) : undefined;
  }
  return undefined;
}

/** The error with the name the test most likely meant, when there is one. */
function hinted(e: unknown, index: WorkspaceIndex, g: GlobalSymbol, typed: string, op: "set" | "expect"): unknown {
  if (!(e instanceof SimError) || /did you mean|is a constant|is VAR_TEMP|has not run yet|is a data block:/.test(e.message)) return e;
  const near = closestName(index, g, typed, op);
  return near ? new SimError(`${e.message} (did you mean ${near}?)`, e.block, e.offset) : e;
}

/**
 * Everything a stub can stand in for, by upper-case name: the PLC's FBs, FCs and technology objects, the types its
 * blocks declare instances of and the names they call, and the instructions of the catalogue and the simulator.
 */
function stubbable(seen: WorkspaceIndex): Map<string, string> {
  const out = new Map<string, string>();
  const add = (n: string) => {
    const bare = n.replace(/^"|"$/g, "");
    if (bare && !ELEMENTARY_TYPE.test(bare) && !/^(array|struct|string|wstring)\b/i.test(bare)) out.set(bare.toUpperCase(), bare);
  };
  for (const s of seen.allGlobals()) {
    if (s.kind === "FB" || s.kind === "FC" || s.kind === "OBJECT") add(s.name);
    for (const v of s.block?.vars ?? []) add(v.isArray ? (splitArrayType(v.type)?.element ?? "") : (v.typeRef ?? v.type));
    for (const r of s.block?.refs ?? []) if (r.kind === "call" || (r.kind === "global" && (r.access === "call" || r.name.includes("~")))) add(r.name);
    if (s.block?.dbOf) add(s.block.dbOf);
  }
  for (const e of STANDARD) add(e.name);
  for (const n of RECORD_INTERFACE.keys()) add(n);
  for (const n of SYSTEM_FUNCTIONS) add(n);
  return out;
}

/** The members (for an FC its outputs and RET_VAL) a stub may give values, by upper-case name; undefined when nothing describes the type. */
function stubInterface(seen: WorkspaceIndex, name: string): Map<string, { name: string; type: string }> | undefined {
  const b = seen.global(name)?.block;
  const upper = (xs: [string, string][]) => new Map(xs.map(([n, type]) => [n.toUpperCase(), { name: n, type }]));
  if (b?.kind === "FB") return upper(b.vars.filter((v) => v.section !== "Temp" && v.section !== "Constant").map((v) => [v.name, v.type]));
  if (b?.kind === "FC") return upper([...b.vars.filter((v) => v.section === "Output" || v.section === "InOut").map((v): [string, string] => [v.name, v.type]), ...(b.returnType && !/^void$/i.test(b.returnType) ? [["RET_VAL", b.returnType] as [string, string]] : [])]);
  const known = RECORD_INTERFACE.get(name.toUpperCase());
  if (known) return upper(known);
  const system = SYSTEM_TYPES.get(name.toUpperCase());
  if (system) return upper(system.map((m) => [m.name, m.type]));
  const std = STANDARD_BY_NAME.get(name.toUpperCase());
  if (std?.kind === "functionBlock") return upper(std.params.map((p) => [p.name, p.type]));
  if (std) return upper([["RET_VAL", std.returns ?? "ANY"], ...std.params.filter((p) => p.dir !== "in").map((p): [string, string] => [p.name, p.type])]);
  return undefined; // a system instruction, a missing block, a technology object: whatever the test names
}

/** A stub of something the simulator runs itself (a workspace block with code, a catalogue or simulated instruction). */
function runnable(seen: WorkspaceIndex, name: string): boolean {
  const g = seen.global(name);
  return !!g?.block || (!g && (STANDARD_BY_NAME.has(name.toUpperCase()) || SYSTEM_FUNCTIONS.has(name.toUpperCase())));
}

/** What is wrong with the stubs of a test file, in its words: a name nothing calls (did you mean?), an output the type does not have. */
function stubProblem(seen: WorkspaceIndex, tested: string, stubs: NonNullable<TestFile["stubs"]>): string | undefined {
  const known = stubbable(seen);
  for (const [name, values] of Object.entries(stubs)) {
    const bare = name.replace(/^"|"$/g, "");
    if (bare.toUpperCase() === tested.toUpperCase()) return `stubs.${name}: ${tested} is the block under test; stub what it calls`;
    if (!known.has(bare.toUpperCase())) {
      const near = nearest(bare, known.values());
      return `stubs.${name}: nothing in the workspace calls or declares ${bare}${near ? ` (did you mean ${near}?)` : ""}`;
    }
    const iface = bare.includes("~") ? undefined : stubInterface(seen, bare);
    if (!iface) continue;
    for (const [k, v] of Object.entries(values ?? {})) {
      const member = iface.get(k.toUpperCase());
      if (!member) {
        const near = nearest(k, [...iface.values()].map((m) => m.name));
        return `stubs.${name}.${k}: ${bare} has no ${k}${near ? ` (did you mean ${near}?)` : ""}`;
      }
      try {
        if (seen.membersOfType(member.type.replace(/^"|"$/g, "")).length) throw new SimError(`stubs.${name}.${k} is ${member.type}: set its members in the test steps`);
        checkType(`stubs.${name}.${k}`, member.type, normalizeExpected(v, member.type) as Value);
      } catch (e) {
        return (e as Error).message;
      }
    }
  }
  return undefined;
}

/** Interfaces absent from the instruction catalogue, but fixed by the PLC. */
const RECORD_INTERFACE = new Map<string, [string, string][]>([
  ["RDREC", [["REQ", "Bool"], ["ID", "DWord"], ["INDEX", "Int"], ["MLEN", "UInt"], ["RECORD", "Variant"], ["VALID", "Bool"], ["BUSY", "Bool"], ["ERROR", "Bool"], ["STATUS", "DWord"], ["LEN", "UInt"]]],
  ["WRREC", [["REQ", "Bool"], ["ID", "DWord"], ["INDEX", "Int"], ["LEN", "UInt"], ["RECORD", "Variant"], ["DONE", "Bool"], ["BUSY", "Bool"], ["ERROR", "Bool"], ["STATUS", "DWord"]]],
]);

/** Follow declarations, including each array dimension, rather than guessing from the stored value. */
function declaration(seen: WorkspaceIndex, g: GlobalSymbol, name: string): Member | undefined {
  const { global, root, path } = splitName(name);
  const target = seen.global(root);
  let m: Member | undefined = global
    ? target?.tag ? { name: root, type: target.tag.dataType, isArray: false } : target?.gvar ? { ...target.gvar.decl } : target ? { name: root, type: target.name, typeRef: target.name, isArray: false } : undefined
    : g.block!.vars.find((v) => v.name.toUpperCase() === root.toUpperCase()) ?? (target?.gvar ? { ...target.gvar.decl } : undefined);
  if (!global && g.block!.kind === "FC" && root.toUpperCase() === g.block!.name.toUpperCase()) m = { name: root, type: g.block!.returnType ?? "Void", isArray: false };
  for (const [i, seg] of path.entries()) {
    if (!m) return undefined;
    if (typeof seg !== "string") {
      for (const _ of seg) {
        const shape = splitArrayType(m.type);
        if (!shape) return undefined;
        const type = shape.dims.length > 1 ? `Array[${shape.dims.slice(1).join(",")}] of ${shape.element}` : shape.element;
        m = { ...m, type, isArray: /^array\b/i.test(type), typeRef: shape.element.replace(/^"|"$/g, "") };
      }
    } else {
      const known = RECORD_INTERFACE.get((m.typeRef ?? m.type).replace(/^"|"$/g, "").toUpperCase());
      const members = known ? known.map(([name, type]) => ({ name, type, isArray: false })) : seen.membersOf(m);
      const hit = members.find((v) => v.name.toUpperCase() === seg.toUpperCase());
      if (!hit && members.length) {
        const near = nearest(seg, members.map((v) => v.name));
        const suggested = (global ? `"${root}"` : root) + path.map((p, j) => typeof p === "string" ? `.${j === i ? near : p}` : `[${p.join(",")}]`).join("");
        throw new SimError(`${name} does not exist${near ? ` (did you mean ${suggested}?)` : ""}`);
      }
      m = hit;
    }
  }
  return m;
}

/** Point a shape error at the case/key the YAML parser located. */
function problemPosition(text: string, problem: string): { errorLine?: number; errorColumn?: number } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  let node: unknown = doc.contents;
  const ci = /^case (\d+)/.exec(problem);
  if (ci && isMap(doc.contents)) {
    const cases = doc.contents.get("cases", true);
    if (isSeq(cases)) node = cases.items[Number(ci[1]) - 1];
  }
  const key = /unknown key (\S+)/.exec(problem)?.[1];
  if (key && isMap(node)) node = node.items.find((p) => String(p.key) === key)?.key ?? node;
  const range = (node as { range?: number[] } | null)?.range;
  const pos = range ? lines.linePos(range[0]!) : undefined;
  return pos ? { errorLine: pos.line, errorColumn: pos.col } : {};
}

/** Collect external calls through the workspace graph, stopping at a stubbed unit. */
function requiredStubs(seen: WorkspaceIndex, tested: GlobalSymbol, provided: string[]): { name: string; reason: string; value: string; key: string }[] {
  const given = new Set(provided.map((n) => n.replace(/^"|"$/g, "").toUpperCase()));
  const visited = new Set<string>();
  const missing = new Map<string, { name: string; reason: string; value: string; key: string }>();
  const add = (name: string, reason: string, value = "{}") => {
    if (!given.has(name.toUpperCase())) missing.set(name.toUpperCase(), { name, reason, value, key: name.includes("~") || seen.global(name)?.kind === "OBJECT" ? `'"${name}"'` : name });
  };
  const visit = (g: GlobalSymbol) => {
    if (!g.block || visited.has(g.uri + g.name)) return;
    visited.add(g.uri + g.name);
    for (const r of g.block.refs) {
      if (r.kind === "global" && r.name.includes("~")) add(r.name, "has no value offline", "257");
      const global = r.kind !== "local" ? seen.global(r.name) : undefined;
      if (global?.kind === "OBJECT") add(global.name, "is not simulated");
      if (r.access !== "call") continue;
      let type = r.name;
      let member: Member | undefined = r.kind !== "global" ? g.block.vars.find((v) => v.name.toUpperCase() === r.name.toUpperCase()) ?? global?.gvar?.decl : global?.block?.dbOf ? { name: r.name, type: global.block.dbOf, typeRef: global.block.dbOf, isArray: false } : undefined;
      for (const seg of r.members) {
        if (!member) break;
        const hit = seen.membersOf(member).find((m) => m.name.toUpperCase() === seg.name.toUpperCase());
        if (!hit || hit.section === "Method" || hit.section === "Action") break;
        member = hit;
      }
      if (member) type = (member.typeRef ?? member.type).replace(/^"|"$/g, "");
      const key = type.toUpperCase();
      if (given.has(key)) continue;
      const target = seen.global(type);
      if (target?.block && /^(FB|FC|PRG)$/.test(target.block.kind)) visit(target);
      else if (target?.kind === "OBJECT" || global?.kind === "OBJECT") continue;
      else if (!STANDARD_BY_NAME.has(key) && !SYSTEM_FUNCTIONS.has(key) && !/^\w+_TO_\w+$|^__RUNG_/i.test(key))
        add(type, target ? "has no code the simulator can run" : RECORD_INTERFACE.has(key) || /^(MB_|MC_)/.test(key) ? "is not simulated" : "is not in the workspace", member || RECORD_INTERFACE.has(key) ? "{}" : "{ RET_VAL: 0 }");
    }
  };
  visit(tested);
  return [...missing.values()];
}

export interface TestHooks {
  /** Sees each case's simulator before it runs (the debugger, coverage). */
  simulator?: (sim: Simulator) => void;
  /** Told when each step of a case starts (from 1). */
  step?: (index: number) => void;
  /** Records the block's values after each step that runs cycles (CaseResult.observed): record to test. */
  observe?: boolean;
}

export async function runTestFile(index: WorkspaceIndex, file: string, text: string, only?: number, hooks: TestHooks = {}): Promise<FileResult> {
  let spec: TestFile;
  try {
    const lines = new LineCounter();
    const doc = parseDocument(text, { lineCounter: lines });
    if (doc.errors.length) {
      const e = doc.errors[0]!;
      const pos = lines.linePos(e.pos[0]);
      return { file, block: "?", cases: [], error: `invalid YAML: ${e.message}`, errorLine: pos.line, errorColumn: pos.col };
    }
    spec = (doc.toJS() ?? {}) as TestFile;
    const problem = shapeProblem(spec);
    if (problem) return { file, block: typeof spec.block === "string" ? spec.block : "?", cases: [], error: problem, ...problemPosition(text, problem) };
  } catch (e) {
    return { file, block: "?", cases: [], error: `invalid YAML: ${(e as Error).message}` };
  }
  const blockName = spec.block;
  if (!blockName) return { file, block: "?", cases: [], error: "missing `block:`" };
  const found = blockOf(index, blockName, spec.plc, file);
  if ("error" in found) return { file, block: blockName, cases: [], error: found.error };
  const g = found.symbol;
  if (!g.block) return { file, block: blockName, cases: [], error: `${blockName} has no code the simulator can run (a technology object or a know-how protected block)` };
  const seen = scopedTo(index, g.uri);
  const stubProblemText = spec.stubs ? stubProblem(seen, g.block.name, spec.stubs) : undefined;
  if (stubProblemText) return { file, block: blockName, cases: [], error: stubProblemText };
  const required = requiredStubs(seen, g, Object.keys(spec.stubs ?? {}));
  if (required.length) return { file, block: blockName, cases: [], error: `stubs needed (${required.map((s) => `${s.name} ${s.reason}`).join("; ")}): write stubs: { ${required.map((s) => `${s.key}: ${s.value}`).join(", ")} }` };
  // by upper-case name, without quotes; T#... values are durations; hardware identifiers are numbers
  const entries = Object.entries(spec.stubs ?? {}).map(([n, values]) => [n.replace(/^"|"$/g, "").toUpperCase(), values] as const);
  const stubs = new Map<string, Struct>(
    entries.filter(([n]) => !n.includes("~")).map(([n, values]) => [n, Object.fromEntries(Object.entries(values ?? {}).map(([k, v]) => [k.toUpperCase(), normalizeExpected(v, stubInterface(seen, n)?.get(k.toUpperCase())?.type) as Value]))]),
  );
  const hardware = new Map<string, number>(entries.filter(([n]) => n.includes("~")).map(([n, v]) => [n, Number(v)]));
  const stubCalls = new Map<string, number>();
  const cycleMs = spec.cycle !== undefined ? toMs(spec.cycle) : 10;
  const results: CaseResult[] = [];
  for (const [ci, c] of (spec.cases ?? []).entries()) {
    // one case asked for (rung test --case): the others do not run
    if (only !== undefined && ci !== only) continue;
    const t0 = Date.now();
    // what the block calls and uses is its own PLC's (another PLC may have objects of the same names)
    const sim = new Simulator(seen);
    sim.stubs = stubs;
    sim.hardwareIds = hardware;
    hooks.simulator?.(sim);
    const failures: TestFailure[] = [];
    const isFb = g.block.kind === "FB" || g.block.kind === "PRG";
    const inOuts = g.block.vars.filter((v) => v.section === "InOut");
    let inst: Instance | undefined;
    let fcInputs: Record<string, Value> = {};
    let fcOutputs: Struct = {};
    let fcReturn: Value;
    let fcRan = false;
    let current = 0; // the step running (from 1), for an error
    const getMem = (): Struct => (isFb ? inst!.mem : fcOutputs);
    const resolve = (name: string, op: "set" | "expect"): { get: () => Value; set: (v: Value) => void; decl?: Member } => {
      let { global, root, path } = splitName(name);
      const decl = declaration(seen, g, name);
      const own = !global ? g.block!.vars.find((v) => v.name.toUpperCase() === root.toUpperCase()) : undefined;
      if (own?.section === "Constant" || decl?.section === "Constant" || (global && seen.global(root)?.tag?.value !== undefined)) throw new SimError(`${name} is a constant: ${op === "set" ? "it cannot be set" : "use its declared value"}`);
      if (own?.section === "Temp" || decl?.section === "Temp") throw new SimError(`${name} is VAR_TEMP: it holds nothing between calls`);
      if (!global && !own && seen.global(root)?.kind === "DB") throw new SimError(`${root} is a data block: write '"${root}"${name.slice(root.length)}'`);
      const gvar = !global && !(isFb && root.toUpperCase() in getMem()) ? scopedTo(index, g.uri).global(root)?.gvar : undefined; // the block's own PLC's list
      if (gvar) ({ root, path } = { root: gvar.list, path: [root, ...path] }); // bare GVL variable
      const walk = (base: Struct, key: string, rest: Seg[]) => {
        let holder: Struct | Value[] = base;
        let k: string | number = key.toUpperCase();
        let open = false; // a stub of a type nobody describes: a member a test names is created
        const at = (): Value => (holder as Record<string | number, Value>)[k];
        for (const seg of rest) {
          let cur = at();
          open = false;
          if (cur && typeof cur === "object" && "__fb" in (cur as object)) {
            open = !!(cur as Instance).stub;
            cur = (cur as Instance).mem;
          }
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
            open = false;
          }
        }
        if (!Array.isArray(holder) && !((k as string) in holder) && !open) throw new SimError(`${name} does not exist`);
        const h = holder as Record<string | number, Value>;
        const kk = k;
        return { decl, get: () => h[kk], set: (v: Value) => void (h[kk] = v) };
      };
      if (global || ((!isFb || !(root.toUpperCase() in getMem())) && sim.isIecGlobal(root))) {
        sim.read({ root: { kind: "global", name: root }, path: [], start: 0 }, null); // materialize DB/tag
        return walk(sim.globals, root, path);
      }
      if (!isFb) {
        const key = root.toUpperCase();
        const returning = key === g.block!.name.toUpperCase();
        if (!own && !returning) throw new SimError(`${name} does not exist`);
        if (op === "set" && (returning || !["Input", "InOut"].includes(own?.section ?? ""))) throw new SimError(`${name} is not an input of ${g.block!.name}: set an input or IN_OUT`);
        if (op === "expect" && !fcRan && (returning || !(key in fcInputs))) throw new SimError(`${g.block!.name} has not run yet: run a cycle before expecting ${name}`);
        if (returning) return { decl, get: () => fcReturn, set: () => {} };
        const base = op === "set" || (["Input", "InOut"].includes(own?.section ?? "") && key in fcInputs) ? fcInputs : key in fcOutputs ? fcOutputs : fcInputs;
        if (!(key in base) && op === "set") base[key] = sim.defaultValue(own!, g.block);
        return walk(base, root, path);
      }
      return walk(getMem(), root, path);
    };
    const runCycle = () => {
      sim.time += cycleMs;
      if (isFb) sim.callBlock(inst!);
      else {
        const r = sim.callBlock(g.block!.name, fcInputs);
        fcOutputs = r.outputs;
        fcReturn = r.returnValue;
        fcRan = true;
        // IN_OUT parameters behave like the caller's variable: the value written by the FC is passed next cycle
        for (const v of inOuts) {
          const key = Object.keys(fcInputs).find((x) => x.toUpperCase() === v.name.toUpperCase()) ?? v.name;
          fcInputs[key] = fcOutputs[v.name.toUpperCase()];
        }
      }
    };
    const count = (op: string, v: unknown): number => {
      const n = Number(v ?? 1);
      if (!Number.isInteger(n) || n < 0) throw new SimError(`${op}: expected a whole number of cycles, got ${shown(v)}`);
      if (n > MAX_STEP_CYCLES) throw new SimError(`${op}: ${n} cycles; a step runs at most ${MAX_STEP_CYCLES}`);
      return n;
    };
    const advanceCycles = (v: unknown): number => {
      if ((typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v.trim()))) throw new SimError(`advance: write a unit, such as ${v}ms`);
      const ms = toMs(v);
      if (!Number.isFinite(ms) || ms < 0) throw new SimError(`advance: expected a time such as 2s or T#1m, got ${String(v)}`);
      const n = Math.max(1, Math.ceil(ms / cycleMs));
      if (n > MAX_STEP_CYCLES) throw new SimError(`advance: ${String(v)} is ${n} cycles of ${cycleMs}ms; a step runs at most ${MAX_STEP_CYCLES} (for long times, set a longer cycle: at the top of the file)`);
      return n;
    };
    const observed: NonNullable<CaseResult["observed"]> = [];
    const observe = (step: number) => {
      const values: Record<string, boolean | number | string> = {};
      const own = g.block!.vars.filter((v) => (isFb ? ["Output", "InOut", "Static"] : ["Output", "InOut"]).includes(v.section));
      const names = [...own.map((v) => ({ name: v.name, type: v.type })), ...(!isFb && g.block!.returnType && !/^void$/i.test(g.block!.returnType) ? [{ name: g.block!.name, type: g.block!.returnType }] : [])];
      const statics: string[] = [];
      // a value as a test writes it; an array's elements and a structure's members by their paths (arr[1], st.a)
      const put = (key: string, v: Value, decl: Pick<Member, "type" | "members"> | undefined, isStatic: boolean, depth: number) => {
        const type = decl?.type;
        if (typeof v === "number" && isTime(type)) values[key] = `T#${v}ms`;
        else if (typeof v === "number" && isReal(type)) values[key] = Number(realText(v));
        else if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") values[key] = v;
        else if (depth > 0 && isArrayValue(v) && v.items.length <= 32) {
          const element = splitArrayType(type ?? "")?.element;
          v.items.forEach((x, i) => put(`${key}[${v.lo + i}]`, x, element ? { type: element } : undefined, isStatic, depth - 1));
        } else if (depth > 0 && v && typeof v === "object" && !("__fb" in v) && !("__ptr" in v)) {
          const members = decl?.members ?? seen.membersOf({ type: type ?? "", isArray: false, name: key });
          for (const [mk, mv] of Object.entries(v as Struct)) {
            const m = members.find((x) => x.name.toUpperCase() === mk);
            put(`${key}.${m?.name ?? mk}`, mv, m, isStatic, depth - 1);
          }
        }
        if (isStatic && key in values) statics.push(key);
      };
      for (const n of names) {
        let v: Value;
        try {
          v = resolve(n.name, "expect").get();
        } catch {
          continue;
        }
        const d = own.find((x) => x.name === n.name);
        put(n.name, v, d ?? { type: n.type }, d?.section === "Static", 2);
      }
      observed.push({ step, values, ...(statics.length ? { statics: [...new Set(statics)] } : {}) });
    };
    try {
      if (g.block.kind === "PRG") inst = sim.read({ root: { kind: "global", name: g.block.name }, path: [], start: 0 }, null) as Instance; // one shared PROGRAM instance
      else if (isFb) inst = sim.newInstance(g.block.name);
      else if (g.block.kind !== "FC") throw new SimError(`${blockName} is a ${g.block.kind}; tests call FBs, FCs or PROGRAMs`);
      for (const [si, step] of (c.steps ?? []).entries()) {
        current = si + 1;
        hooks.step?.(current);
        const unknown = Object.keys(step ?? {}).find((k) => !(STEP_ORDER as readonly string[]).includes(k));
        if (unknown !== undefined || !step || !Object.keys(step).length) throw new SimError(`unknown step "${unknown ?? ""}" (use set, cycle, advance, expect)`);
        for (const op of STEP_ORDER) {
          if (!(op in step)) continue;
          const arg = step[op];
          if ((op === "set" || op === "expect") && !plain(arg)) throw new SimError(`${op}: write names and values, e.g. { Raw: 1 }`);
          switch (op) {
            case "set":
              for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
                let target: ReturnType<typeof resolve>;
                try {
                  target = resolve(k, "set");
                } catch (e) {
                  throw hinted(e, index, g, k, "set");
                }
                const currentValue = target.get();
                if (target.decl?.isArray || isArrayValue(currentValue)) {
                  const indices: number[] = [];
                  for (let arr = currentValue; isArrayValue(arr); arr = arr.items[0]) indices.push(arr.lo);
                  throw new SimError(`${k} is ${target.decl?.type ?? "an array"}: set its elements, e.g. '${k}[${indices.join(",")}]'`);
                }
                if (currentValue && typeof currentValue === "object") {
                  const mem = "__fb" in currentValue ? (currentValue as Instance).mem : currentValue as Struct;
                  const first = seen.membersOf(target.decl ?? { type: "", isArray: false, name: k })[0]?.name ?? Object.keys(mem)[0] ?? "member";
                  throw new SimError(`${k} is ${target.decl?.type ?? "a struct"}: set its members, e.g. '${k}.${first}'`);
                }
                const value = normalizeExpected(v, target.decl?.type) as Value;
                if (target.decl) checkType(k, target.decl.type, value);
                else checkKind(k, currentValue, value);
                target.set(value);
              }
              break;
            case "cycle":
              for (let n = 0, max = count("cycle", arg); n < max; n++) runCycle();
              break;
            case "advance": {
              for (let n = 0, max = advanceCycles(arg); n < max; n++) runCycle();
              break;
            }
            case "expect":
              for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
                let target: ReturnType<typeof resolve>;
                try {
                  target = resolve(k, "expect");
                } catch (e) {
                  throw hinted(e, index, g, k, "expect");
                }
                const actual = target.get();
                if (actual === undefined) throw new SimError(`${k} has no value: give it a start value in stubs`);
                const expected = normalizeExpected(v, target.decl?.type);
                if (!approx(actual, expected)) failures.push({ step: si + 1, name: k, expected: isTime(target.decl?.type) && typeof expected === "number" ? `T#${expected}ms` : expected, actual: isTime(target.decl?.type) && typeof actual === "number" ? `T#${actual}ms` : isReal(target.decl?.type) && typeof actual === "number" ? Number(realText(actual)) : actual });
              }
              break;
          }
        }
        if (hooks.observe && ("cycle" in step || "advance" in step)) observe(si + 1);
      }
      results.push({ name: c.name ?? `case ${ci + 1}`, index: ci, passed: failures.length === 0, failures, ms: Date.now() - t0, ...(hooks.observe ? { observed } : {}) });
    } catch (err) {
      // an FC input the test misspelt shows when the FC is called
      const input = err instanceof SimError ? /^(\S+) is not an input of (.+)$/.exec(err.message) : null;
      const e = input && input[2] === g.block.name ? hinted(err, index, g, input[1]!, "set") : err;
      const where = e instanceof SimError && e.block ? ` (in ${e.block}${e.offset !== undefined && !/\(line \d+\)/.test(e.message) ? `, line ${sim.lineOf(e.block, e.offset) ?? "?"}` : ""})` : "";
      results.push({ name: c.name ?? `case ${ci + 1}`, index: ci, passed: false, failures, error: e instanceof SimError ? `${e.message}${where}` : String(e), ms: Date.now() - t0, ...(current ? { errorStep: current } : {}) });
    }
    for (const [k, n] of sim.stubCalls) stubCalls.set(k, (stubCalls.get(k) ?? 0) + n);
  }
  // the stubs the cases reached, once per file; one never reached is most likely a typo
  const stubbed: NonNullable<FileResult["stubbed"]> = [];
  const warnings: string[] = [];
  for (const name of Object.keys(spec.stubs ?? {})) {
    const calls = stubCalls.get(name.replace(/^"|"$/g, "").toUpperCase()) ?? 0;
    if (calls) stubbed.push({ name, calls, ...(runnable(seen, name.replace(/^"|"$/g, "")) ? { runs: true as const } : {}) });
    // with one case selected the others did not run: a stub only they call is not unused
    else if (only === undefined && !results.some((c) => c.error)) warnings.push(`stub ${name} was never called: a typo, or code these cases do not reach`);
  }
  const plc = deviceOfUri(g.uri);
  const at = testPositions(text);
  for (const [ci, r] of results.entries()) {
    // a selected case (--case) keeps its own place in the file
    const p = at[r.index ?? ci];
    if (!p) continue;
    r.line = p.line;
    for (const f of r.failures) if (p.steps[f.step - 1]) f.line = p.steps[f.step - 1];
    if (r.errorStep && p.steps[r.errorStep - 1]) r.errorLine = p.steps[r.errorStep - 1];
  }
  return { file, block: blockName, ...(plc ? { plc } : {}), cases: results, ...(stubbed.length ? { stubbed } : {}), ...(warnings.length ? { warnings } : {}) };
}

/** Where each case and each of its steps starts in a test file (lines from 1), for editors. */
export function testPositions(text: string): { line: number; steps: number[] }[] {
  const lines = new LineCounter();
  let doc;
  try {
    doc = parseDocument(text, { lineCounter: lines });
  } catch {
    return [];
  }
  const lineOf = (n: unknown) => {
    const range = (n as { range?: [number, number, number] | null } | null)?.range;
    return range ? lines.linePos(range[0]).line : 0;
  };
  const cases = isMap(doc.contents) ? doc.contents.get("cases", true) : undefined;
  if (!isSeq(cases)) return [];
  return cases.items.map((c) => {
    const steps = isMap(c) ? c.get("steps", true) : undefined;
    return { line: lineOf(c), steps: isSeq(steps) ? steps.items.map(lineOf) : [] };
  });
}

/** One case of one file: its path relative to the workspace (with /) and its place among the file's cases, from 0. */
export interface CaseSelector {
  file: string;
  index: number;
}

/** Runs every tests/**\/*.test.yaml in the workspace (or the given files), or exactly one case. */
export async function runTests(root: string, index: WorkspaceIndex, filter?: string, only?: CaseSelector, hooks: TestHooks = {}): Promise<FileResult[]> {
  if (only) return [await runOneCase(root, index, only, hooks)];
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
    // --filter matches the file path or the block under test (rung test --filter Fx_Motor), which may carry a
    // comment after it; block names ignore letter case as in TIA Portal
    const whole = !filter || rel.toLowerCase().includes(filter.replace(/\\/g, "/").toLowerCase()) || new RegExp(`^block:\\s*["']?${filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*(#.*)?$`, "mi").test(text);
    // or a part of a case's name (rung test --filter stuck): those cases of the file
    if (!whole && !text.toLowerCase().includes(filter!.toLowerCase())) continue;
    const r = await runTestFile(index, rel, text, undefined, hooks);
    const cases = whole ? r.cases : r.cases.filter((c) => c.name.toLowerCase().includes(filter!.toLowerCase()));
    // a file that cannot run says so, whatever selected it
    if (whole || cases.length || r.error) out.push({ ...r, cases });
  }
  return out;
}

/** rung test --case: the file is read and checked as a whole, only the case runs; naming nothing is an error. */
async function runOneCase(root: string, index: WorkspaceIndex, only: CaseSelector, hooks: TestHooks): Promise<FileResult> {
  const rel = only.file.replace(/\\/g, "/").replace(/^\.\//, "");
  const path = resolve(root, rel);
  if (!/\.test\.ya?ml$/i.test(rel) || relative(resolve(root, "tests"), path).startsWith("..")) throw new Error(`--case ${only.file}: no test file under tests/`);
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) throw new Error(`--case ${only.file}: no test file there`);
  const r = await runTestFile(index, rel, text, only.index, hooks);
  const count = testPositions(text).length;
  if (!r.error && (only.index < 0 || only.index >= count)) throw new Error(`--case ${only.file}#${only.index}: the file has ${count} cases (numbered from 0)`);
  return r;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function toJUnit(results: FileResult[]): string {
  const cases = results.flatMap((f) => (f.error ? [{ f, c: { name: "(file)", passed: false, failures: [], error: f.error, ms: 0 } as CaseResult }] : f.cases.map((c) => ({ f, c }))));
  const failed = cases.filter((x) => !x.c.passed && !x.c.error).length;
  const errors = cases.filter((x) => !!x.c.error).length;
  const body = cases
    .map(({ f, c }) => {
      const inner = c.passed ? "" : c.error ? `<error message="${esc(c.errorStep ? `step ${c.errorStep}: ${c.error}` : c.error)}"/>` : `<failure message="${esc(c.failures.map((x) => `step ${x.step}: ${x.name} expected ${JSON.stringify(x.expected)} got ${JSON.stringify(x.actual)}`).join("; "))}"/>`;
      return `  <testcase classname="${esc(f.file)}" name="${esc(f.error ? f.file : `${f.block}: ${c.name}`)}" time="${(c.ms / 1000).toFixed(3)}">${inner}</testcase>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="rung" tests="${cases.length}" failures="${failed}" errors="${errors}">\n${body}\n</testsuite>\n`;
}
