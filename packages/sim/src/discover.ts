// SPDX-License-Identifier: BUSL-1.1
import { testValuesEqual } from "./runner.js";
/** Bounded search for behavioural differences, not proof of equivalence or correctness. */
export type DiscoveryScalar = boolean | number | string;
export class DiscoveryBudgetError extends Error {}
export interface DiscoveryStep { set: Record<string, DiscoveryScalar>; cycles: number }
export interface DiscoveryFrames {
  before: Record<string, DiscoveryScalar>[];
  after: Record<string, DiscoveryScalar>[];
  /** What the run reached (a static's value, a statement): a scenario that reaches something new is explored further. */
  reached?: string[];
}
export interface DiscoveryOptions {
  inputs: Record<string, DiscoveryScalar[]>;
  outputs: string[];
  maxCycles: number;
  maxEvents: number;
  maxRuns: number;
  holds: number[];
  seed: number;
  timeoutMs: number;
  /** Distinct differences to look for (1–8, default 3): one per signal and direction. */
  findings?: number;
  /** Scenarios from an earlier search, replayed first; those that do not fit the domains are skipped. */
  seeds?: DiscoveryStep[][];
}
export interface DiscoveryWitness extends DiscoveryFrames {
  steps: DiscoveryStep[];
  difference: { cycle: number; signal: string; before: DiscoveryScalar; after: DiscoveryScalar };
}
export interface DiscoveryResult {
  status: "found" | "not-found";
  stopped: "run-budget" | "time-budget" | "witness-found";
  runs: number;
  searched: number;
  reduced: boolean;
  reductionNotes?: string[];
  /** The first finding; `findings` has all of them, each reduced on its own. */
  witness?: DiscoveryWitness;
  findings?: DiscoveryWitness[];
  /** Scenarios that reached new states, for the next search (newest last, at most 64). */
  corpus: DiscoveryStep[][];
  /** Seeds that fitted the domains and were replayed. */
  reused: number;
}

