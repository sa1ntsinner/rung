// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { deviceOfUri, scopedTo, type WorkspaceIndex } from "@rung/lsp";
import type { Expr, Stmt } from "./ast.js";
import { refText, type WhyNode } from "./debug.js";
import { Simulator, SimError, splitArrayType, type Frame, type Struct, type Value, type ArrayValue, type Instance } from "./runtime.js";

export interface CycleScope { plc: string; instance: string; epoch: number }
export interface CycleCapture {
  scope: CycleScope;
  sourceRevision: string;
  time: number;
  clockStart: number;
  coherence: "controlled-cycle" | "subscription-sample";
  before: { mem: Struct; globals: Struct };
  observed: Struct;
}
type Location = { uri: string; line: number; column: number };
export type ReconstructedEntry = Location & ({ kind: "statement"; statement: Stmt["k"] }
  | { kind: "expression"; expression: Expr; value: Value; statementIndex: number }
  | { kind: "write"; path: string; value: Value; statementIndex: number; parents: number[] });

/** Includes dependencies in the selected PLC and shared sources, never another PLC. */
export function reconstructionRevision(index: WorkspaceIndex, uri: string): string {
  const device = deviceOfUri(uri);
  const sources = [...index.docs.values()].filter(d => !device || !deviceOfUri(d.uri) || deviceOfUri(d.uri) === device)
    .sort((a, b) => a.uri.localeCompare(b.uri)).map(d => [d.uri, d.text]);
  return createHash("sha256").update(JSON.stringify(sources)).digest("hex");
}

