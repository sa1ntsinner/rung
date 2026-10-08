// SPDX-License-Identifier: BUSL-1.1
// The debugger behind `rung debug`: a test case runs again from its start up to the statement asked for.
// A run is deterministic (inputs come from the test's steps, time from its cycles), so every statement, an
// earlier one too, is reached by counting: stepping back costs one more run, and needs no snapshots.
// ponytail: each stop replays the case from the start; add checkpoints when cases run for minutes.
import type { WorkspaceIndex } from "@rung/lsp";
import { parseBody, SclSyntaxError, type Stmt } from "./ast.js";
import { runTestFile, type CaseResult } from "./runner.js";
import { SimError, type ArrayValue, type Frame, type Instance, type Pointer, type Simulator, type Struct, type Value } from "./runtime.js";

export interface Breakpoint {
  uri: string;
  /** 1-based. */
  line: number;
  condition?: string;
}

export interface DebugFrame {
  name: string;
  uri: string;
  line: number;
  column: number;
}

export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  /** What `evaluate` and `setVariable` take for it. */
  evaluateName?: string;
  children?: () => DebugVariable[];
}

export type StopReason = "entry" | "step" | "breakpoint" | "exception";
export type DebugState =
  /** `text`: why it stopped there (a failed expectation, an error). */
  | { kind: "stopped"; reason: StopReason; frames: DebugFrame[]; time: number; text?: string }
  /** The case ran to its end: its result, as `rung test` reports it. */
  | { kind: "ended"; result?: CaseResult; error?: string };

interface Entry {
  depth: number;
  /** The test step it ran in (from 1). */
  step: number;
  /** Virtual time of the cycle it ran in. */
  time: number;
  uri?: string;
  line?: number;
  column?: number;
}

class Pause {}

const sameUri = (a: string, b: string) => decodeURIComponent(a).toLowerCase() === decodeURIComponent(b).toLowerCase();