/** What makes two differences one finding: the same signal, and for a Boolean the same direction. */
export const findingKey = (d: DiscoveryWitness["difference"]) => typeof d.before === "boolean" && typeof d.after === "boolean" ? `${d.signal}:${d.before}>${d.after}` : d.signal;
const scalar = (v: unknown): v is DiscoveryScalar => typeof v === "boolean" || typeof v === "string" && v.length <= 256 || typeof v === "number" && Number.isFinite(v);
const integer = (n: number, min: number, max: number, what: string) => { if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what}: expected an integer from ${min} to ${max}`); };

export function validateDiscovery(o: DiscoveryOptions): void {
  integer(o.maxCycles, 1, 256, "maxCycles"); integer(o.maxEvents, 1, 16, "maxEvents"); integer(o.maxRuns, 1, 10000, "maxRuns");
  integer(o.timeoutMs, 1, 120000, "timeoutMs"); integer(o.seed, 0, 0xffffffff, "seed");
  if (!o.inputs || typeof o.inputs !== "object" || Array.isArray(o.inputs) || !Object.keys(o.inputs).length || Object.keys(o.inputs).length > 16) throw new Error("inputs: choose 1–16 finite scalar domains");
  for (const [name, values] of Object.entries(o.inputs)) {
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){0,3}$/.test(name) || /(?:^|\.)(?:__proto__|constructor|prototype)(?:\.|$)/i.test(name)) throw new Error(`Unsupported input name: ${name}`);
    if (!Array.isArray(values) || !values.length || values.length > 8 || !values.every(scalar) || new Set(values.map(v => JSON.stringify(v))).size !== values.length) throw new Error(`inputs.${name}: choose 1–8 distinct finite scalar values`);
  }
  if (new Set(Object.keys(o.inputs).map(n => n.toUpperCase())).size !== Object.keys(o.inputs).length) throw new Error("Duplicate input names");
  if (!Array.isArray(o.outputs) || !o.outputs.length || o.outputs.length > 32 || o.outputs.some(n => typeof n !== "string" || !n || n.length > 256) || new Set(o.outputs.map(n => n.toUpperCase())).size !== o.outputs.length) throw new Error("outputs: choose 1–32 distinct observations");
  if (!Array.isArray(o.holds) || !o.holds.length || o.holds.length > 16) throw new Error("holds: choose 1–16 scan counts");
  for (const n of o.holds) integer(n, 1, o.maxCycles, "holds");
  if (o.findings !== undefined) integer(o.findings, 1, 8, "findings");
  if (o.seeds !== undefined && (!Array.isArray(o.seeds) || o.seeds.length > 256)) throw new Error("seeds: at most 256 scenarios");
}

/** A seed fits when every step sets exactly the domain's inputs to values of their domains, within the bounds. */
function fits(o: DiscoveryOptions, steps: unknown): steps is DiscoveryStep[] {
  if (!Array.isArray(steps) || !steps.length || steps.length > o.maxEvents) return false;
  let total = 0;
  for (const step of steps as unknown[]) {
    if (!step || typeof step !== "object") return false;
    const { set, cycles } = step as { set?: unknown; cycles?: unknown };
    if (!Number.isInteger(cycles) || (cycles as number) < 1 || !set || typeof set !== "object" || Array.isArray(set)) return false;
    total += cycles as number;
    const keys = Object.keys(set);
    if (keys.length !== Object.keys(o.inputs).length || keys.some(k => !Object.hasOwn(o.inputs, k) || !o.inputs[k]!.some(v => v === (set as Record<string, unknown>)[k]))) return false;
  }
  return total <= o.maxCycles;
}

function compact(steps: DiscoveryStep[]): DiscoveryStep[] {
  const out: DiscoveryStep[] = [];
  for (const s of steps) {
    const previous = out.at(-1);
    if (previous && JSON.stringify(previous.set) === JSON.stringify(s.set)) previous.cycles += s.cycles;
    else out.push(structuredClone(s));
  }
  return out;
}

export async function discover(options: DiscoveryOptions, execute: (steps: DiscoveryStep[]) => Promise<DiscoveryFrames>): Promise<DiscoveryResult> {
  validateDiscovery(options);
  const o = structuredClone(options), names = Object.keys(o.inputs).sort(), started = performance.now();
  let state = o.seed >>> 0, runs = 0, searched = 0, reduced = false;
  let scanDeadline = false;
  const reductionNotes = new Set<string>();
  // scenarios that reached a state no earlier one did, newest last: the search continues from them
  const reached = new Set<string>(), corpus: DiscoveryStep[][] = [];
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x100000000; };
  const baseline = Object.fromEntries(names.map(n => [n, o.inputs[n]![0]!]));
  const exhausted = () => scanDeadline || runs >= o.maxRuns || performance.now() - started >= o.timeoutMs;
  const known = new Set<string>();
  const check = async (steps: DiscoveryStep[], only?: string): Promise<DiscoveryWitness | undefined> => {
    if (exhausted()) return;
    runs++;
    const copy = structuredClone(steps);
    let frames: DiscoveryFrames;
    try { frames = await execute(structuredClone(copy)); }
    catch (error) { if (error instanceof DiscoveryBudgetError) { scanDeadline = true; return; } throw error; }
    const cycles = copy.reduce((n, s) => n + s.cycles, 0);
    if (frames.before.length !== cycles || frames.after.length !== cycles) throw new Error("Execution returned an incomplete observation frame sequence");
    let difference: DiscoveryWitness["difference"] | undefined;
    for (let i = 0; i < cycles; i++) for (const signal of o.outputs) {
      const a = frames.before[i]![signal], b = frames.after[i]![signal];
      if (!Object.hasOwn(frames.before[i]!, signal) || !Object.hasOwn(frames.after[i]!, signal) || !scalar(a) || !scalar(b)) throw new Error(`Missing or non-scalar observation: ${signal}`);
      if (typeof a !== typeof b) throw new Error(`Observation type changed: ${signal}`);
      if (difference || testValuesEqual(a, b)) continue;
      const d = { cycle: i + 1, signal, before: a, after: b }, key = findingKey(d);
      if (only ? key === only : !known.has(key)) difference = d;
    }
    if (runs % 16 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!only) {
      let fresh = false;
      for (const key of frames.reached ?? []) if (!reached.has(key)) { reached.add(key); fresh = true; }
      if (fresh) { corpus.push(copy); if (corpus.length > 128) corpus.shift(); }
    }
    if (difference) return { steps: copy, before: structuredClone(frames.before), after: structuredClone(frames.after), difference };
  };
  const vectors: Record<string, DiscoveryScalar>[] = [];
  const vectorKeys = new Set<string>();
  const addVector = (v: Record<string, DiscoveryScalar>) => {
    const key = JSON.stringify(v);
    if (vectors.length < 128 && !vectorKeys.has(key)) { vectorKeys.add(key); vectors.push(v); }
  };
  addVector({ ...baseline });
  for (const name of names) for (const value of o.inputs[name]!) addVector({ ...baseline, [name]: value });
  addVector(Object.fromEntries(names.map(n => [n, o.inputs[n]!.at(-1)!])));
  const simple = vectors.length;
  // Bound the Cartesian part; it is interleaved with the guided search, never ahead of it.
  const enumerate = (at: number, values: Record<string, DiscoveryScalar>) => {
    if (vectors.length >= 128) return;
    if (at === names.length) { addVector({ ...values }); return; }
    const n = names[at]!;
    for (const v of o.inputs[n]!) enumerate(at + 1, { ...values, [n]: v });
  };
  enumerate(0, {});
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const scans = (steps: DiscoveryStep[]) => steps.reduce((n, s) => n + s.cycles, 0);
  const randomScenario = () => {
    let left = o.maxCycles;
    const steps: DiscoveryStep[] = [], count = 1 + Math.floor(random() * o.maxEvents);
    for (let i = 0; i < count && left; i++) {
      const set = Object.fromEntries(names.map(n => [n, pick(o.inputs[n]!)]));
      const cycles = Math.min(left, pick(o.holds));
      steps.push({ set, cycles }); left -= cycles;
    }
    return compact(steps);
  };
  /** One or two inputs take another value; the rest stay as they were, as on a machine. */
  const nudge = (set: Record<string, DiscoveryScalar>) => {
    const next = { ...set };
    for (let k = 0, n = random() < 0.6 ? 1 : 2; k < n; k++) {
      const name = pick(names), others = o.inputs[name]!.filter(v => !testValuesEqual(v, next[name]));
      if (others.length) next[name] = pick(others);
    }
    return next;
  };
  /** A small change to a scenario that reached something new: most often one more event at its end. */
  const mutate = (from: DiscoveryStep[]) => {
    // half the time from an earlier point of it: what it did after reaching the new state may have undone it
    const steps = structuredClone(from).slice(0, random() < 0.5 ? 1 + Math.floor(random() * from.length) : from.length);
    const room = o.maxCycles - scans(steps), r = random();
    if (r < 0.6 && room > 0 && steps.length < o.maxEvents) steps.push({ set: nudge(steps.at(-1)!.set), cycles: Math.min(room, pick(o.holds)) });
    else if (r < 0.8) { const s = pick(steps); s.cycles = Math.max(1, Math.min(s.cycles + room, pick(o.holds))); }
    else { const s = pick(steps); s.set = nudge(s.set); }
    return compact(steps);
  };
  const seeds = (o.seeds ?? []).filter(steps => fits(o, steps)).map(steps => compact(structuredClone(steps)));
  let exploreFrom = Infinity;
  function* candidates(): Generator<DiscoveryStep[]> {
    yield* seeds;
    for (const v of vectors.slice(0, simple)) {
      yield [{ set: v, cycles: 1 }];
      if (o.maxEvents > 1 && o.maxCycles > 1) {
        yield [{ set: v, cycles: 1 }, { set: baseline, cycles: 1 }];
        yield [{ set: baseline, cycles: 1 }, { set: v, cycles: 1 }];
      }
      for (const hold of o.holds) if (hold > 1) yield [{ set: v, cycles: hold }];
    }
    // newest discoveries first, older ones still get their turn
    exploreFrom = searched;
    for (let n = 0, wide = simple; ; n++) {
      if (n % 4 === 3 && wide < vectors.length) yield [{ set: vectors[wide++]!, cycles: 1 }];
      else if (corpus.length && random() < 0.8) yield mutate(corpus[corpus.length - 1 - Math.floor(random() ** 2 * corpus.length)]!);
      else yield randomScenario();
    }
  }
  /** Shortens a witness for as long as it still shows the same finding. Keeps the replayed one when the budget ends. */
  const shrink = async (found: DiscoveryWitness): Promise<DiscoveryWitness> => {
    let witness = found;
    const key = findingKey(found.difference);
    const accept = async (steps: DiscoveryStep[]) => {
      if (!steps.length || exhausted()) return false;
      let next: DiscoveryWitness | undefined;
      try { next = await check(compact(steps), key); }
      catch (error) { reductionNotes.add(error instanceof Error ? error.message : String(error)); return false; }
      if (!next) return false;
      witness = next; reduced = true; return true;
    };
    let remaining = witness.difference.cycle;
    const prefix = witness.steps.flatMap(s => {
      const cycles = Math.min(s.cycles, remaining); remaining -= cycles;
      return cycles ? [{ set: s.set, cycles }] : [];
    });
    if (JSON.stringify(prefix) !== JSON.stringify(witness.steps)) await accept(prefix);
    for (let size = Math.floor(witness.steps.length / 2); size >= 1 && !exhausted(); size = Math.floor(size / 2)) {
      for (let i = 0; i < witness.steps.length && !exhausted();) {
        const steps = witness.steps.filter((_, n) => n < i || n >= i + size);
        if (!await accept(steps)) i += size;
      }
    }
    for (let i = 0; i < witness.steps.length && !exhausted(); i++) {
      let low = 1, high = witness.steps[i]!.cycles - 1;
      while (low <= high && !exhausted()) {
        const n = Math.floor((low + high) / 2), trial = structuredClone(witness.steps); trial[i]!.cycles = n;
        if (await accept(trial)) high = n - 1; else low = n + 1;
      }
      for (const name of names) {
        if (i >= witness.steps.length || exhausted()) break;
        const trial = structuredClone(witness.steps);
        if (trial[i]!.set[name] === baseline[name]) continue;
        trial[i]!.set[name] = baseline[name]!;
        await accept(trial);
      }
    }
    return witness;
  };
  // After a finding the search goes on for other ones, until it has `findings` or explores as long again without
  // one (at least 200 sequences). The seeds and the simple sequences are always tried.
  const findings: DiscoveryWitness[] = [], limit = o.findings ?? 3;
  let lastFound = 0;
  for (const steps of candidates()) {
    if (exhausted() || findings.length >= limit) break;
    if (findings.length && searched - Math.max(lastFound, exploreFrom) >= Math.max(200, lastFound)) break;
    searched++;
    const found = await check(steps);
    if (!found) continue;
    known.add(findingKey(found.difference));
    findings.push(await shrink(found));
    lastFound = searched;
  }
  const budget = scanDeadline || performance.now() - started >= o.timeoutMs ? "time-budget" : runs >= o.maxRuns ? "run-budget" : undefined;
  return {
    status: findings.length ? "found" : "not-found", stopped: findings.length && (!budget || findings.length >= limit) ? "witness-found" : budget ?? "witness-found", runs, searched, reduced,
    ...(reductionNotes.size ? { reductionNotes: [...reductionNotes] } : {}), ...(findings.length ? { witness: findings[0], findings } : {}),
    corpus: corpus.slice(-64), reused: seeds.length,
  };
}