/** Replays supplied pre-call state. Agreement never proves the PLC executed this path. */
export function reconstructCycle(index: WorkspaceIndex, uri: string, capture: CycleCapture, selected: CycleScope, maxEntries = 10_000) {
  if (!capture || !capture.scope || !selected || !selected.plc || !selected.instance || !Number.isSafeInteger(selected.epoch) || selected.epoch < 1
    || capture.scope.plc !== selected.plc || capture.scope.instance !== selected.instance || capture.scope.epoch !== selected.epoch
    || deviceOfUri(uri) !== selected.plc) throw new SimError("Capture scope changed or is invalid");
  if (capture.sourceRevision !== reconstructionRevision(index, uri)) throw new SimError("Capture source revision changed");
  if (!Number.isFinite(capture.time) || capture.time < 0 || !Number.isFinite(capture.clockStart)) throw new SimError("Invalid capture time");
  if (capture.coherence !== "controlled-cycle" && capture.coherence !== "subscription-sample") throw new SimError("Invalid capture coherence");
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) throw new SimError("Invalid trace limit");
  const block = index.docs.get(uri)?.parsed?.blocks[0];
  if (!block || block.kind !== "FB" || block.lad || block.stl) throw new SimError("Reconstruction requires a source SCL FB");
  const scoped = scopedTo(index, uri);
  const candidates = scoped.allGlobals().filter(g => g.kind === "FB" && g.name.toUpperCase() === block.name.toUpperCase());
  if (candidates.length !== 1 || candidates[0]?.uri !== uri) throw new SimError("Ambiguous FB source");
  type Declaration = { name: string; type: string; typeRef?: string; members?: Declaration[] };
  const integers: Record<string, [number, boolean]> = { SINT: [8, true], INT: [16, true], DINT: [32, true], LINT: [64, true],
    USINT: [8, false], UINT: [16, false], UDINT: [32, false], ULINT: [64, false], BYTE: [8, false], WORD: [16, false], DWORD: [32, false], LWORD: [64, false] };
  function declaration(d: Declaration, path: string, value?: Value, depth = 0): number {
    if (depth > 32) throw new SimError("Capture state limit exceeded");
    if (/\b(pointer|reference|variant|any)\b/i.test(d.type)) throw new SimError(`${path}: pointer/reference state is unsupported`);
    const array = splitArrayType(d.type);
    if (array) {
      let size = 1;
      for (const dim of array.dims) {
        const bounds = /^\s*([+-]?\d+)\s*\.\.\s*([+-]?\d+)\s*$/.exec(dim);
        if (!bounds) throw new SimError(`${path}: nonliteral array bounds are unsupported`);
        const length = Number(bounds[2]) - Number(bounds[1]) + 1;
        size *= length;
        if (length < 1 || !Number.isSafeInteger(size) || size > 100_000) throw new SimError("Capture state limit exceeded");
      }
      const element = { name: d.name, type: array.element, typeRef: array.element.replace(/^"|"$/g, ""), members: d.members };
      const cost = size * (array.dims.length + declaration(element, path, undefined, depth + array.dims.length));
      if (cost > 100_000) throw new SimError("Capture state limit exceeded");
      function items(v: ArrayValue, dimension: number) {
        for (const item of v.items) if (dimension + 1 < array!.dims.length) items(item as ArrayValue, dimension + 1);
        else declaration(element, path, item, depth + dimension + 1);
      }
      if (value !== undefined) items(value as ArrayValue, 0);
      return cost;
    }
    const members = d.members ?? scoped.membersOfType(d.typeRef ?? d.type.replace(/^"|"$/g, ""));
    if (members.length) {
      const mem = value && typeof value === "object" && "__fb" in value ? value.mem as Struct : value as Struct | undefined;
      let cost = 1;
      for (const member of members) {
        cost += declaration(member, `${path}.${member.name}`, mem?.[member.name.toUpperCase()], depth + 1);
        if (cost > 100_000) throw new SimError("Capture state limit exceeded");
      }
      return cost;
    }
    const integer = integers[d.type.trim().toUpperCase()];
    if (integer && value !== undefined) {
      if (typeof value !== "number" || !Number.isInteger(value)) throw new SimError(`${path}: invalid integer state type`);
      const [bits, signed] = integer; const bound = 1n << BigInt(bits - (signed ? 1 : 0));
      if (BigInt(value) < (signed ? -bound : 0n) || BigInt(value) >= bound) throw new SimError(`${path}: integer state out of range`);
    }
    return 1;
  }
  // ponytail: literal array bounds only; resolve constant expressions when capture supports them.
  let declaredNodes = 0;
  for (const d of block.vars) {
    declaredNodes += declaration(d, d.name);
    if (declaredNodes > 100_000) throw new SimError("Capture state limit exceeded");
  }
  const sim = new Simulator(scoped, 100_000);
  const instance = sim.newInstance(block.name);
  let nodes = 0;
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  function state(template: Value, value: unknown, path: string, depth = 0): Value {
    if (++nodes > 100_000 || depth > 32) throw new SimError("Capture state limit exceeded");
    if (template && typeof template === "object" && ("std" in template || "stub" in template || "__ptr" in template))
      throw new SimError(`${path}: opaque standard-FB/pointer state is unsupported`);
    if (value === undefined) throw new SimError(`${path}: missing state`);
    if (Array.isArray(template)) {
      if (!Array.isArray(value) || value.length !== template.length) throw new SimError(`${path}: array shape mismatch`);
      return template.map((v, i) => state(v, value[i], `${path}[${i}]`, depth + 1)) as never;
    }
    if (template && typeof template === "object") {
      if (!plain(value) || Object.keys(value).some(key => !Object.hasOwn(template, key))) throw new SimError(`${path}: state shape mismatch`);
      const out: Struct = Object.create(null);
      for (const [key, v] of Object.entries(template)) {
        if (!Object.hasOwn(value, key)) {
          // Report opaque state before the generic missing-member error.
          if (v && typeof v === "object" && "std" in v) throw new SimError(`${path}.${key}: opaque standard-FB state is unsupported`);
          throw new SimError(`${path}.${key}: missing state`);
        }
        out[key] = state(v, value[key], `${path}.${key}`, depth + 1);
      }
      if ("__fb" in template && out.__fb !== template.__fb || "__array" in template && (out.__array !== true || out.lo !== template.lo))
        throw new SimError(`${path}: state identity/array bounds mismatch`);
      return out;
    }
    if (template === undefined || typeof value !== typeof template || typeof value === "number" && !Number.isFinite(value))
      throw new SimError(`${path}: invalid state type`);
    return value as Value;
  }
  if (!capture.before || !plain(capture.before.globals) || !plain(capture.before.mem)) throw new SimError("Missing pre-cycle state");
  instance.mem = state(instance.mem, capture.before.mem, "instance") as Struct;
  const observed = state(instance.mem, capture.observed, "observed") as Struct;
  for (const d of block.vars.filter(d => d.section !== "Temp" && d.section !== "Constant")) {
    declaration(d, `instance.${d.name}`, instance.mem[d.name.toUpperCase()]);
    declaration(d, `observed.${d.name}`, observed[d.name.toUpperCase()]);
  }
  const selectedName = /^"([^"\r\n]+)"$/.exec(selected.instance)?.[1]?.toUpperCase();
  const selectedDb = selectedName ? scoped.global(selectedName)?.block : undefined;
  const alias = selectedDb?.kind === "DB" && selectedDb.dbOf?.toUpperCase() === block.name.toUpperCase() ? selectedName : undefined;
  if (alias) sim.globals[alias] = instance;
  for (const [name, value] of Object.entries(capture.before.globals)) {
    const g = scoped.global(name);
    if (name !== name.toUpperCase() || !g) throw new SimError(`${name}: unknown global state`);
    const type = g.tag?.dataType ?? g.block?.dbOf ?? g.name;
    const decl = g.gvar?.decl ?? { name, type, typeRef: type };
    declaration(decl, name);
    const template = sim.read({ root: { kind: "global", name }, path: [], start: 0 }, null);
    const cloned = state(template, value, name);
    declaration(decl, name, cloned);
    if (name === alias) {
      if (!isDeepStrictEqual((cloned as Struct).mem, instance.mem)) throw new SimError(`${name}: conflicting selected instance state`);
    } else sim.globals[name] = cloned;
  }
  // Template initializers may allocate globals; only supplied captured memory can survive into replay.
  for (const name of Object.keys(sim.globals))
    if (name !== alias && !Object.hasOwn(capture.before.globals, name)) delete sim.globals[name];
  sim.onMissingGlobal = name => { throw new SimError(`${name}: missing pre-cycle global state`); };
  sim.time = capture.time; sim.clockStart = capture.clockStart;
  const trace: ReconstructedEntry[] = [];
  const stack: { statement: Stmt; frame: Frame; index: number }[] = [];
  let traceBytes = 0;
  function append(entry: ReconstructedEntry) {
    traceBytes += Buffer.byteLength(JSON.stringify(entry));
    if (trace.length >= maxEntries || traceBytes > 1_048_576) throw new SimError("Trace limit exceeded");
    trace.push(entry);
  }
  sim.onStatement = (statement, frame) => {
    stack.push({ statement, frame, index: trace.length });
    const location = sim.locationOf(frame, statement.at);
    if (location) append({ ...location, kind: "statement", statement: statement.k });
  };
  sim.onStatementEnd = () => { stack.pop(); };
  sim.onExpression = (expression, frame, value) => {
    const at = stack.findLast(row => row.frame === frame);
    if (!at || !frame) return;
    const location = sim.locationOf(frame, at.statement.at);
    if (location) append({ ...location, kind: "expression", expression: structuredClone(expression), value: structuredClone(value), statementIndex: at.index });
  };
  let destinationVisits = 0;
  sim.onWrite = (obj, key, value, frame) => {
    const at = stack.findLast(row => row.frame === frame);
    if (!at) return;
    const location = sim.locationOf(at.frame, at.statement.at);
    if (!location) return;
    // ponytail: scan current memory for aliases; refuse after ten million visits rather than maintain stale reverse paths.
    function visit(current: Value, path: string) {
      if (!current || typeof current !== "object") return;
      if (++destinationVisits > 10_000_000) throw new SimError("Write attribution limit exceeded");
      if ("__fb" in current) { visit((current as Instance).mem, path); return; }
      const array = "__array" in current ? current as ArrayValue : undefined;
      if ((array?.items ?? current) === obj) {
        const target = array ? path + "[" + (array.lo + Number(key)) + "]" : path ? path + "." + key : String(key);
        append({ ...location!, kind: "write", path: target, value: structuredClone(value), statementIndex: at!.index,
          parents: stack.filter(row => row.index !== at!.index).map(row => row.index) });
      }
      if (array) array.items.forEach((item, i) => visit(item, path + "[" + (array.lo + i) + "]"));
      else for (const [name, item] of Object.entries(current)) visit(item, path ? path + "." + name : name);
    }
    visit(instance.mem, "");
  };
  sim.callBlock(instance);
  const divergences: { path: string; reconstructed: Value; observed: Value }[] = [];
  function compare(actual: Value, expected: Value, path: string) {
    if (actual && typeof actual === "object" && expected && typeof expected === "object") {
      for (const key of Object.keys(expected).sort()) compare((actual as Struct)[key], (expected as Struct)[key], path ? `${path}.${key}` : key);
    } else if (!Object.is(actual, expected)) divergences.push({ path, reconstructed: structuredClone(actual), observed: structuredClone(expected) });
  }
  compare(instance.mem, observed, "");
  return { kind: "reconstructed" as const, exact: false as const, scope: { ...selected }, sourceRevision: capture.sourceRevision,
    coherence: capture.coherence, time: capture.time, trace, after: structuredClone(instance.mem), divergences };
}