export class DebugSession {
  breakpoints: Breakpoint[] = [];
  /** The statement stopped before (counted from 1 over the whole case); 0 before the start. */
  private at = 0;
  private trace: Entry[] = [];
  private sim?: Simulator;
  private stack: Frame[] = [];
  /** Values set while stopped: applied again at that statement on every later run. */
  private sets: { at: number; frame: number; target: string; value: string }[] = [];

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly file: string,
    private readonly text: string,
    private readonly caseIndex: number,
  ) {}

  start(stopOnEntry: boolean): Promise<DebugState> {
    this.at = 0;
    this.sets = [];
    return stopOnEntry ? this.run(() => true, "entry") : this.continue();
  }

  stepIn(): Promise<DebugState> {
    return this.run((n) => n > this.at, "step");
  }

  next(): Promise<DebugState> {
    const d = this.depth();
    return this.run((n, e) => n > this.at && e.depth <= d, "step");
  }

  /** Back to the caller; in the block a test calls, on to its next cycle. */
  stepOut(): Promise<DebugState> {
    const d = this.depth();
    if (d <= 1) {
      const t = this.trace[this.at]?.time;
      return this.run((n, e) => n > this.at && e.depth === 1 && e.time !== t, "step");
    }
    return this.run((n, e) => n > this.at && e.depth < d, "step");
  }

  continue(): Promise<DebugState> {
    return this.run((n, e, f) => n > this.at && this.hits(e, f), "breakpoint");
  }

  /** The statement before, in this block or a caller (the reverse of `next`); the first one at the start. */
  stepBack(): Promise<DebugState> {
    const d = this.depth();
    for (let m = this.at - 1; m > 0; m--) if (this.trace[m]?.uri && this.trace[m]!.depth <= d) return this.goto(m, "step");
    return this.start(true);
  }

  /** Back to the last breakpoint hit before this statement, or the first statement. */
  async reverseContinue(): Promise<DebugState> {
    for (let m = this.at - 1; m > 0; m--) {
      const e = this.trace[m]!;
      const bp = this.breakpoints.find((b) => e.uri && sameUri(b.uri, e.uri) && b.line === e.line);
      if (!bp) continue;
      const s = await this.goto(m, "breakpoint");
      if (!bp.condition || s.kind !== "stopped" || this.truthy(bp.condition, this.stack.length - 1)) return s;
    }
    return this.start(true);
  }

  /** Sets a variable of a frame while stopped; later runs set it again at this statement. */
  async setVariable(target: string, value: string, frame: number): Promise<{ value: string; state: DebugState }> {
    this.assign(target, value, frame); // refused here, before it is kept
    this.sets.push({ at: this.at, frame, target, value });
    const state = await this.goto(this.at, "step");
    return { value: this.evaluate(target, frame).value, state };
  }

  /** An SCL expression in a frame (0 = innermost); `Name` is read as `#Name` when no global has that name. */
  evaluate(expr: string, frame = 0): DebugVariable {
    const f = this.frame(frame);
    const value = (text: string) => {
      const [s] = parseBody(`#__rung := ${text};`);
      if (s?.k !== "assign") throw new SimError("not an expression");
      return this.sim!.eval(s.value, f);
    };
    let v: Value;
    try {
      v = value(expr);
    } catch (e) {
      if (!/^[A-Za-z_]/.test(expr.trim())) throw message(e);
      try {
        v = value(`#${expr.trim()}`);
      } catch {
        throw message(e);
      }
    }
    return this.variable(expr, v, undefined, expr);
  }

  /** The frames stopped in, innermost first, as `frames` of the stopped state. */
  frames(): DebugFrame[] {
    const out: DebugFrame[] = [];
    const top = this.trace[this.at]!;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.stack[i]!;
      // a caller stands at the statement that called the next frame
      const e = i === this.stack.length - 1 ? top : this.callerEntry(i + 1);
      out.push({ name: f.inst && f.inst.__fb.toUpperCase() !== f.block.name.toUpperCase() ? `${f.inst.__fb}.${f.block.name}` : f.block.name, uri: e?.uri ?? "", line: e?.line ?? 0, column: e?.column ?? 1 });
    }
    return out;
  }

  /** Locals of a frame (0 = innermost): its interface and static variables, then its temporaries. */
  locals(frame: number): DebugVariable[] {
    const f = this.frame(frame);
    const out: DebugVariable[] = [];
    const seen = new Set<string>();
    for (const v of f.block.vars) {
      const key = v.name.toUpperCase();
      const holder = key in f.mem ? f.mem : key in f.temps ? f.temps : undefined;
      if (!holder || v.section === "Constant") continue;
      seen.add(key);
      out.push(this.variable(v.name, holder[key], v.type, `#${v.name}`));
    }
    // a FUNCTION's result lives under its own name
    const ret = f.block.name.toUpperCase();
    if (!seen.has(ret) && f.temps[ret] !== undefined) out.push(this.variable(f.block.name, f.temps[ret], f.block.returnType, f.block.name));
    return out;
  }

  /** The data blocks and tags the run has touched. */
  globals(): DebugVariable[] {
    return Object.entries(this.sim?.globals ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        const name = this.index.global(k)?.name ?? k;
        return this.variable(name, v, undefined, `"${name}"`);
      });
  }

  // ------------------------------------------------------------------ internals

  private depth(): number {
    return this.trace[this.at]?.depth ?? 1;
  }

  private frame(i: number): Frame {
    const f = this.stack[this.stack.length - 1 - i];
    if (!f || !this.sim) throw new Error("not stopped in a frame");
    return f;
  }

  /** The statement of frame `depth - 1` that called the frame at `depth`: the last one counted before it at a lower depth. */
  private callerEntry(depth: number): Entry | undefined {
    for (let m = this.at; m > 0; m--) if (this.trace[m]!.depth === depth) return this.trace[m];
    return undefined;
  }

  private hits(e: Entry, f: Frame): boolean {
    return this.breakpoints.some((b) => {
      if (!e.uri || !sameUri(b.uri, e.uri) || b.line !== e.line) return false;
      if (!b.condition) return true;
      this.stack = [...this.sim!.frames];
      return this.truthy(b.condition, this.stack.length - 1 - this.stack.indexOf(f));
    });
  }

  /** A condition that cannot be evaluated stops, so its error shows. */
  private truthy(condition: string, frame: number): boolean {
    try {
      return !!this.evaluateRaw(condition, frame);
    } catch {
      return true;
    }
  }

  private evaluateRaw(condition: string, frame: number): Value {
    const run = this.sim!.onStatement;
    this.sim!.onStatement = undefined; // a condition that calls a block runs no counted statements
    try {
      const [s] = parseBody(`#__rung := ${condition};`);
      if (s?.k !== "assign") return true;
      try {
        return this.sim!.eval(s.value, this.frame(frame));
      } catch {
        const [b] = parseBody(`#__rung := #${condition.trim()};`);
        return b?.k === "assign" ? this.sim!.eval(b.value, this.frame(frame)) : true;
      }
    } finally {
      this.sim!.onStatement = run;
    }
  }

  private assign(target: string, value: string, frame: number) {
    const f = this.frame(frame);
    let s: Stmt | undefined;
    try {
      [s] = parseBody(`${target} := ${value};`);
    } catch (e) {
      throw message(e);
    }
    if (s?.k !== "assign") throw new Error(`${target} cannot be set`);
    try {
      this.sim!.write(s.target, this.sim!.eval(s.value, f), f);
    } catch (e) {
      throw message(e);
    }
  }

  private goto(m: number, reason: StopReason): Promise<DebugState> {
    return this.run((n) => n === m, reason);
  }

  private async run(stop: (n: number, e: Entry, f: Frame) => boolean, reason: StopReason): Promise<DebugState> {
    let n = 0;
    let paused = false;
    let step = 0;
    const from = this.at;
    const trace: Entry[] = [];
    const r = await runTestFile(this.index, this.file, this.text, this.caseIndex, {
      step: (i) => void (step = i),
      simulator: (sim) => {
        this.sim = sim;
        sim.onStatement = (s, f) => {
          if (paused) throw new Pause(); // swallowed somewhere (a property read): stop again
          n++;
          const loc = sim.locationOf(f, s.at);
          const e: Entry = { depth: sim.frames.length, step, time: sim.time, ...loc };
          trace[n] = e;
          for (const x of this.sets) if (x.at === n) this.applySet(sim, x);
          if (loc && stop(n, e, f)) {
            paused = true;
            this.at = n;
            this.stack = [...sim.frames];
            throw new Pause();
          }
        };
      },
    });
    this.trace = trace;
    if (paused) return { kind: "stopped", reason, frames: this.frames(), time: this.sim!.time };
    const result = r.cases[0];
    // a failed expectation or an error stops where it shows: the last statement before the failing step (or the one
    // that failed), once, on the way there
    const failure = result?.failures[0];
    const stepOf = failure?.step ?? (result?.error ? result.errorStep : undefined);
    if (stepOf !== undefined) {
      let m = n;
      while (m > 0 && (!trace[m]?.uri || trace[m]!.step > stepOf)) m--;
      if (m > from) {
        const text = failure ? `step ${failure.step}: ${failure.name} expected ${JSON.stringify(failure.expected)}, got ${JSON.stringify(failure.actual)}` : `step ${stepOf}: ${result!.error}`;
        const s = await this.goto(m, "exception");
        return s.kind === "stopped" ? { ...s, text } : s;
      }
    }
    this.at = n + 1;
    this.stack = [];
    return { kind: "ended", result, ...(r.error ? { error: r.error } : {}) };
  }

  private applySet(sim: Simulator, x: { frame: number; target: string; value: string }) {
    const f = sim.frames[sim.frames.length - 1 - x.frame];
    const [s] = parseBody(`${x.target} := ${x.value};`);
    if (f && s?.k === "assign") sim.write(s.target, sim.eval(s.value, f), f);
  }

  private variable(name: string, v: Value, type: string | undefined, evaluateName: string | undefined): DebugVariable {
    const base = { name, ...(type ? { type } : {}), ...(evaluateName ? { evaluateName } : {}) };
    if (v === undefined) return { ...base, value: "—" };
    if (typeof v === "boolean") return { ...base, value: v ? "TRUE" : "FALSE" };
    if (typeof v === "number") return { ...base, value: /^L?TIME$/i.test(type ?? "") ? `T#${v}ms` : String(v) };
    if (typeof v === "string") return { ...base, value: `'${v}'` };
    if ("__ptr" in v) {
      const p = (v as Pointer).__ptr;
      const target = (p.obj as Record<string | number, Value>)[p.key];
      return { ...this.variable(name, target, type, evaluateName), name };
    }
    if ("__array" in v) {
      const a = v as ArrayValue;
      const hi = a.lo + a.items.length - 1;
      return { ...base, value: `ARRAY[${a.lo}..${hi}]`, children: () => a.items.map((x, i) => this.variable(`[${a.lo + i}]`, x, elementType(type), evaluateName && `${evaluateName}[${a.lo + i}]`)) };
    }
    const inst = "__fb" in v ? (v as Instance) : undefined;
    const mem: Struct = inst ? inst.mem : (v as Struct);
    const members = Object.entries(mem).filter(([k]) => !k.startsWith("__"));
    return {
      ...base,
      value: inst ? inst.__fb : `{${members.length}}`,
      children: () => members.map(([k, x]) => this.variable(memberName(this.index, inst?.__fb, k), x, undefined, evaluateName && `${evaluateName}.${memberName(this.index, inst?.__fb, k)}`)),
    };
  }
}

/** The declared spelling of an FB's member (memory keeps upper case). */
function memberName(index: WorkspaceIndex, fb: string | undefined, key: string): string {
  return (fb && index.global(fb)?.block?.vars.find((v) => v.name.toUpperCase() === key)?.name) || key;
}

function elementType(type: string | undefined): string | undefined {
  return type ? /\bOF\s+(.+)$/i.exec(type)?.[1]?.trim() : undefined;
}

function message(e: unknown): Error {
  if (e instanceof SclSyntaxError || e instanceof SimError) return new Error(e.message);
  return e instanceof Error ? e : new Error(String(e));
}