/** Uses recorded events only; no expression, index or call is evaluated for Why?. */
export function reconstructionWhy(result: ReturnType<typeof reconstructCycle>, target: string): WhyNode {
  const path = target.replace(/^#/, "").toUpperCase();
  if (!/^[A-Z_]\w*(?:\.[A-Z_]\w*|\[-?\d+\])*$/.test(path)) throw new SimError("Why requires a captured member path with literal indices");
  function member(value: Value, suffix: string): Value | undefined {
    for (const token of suffix.matchAll(/([A-Z_]\w*)|\[(-?\d+)\]/g)) {
      if (!value || typeof value !== "object") return undefined;
      if ("__fb" in value) value = (value as Instance).mem;
      if (token[2] !== undefined) {
        if (!("__array" in value)) return undefined;
        const array = value as ArrayValue;
        value = array.items[Number(token[2]) - array.lo]!;
      } else value = (value as Struct)[token[1]!]!;
    }
    return value;
  }
  const shown = (value: Value | undefined) => value === undefined ? "—" : typeof value === "boolean" ? value ? "TRUE" : "FALSE"
    : JSON.stringify(value).slice(0, 512);
  const root: WhyNode = { kind: "value", text: target, value: shown(member(result.after, path)), children: [] };
  const writeIndex = result.trace.findLastIndex(entry => entry.kind === "write" && (entry.path === path || path.startsWith(entry.path + ".") || path.startsWith(entry.path + "[")));
  const write = result.trace[writeIndex];
  if (write?.kind === "write") {
    const operands = (index: number): WhyNode[] => result.trace.slice(0, writeIndex).filter(entry => entry.kind === "expression" && entry.statementIndex === index)
      .slice(-32).map(entry => {
        const e = (entry as Extract<ReconstructedEntry, { kind: "expression" }>).expression;
        const text = e.k === "ref" ? refText(e.ref) : e.k === "call" ? refText(e.callee) + "(…)" : e.k === "bin" || e.k === "un" ? e.op : "literal";
        return { kind: "value", text: text.slice(0, 120), value: shown((entry as Extract<ReconstructedEntry, { kind: "expression" }>).value), children: [] };
      });
    const node: WhyNode = { kind: "write", text: `${write.path} := ${shown(write.value)}`, at: { uri: write.uri, line: write.line, time: result.time },
      children: operands(write.statementIndex) };
    for (const index of write.parents.slice(-8)) {
      const parent = result.trace[index];
      if (parent?.kind === "statement" && ["if", "case", "while", "repeat", "for"].includes(parent.statement))
        node.children.push({ kind: "condition", text: `${parent.statement.toUpperCase()} replay at line ${parent.line}`, at: { uri: parent.uri, line: parent.line }, children: operands(index) });
    }
    root.children.push(node);
  } else root.children.push({ kind: "note", text: "Not written during this replay: supplied pre-cycle state, or no supported write attribution.", children: [] });
  root.children.push({ kind: "note", text: "Historical reconstruction; PLC execution unverified. Recorded evaluations only; up to 32 per statement and eight enclosing controls.", children: [] });
  return root;
}
