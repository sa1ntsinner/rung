// SPDX-License-Identifier: BUSL-1.1
// The debugger behind `rung debug`: a test case runs again from its start up to the statement asked for.
// A run is deterministic (inputs come from the test's steps, time from its cycles), so every statement, an
// earlier one too, is reached by counting: stepping back costs one more run, and needs no snapshots.
// ponytail: each stop replays the case from the start (about 60 ms per 1000 cycles); add checkpoints when cases
// run for minutes.
import { STANDARD_BY_NAME, type VarDecl, type WorkspaceIndex } from "@rung/lsp";
import { parseBody, SclSyntaxError, type Expr, type LRef, type Stmt } from "./ast.js";
import { checkKind, checkType, runTestFile, type CaseResult } from "./runner.js";
import { realText, SimError, Simulator, splitArrayType, type ArrayValue, type Frame, type Instance, type Pointer, type Struct, type Value } from "./runtime.js";

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

/** One step of an explanation: a value, the statement that wrote it, the branch that made that run, or a note. */
export interface WhyNode {
  kind: "value" | "write" | "condition" | "note";
  text: string;
  value?: string;
  at?: { uri: string; line: number; time: number };
  children: WhyNode[];
}

export type StopReason = "entry" | "step" | "breakpoint" | "exception";
export type DebugState =
  /** `text`: why it stopped there (a failed expectation, an error, a condition that could not be evaluated). */
  | { kind: "stopped"; reason: StopReason; frames: DebugFrame[]; time: number; text?: string }
  /** The case ran to its end: its result, as `rung test` reports it; `note` when nothing could be stopped at. */
  | { kind: "ended"; result?: CaseResult; error?: string; note?: string };

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

/** What is known of a variable's declaration: its type text, a named type, its own members. */
type Decl = Pick<VarDecl, "type"> & Partial<Pick<VarDecl, "typeRef" | "members">>;

class Pause {}

const sameUri = (a: string, b: string) => decodeURIComponent(a).toLowerCase() === decodeURIComponent(b).toLowerCase();
const isArray = (v: Value): v is ArrayValue => typeof v === "object" && v !== null && "__array" in v;

export class DebugSession {
  breakpoints: Breakpoint[] = [];
  /** The statement stopped before (counted from 1 over the whole case); 0 before the start. */
  private at = 0;
  private trace: Entry[] = [];
  private sim?: Simulator;
  private stack: Frame[] = [];
  /** Values set while stopped: applied again at that statement on every later run. */
  private sets: { at: number; frame: number; target: string; value: string }[] = [];
  /** Why the last stop happened, when the reason alone does not say (a condition that failed). */
  private note?: string;

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

  /** Back to the last breakpoint hit before this statement (its condition held), or the first statement. */
  async reverseContinue(): Promise<DebugState> {
    const target = this.at;
    let last = 0;
    // one run up to here finds the last hit, conditions evaluated where they ran
    await this.run((n, e, f) => {
      if (n >= target) return true;
      if (this.hits(e, f)) last = n;
      return false;
    }, "breakpoint");
    this.note = undefined;
    return last ? this.goto(last, "breakpoint") : this.start(true);
  }

  /** Sets a variable of a frame while stopped (checked against its type); later runs set it again at this statement. */
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
    let text = expr.trim();
    try {
      v = value(text);
    } catch (e) {
      if (!/^[A-Za-z_]/.test(text)) throw message(e);
      try {
        v = value(`#${text}`);
        text = `#${text}`;
      } catch {
        throw message(e);
      }
    }
    return this.variable(expr, v, this.declOf(text, f), expr);
  }

  /**
   * Why a value is what it is here: the statement that last wrote it (found by where the value lives, not by its
   * name), the values its operands had then and why, and the IF/CASE branch that made it run. `depth` levels.
   * The debugger's own position does not change.
   */
  async why(target: string, frame = 0, depth = 3): Promise<WhyNode> {
    const f = this.frame(frame);
    let text = target.trim();
    let ref = this.refOf(text);
    if (!ref || this.sim!.where(ref, f) === undefined) {
      const local = /^[A-Za-z_]/.test(text) ? this.refOf(`#${text}`) : undefined;
      if (local && this.sim!.where(local, f)) {
        ref = local;
        text = `#${text}`;
      }
    }
    if (!ref) throw new Error(`${target} is not a variable`);
    if (ref.root.kind === "ident" && f.block.vars.some((v) => v.name.toUpperCase() === ref!.root.name.toUpperCase())) text = `#${text}`;
    const value = this.evaluate(text, frame).value;
    return this.explain(ref, text, value, this.stack.length - 1 - frame, this.at, depth);
  }

  /** The frames stopped in, innermost first, as `frames` of the stopped state. */
  frames(): DebugFrame[] {
    const out: DebugFrame[] = [];
    const top = this.trace[this.at]!;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.stack[i]!;
      // a caller stands at the statement that called the next frame
      const e = i === this.stack.length - 1 ? top : this.callerEntry(i + 1);
      out.push({ name: this.frameName(f, this.stack[i - 1]), uri: e?.uri ?? "", line: e?.line ?? 0, column: e?.column ?? 1 });
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
      out.push(this.variable(v.name, holder[key], v, `#${v.name}`));
    }
    // a FUNCTION's result lives under its own name
    const ret = f.block.name.toUpperCase();
    if (!seen.has(ret) && f.temps[ret] !== undefined) out.push(this.variable(f.block.name, f.temps[ret], f.block.returnType ? { type: f.block.returnType } : undefined, f.block.name));
    return out;
  }

  /** The data blocks and tags the run has touched. */
  globals(): DebugVariable[] {
    return Object.entries(this.sim?.globals ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        const g = this.index.global(k);
        const name = g?.name ?? k;
        const decl: Decl | undefined = g?.kind === "DB" ? { type: g.block?.dbOf ?? name, typeRef: g.block?.dbOf ?? name } : g?.tag ? { type: g.tag.dataType } : undefined;
        return this.variable(name, v, decl, `"${name}"`);
      });
  }

  // ------------------------------------------------------------------ internals

  private refOf(text: string): LRef | undefined {
    try {
      const [s] = parseBody(`${text} := 0;`);
      return s?.k === "assign" ? s.target : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Runs the case to statement `pos` (not running it) without moving the debugger, calling `seen` for every
   * statement before it; answers the simulator and its frames there.
   */
  private async replay(pos: number, seen?: (n: number, s: Stmt, f: Frame, sim: Simulator) => void): Promise<{ sim: Simulator; frames: Frame[] } | undefined> {
    let n = 0;
    let at: { sim: Simulator; frames: Frame[] } | undefined;
    await runTestFile(this.index, this.file, this.text, this.caseIndex, {
      simulator: (sim) => {
        sim.onStatement = (s, f) => {
          if (at) throw new Pause();
          n++;
          for (const x of this.sets) if (x.at === n) this.applySet(sim, x);
          if (n === pos) {
            at = { sim, frames: [...sim.frames] };
            throw new Pause();
          }
          seen?.(n, s, f, sim);
        };
      },
    });
    return at;
  }

  private async explain(ref: LRef, text: string, value: string, frameAt: number, pos: number, depth: number): Promise<WhyNode> {
    const node: WhyNode = { kind: "value", text, value, children: [] };
    // every write before here, by where it went; the place of the value asked about is found in the same run
    const writes: { n: number; place: { obj: unknown; key: string | number }; s: Stmt; f: Frame; frame: number; loc?: { uri: string; line: number }; time: number }[] = [];
    const runs = new Map<number, number[]>(); // when each statement ran, by where it starts (each run parses anew)
    // the value's own place, then each structure that holds it (a copy of the whole structure writes it too)
    let places: { obj: unknown; key: string | number; whole?: string }[] = [];
    const r = await this.replay(pos, (n, s, f, sim) => {
      let list = runs.get(s.at);
      if (!list) runs.set(s.at, (list = []));
      list.push(n);
      const targets: LRef[] = s.k === "assign" ? [s.target] : s.k === "for" ? [s.v] : s.k === "call" ? s.call.args.filter((a) => a.out && a.value.k === "ref").map((a) => (a.value as Extract<Expr, { k: "ref" }>).ref) : [];
      for (const t of targets) {
        const p = sim.where(t, f);
        if (p) writes.push({ n, place: p, s, f, frame: sim.frames.indexOf(f), time: sim.time, ...(sim.locationOf(f, s.at) ? { loc: sim.locationOf(f, s.at)! } : {}) });
      }
    });
    if (r) {
      for (let k = ref.path.length; k >= 0; k--) {
        const prefix: LRef = { ...ref, path: ref.path.slice(0, k) };
        if (k < ref.path.length && "slice" in (ref.path[k] ?? {})) continue;
        const p = r.sim.where(prefix, r.frames[frameAt] ?? null);
        if (p) places.push({ ...p, ...(k < ref.path.length ? { whole: refText(prefix) } : {}) });
      }
    }
    let whole: string | undefined;
    const w = [...writes].reverse().find((x) => {
      const hit = places.find((p) => x.place.obj === p.obj && x.place.key === p.key);
      if (hit) whole = hit.whole;
      return !!hit;
    });
    if (!w) {
      node.children.push({ kind: "note", text: "not written by the code before this point: an input the test sets, its start value, or written inside a call (a timer's Q, an FB's output)", children: [] });
      return node;
    }
    const write: WhyNode = { kind: "write", text: (this.lineText(w.loc) ?? text) + (whole ? `   (all of ${whole})` : ""), ...(w.loc ? { at: { ...w.loc, time: w.time } } : {}), children: [] };
    node.children.push(write);
    // the operands as they were just before that statement ran, and why
    const before = await this.replay(w.n);
    const f = before?.frames[w.frame];
    if (before && f) {
      const exprs: Expr[] = w.s.k === "assign" ? [w.s.value] : w.s.k === "for" ? [w.s.from, w.s.to, ...(w.s.by ? [w.s.by] : [])] : w.s.k === "call" ? w.s.call.args.filter((a) => !a.out).map((a) => a.value) : [];
      const operands = new Map<string, LRef>();
      for (const e of exprs) for (const o of refsOf(e)) operands.set(refText(o), o);
      for (const [label, o] of operands) {
        const v = this.shownValue(before.sim, o, f, label);
        write.children.push(depth > 1 && v !== undefined ? await this.explain(o, label, v, w.frame, w.n, depth - 1) : { kind: "value", text: label, value: v ?? "—", children: [] });
      }
      // the branch that made it run: each enclosing IF/CASE, evaluated where it ran last
      const parents = new Map([...before.sim.parentsOf(f.block)].map(([s, p]) => [s.at, p]));
      for (let p = parents.get(w.s.at); p; p = parents.get(p.parent.at)) {
        const ran = runs.get(p.parent.at)?.filter((x) => x < w.n).pop(); // the run that led to the write
        const cond = p.parent.k === "if" && p.branch >= 0 ? p.parent.branches[p.branch]!.cond : p.parent.k === "case" || p.parent.k === "while" ? (p.parent.k === "case" ? p.parent.sel : p.parent.cond) : undefined;
        const loc = before.sim.locationOf(f, p.parent.at);
        const why: WhyNode = { kind: "condition", text: this.lineText(loc) ?? p.parent.k.toUpperCase(), children: [] };
        if (p.parent.k === "if" && p.branch < 0) why.value = "ELSE: every condition before was FALSE";
        if (cond && ran !== undefined) {
          const at = await this.replay(ran);
          const fr = at?.frames[w.frame];
          if (at && fr) {
            try {
              why.value = this.format(at.sim.eval(cond, fr));
            } catch {
              /* not evaluable there */
            }
            for (const o of new Map([...refsOf(cond)].map((x) => [refText(x), x]))) {
              const v = this.shownValue(at.sim, o[1], fr, o[0]);
              why.children.push({ kind: "value", text: o[0], value: v ?? "—", children: [] });
            }
          }
        }
        write.children.push(why);
      }
    }
    return node;
  }

  private shownValue(sim: Simulator, ref: LRef, f: Frame, label: string): string | undefined {
    try {
      return this.variable(label, sim.read(ref, f), this.declOf(label, f), undefined).value;
    } catch {
      return undefined;
    }
  }

  private format(v: Value): string {
    return this.variable("", v, undefined, undefined).value;
  }

  /** The source line a statement starts on, trimmed. */
  private lineText(loc: { uri: string; line: number } | undefined): string | undefined {
    if (!loc) return undefined;
    const doc = [...this.index.docs.values()].find((d) => sameUri(d.uri, loc.uri));
    return doc?.text.split(/\r?\n/)[loc.line - 1]?.trim();
  }

  private depth(): number {
    return this.trace[this.at]?.depth ?? 1;
  }

  private frame(i: number): Frame {
    const f = this.stack[this.stack.length - 1 - i];
    if (!f || !this.sim) throw new Error("not stopped in a frame");
    return f;
  }

  /** A block's name, and for an FB the instance it runs on (`a : FB_Inner`), found in its caller or as a DB. */
  private frameName(f: Frame, caller: Frame | undefined): string {
    const own = f.inst && f.inst.__fb.toUpperCase() !== f.block.name.toUpperCase() ? `${f.inst.__fb}.${f.block.name}` : f.block.name;
    if (!f.inst || !caller) return own;
    for (const holder of [caller.mem, caller.temps]) {
      const key = Object.keys(holder).find((k) => holder[k] === f.inst);
      if (key) return `${caller.block.vars.find((v) => v.name.toUpperCase() === key)?.name ?? key} : ${own}`;
    }
    const db = Object.keys(this.sim?.globals ?? {}).find((k) => this.sim!.globals[k] === f.inst);
    return db ? `"${this.index.global(db)?.name ?? db}" : ${own}` : own;
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

  /** A condition that cannot be evaluated stops, and says why. */
  private truthy(condition: string, frame: number): boolean {
    try {
      return !!this.evaluateRaw(condition, frame);
    } catch (e) {
      this.note = `breakpoint condition ${condition}: ${message(e).message}`;
      return true;
    }
  }

  private evaluateRaw(condition: string, frame: number): Value {
    const run = this.sim!.onStatement;
    this.sim!.onStatement = undefined; // a condition that calls a block runs no counted statements
    try {
      const [s] = parseBody(`#__rung := ${condition};`);
      if (s?.k !== "assign") throw new SimError("not an expression");
      try {
        return this.sim!.eval(s.value, this.frame(frame));
      } catch (e) {
        if (!/^[A-Za-z_]/.test(condition.trim())) throw e;
        const [b] = parseBody(`#__rung := #${condition.trim()};`);
        if (b?.k !== "assign") throw e;
        try {
          return this.sim!.eval(b.value, this.frame(frame));
        } catch {
          throw e;
        }
      }
    } finally {
      this.sim!.onStatement = run;
    }
  }

  /** The declaration of a name path in a frame (`#Pump.Speed`, `"Plant".Count`, `#Grid[1,2]`), when it can be told. */
  private declOf(target: string, f: Frame): Decl | undefined {
    const m = /^(#?)(?:"([^"]+)"|([A-Za-z_]\w*))((?:\.[A-Za-z_]\w*|\[[^\]]*\])*)$/.exec(target.trim());
    if (!m) return undefined;
    const root = (m[2] ?? m[3])!;
    let decl: Decl | undefined;
    if (m[1] || m[3]) {
      const v = f.block.vars.find((x) => x.name.toUpperCase() === root.toUpperCase());
      decl = v ?? (f.block.name.toUpperCase() === root.toUpperCase() && f.block.returnType ? { type: f.block.returnType } : undefined);
    }
    if (!decl && !m[1]) {
      const g = this.index.global(root);
      decl = g?.kind === "DB" ? { type: g.block?.dbOf ?? g.name, typeRef: g.block?.dbOf ?? g.name } : g?.tag ? { type: g.tag.dataType } : undefined;
    }
    for (const seg of m[4]!.match(/\.[A-Za-z_]\w*|\[[^\]]*\]/g) ?? []) {
      if (!decl) return undefined;
      if (seg.startsWith("[")) {
        const a = splitArrayType(decl.type);
        decl = a ? { type: a.element, typeRef: a.element.replace(/^"|"$/g, "") } : undefined;
      } else decl = this.membersOf(decl)?.find((x) => x.name.toUpperCase() === seg.slice(1).toUpperCase());
    }
    return decl;
  }

  /** The members a structured declaration has: its own STRUCT, a PLC data type's, an FB's, a standard FB's. */
  private membersOf(decl: Decl | undefined, fb?: string): (Decl & { name: string })[] | undefined {
    if (decl?.members) return decl.members;
    const name = (decl?.typeRef ?? fb)?.replace(/^"|"$/g, "");
    if (!name) return undefined;
    const g = this.index.global(name);
    if (g?.block) {
      const b = g.kind === "DB" && g.block.dbOf ? this.index.global(g.block.dbOf)?.block : g.block;
      return b?.vars.filter((v) => !["Temp", "Constant"].includes(v.section));
    }
    const std = STANDARD_BY_NAME.get(name.toUpperCase());
    return std?.params.map((p) => ({ name: p.name, type: p.type }));
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
    let v: Value;
    let current: Value;
    try {
      v = this.sim!.eval(s.value, f);
      current = this.sim!.read(s.target, f);
    } catch (e) {
      throw message(e);
    }
    // what a test's set: would refuse is refused here too: a whole structure, a value its type cannot hold
    if (current && typeof current === "object" && !("__ptr" in current)) throw new Error(`${target} is ${isArray(current) ? "an array: set its elements" : "a structure: set its members"}`);
    try {
      const decl = this.declOf(target, f);
      if (decl && !/^ARRAY|^STRUCT/i.test(decl.type)) checkType(target, decl.type, v);
      else checkKind(target, current, v);
      this.sim!.write(s.target, v, f);
    } catch (e) {
      throw message(e);
    }
  }

  private goto(m: number, reason: StopReason): Promise<DebugState> {
    return this.run((n) => n === m, reason);
  }

  /** Runs the case until `stop` says so; `beforeStep`: stops instead after the cycles before that test step (a failed expectation). */
  private async run(stop: (n: number, e: Entry, f: Frame) => boolean, reason: StopReason, beforeStep?: number): Promise<DebugState> {
    let n = 0;
    let paused = false;
    let step = 0;
    let top: Frame | undefined;
    let lastTop = 0;
    const from = this.at;
    const trace: Entry[] = [];
    this.note = undefined;
    const r = await runTestFile(this.index, this.file, this.text, this.caseIndex, {
      step: (i) => {
        step = i;
        // the values the failed expectation saw: after the last statement of the tested block before its step
        if (beforeStep !== undefined && i === beforeStep && top && lastTop > from) {
          paused = true;
          this.at = lastTop;
          this.stack = [top];
          throw new Pause();
        }
      },
      simulator: (sim) => {
        this.sim = sim;
        sim.onStatement = (s, f) => {
          if (paused) throw new Pause(); // swallowed somewhere (a property read): stop again
          n++;
          const loc = sim.locationOf(f, s.at);
          const e: Entry = { depth: sim.frames.length, step, time: sim.time, ...loc };
          trace[n] = e;
          if (e.depth === 1 && loc) {
            top = f;
            lastTop = n;
          }
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
    if (paused) {
      const text = this.note;
      return { kind: "stopped", reason, frames: this.frames(), time: this.sim!.time, ...(text ? { text } : {}) };
    }
    const result = r.cases[0];
    const failure = result?.failures[0];
    if (failure && beforeStep === undefined) {
      // a failed expectation stops once, on the way there, where its values are
      const s = await this.run(() => false, "exception", failure.step);
      if (s.kind === "stopped") return { ...s, text: `step ${failure.step}: ${failure.name} expected ${shown(failure.expected)}, got ${shown(failure.actual)}${failure.note ? ` (${failure.note})` : ""}` };
      return s;
    }
    if (!failure && result?.error && result.errorStep !== undefined) {
      // an error stops at the statement it came from
      let m = n;
      while (m > 0 && (!trace[m]?.uri || trace[m]!.step > result.errorStep)) m--;
      if (m > from) {
        const s = await this.goto(m, "exception");
        return s.kind === "stopped" ? { ...s, text: `step ${result.errorStep}: ${result.error}` } : s;
      }
    }
    this.at = n + 1;
    this.stack = [];
    const stoppable = trace.some((e) => e?.uri);
    return {
      kind: "ended",
      result,
      ...(r.error ? { error: r.error } : {}),
      ...(!stoppable && !r.error && !result?.error ? { note: "This case ran no SCL statement the debugger can stop at (LAD, FBD and STL run without stopping)." } : {}),
    };
  }

  private applySet(sim: Simulator, x: { frame: number; target: string; value: string }) {
    const f = sim.frames[sim.frames.length - 1 - x.frame];
    const [s] = parseBody(`${x.target} := ${x.value};`);
    if (f && s?.k === "assign") sim.write(s.target, sim.eval(s.value, f), f);
  }

  /**
   * A value as the editor shows it: TIME as T#…ms, REAL without float32 noise, members with their declared names
   * and types; a multi-dimensional array's elements as `grid[1,2]`.
   */
  private variable(name: string, v: Value, decl: Decl | undefined, evaluateName: string | undefined, rows?: { dims: number; element?: Decl; prefix: number[]; base?: string }): DebugVariable {
    const type = decl?.type;
    const base = { name, ...(type ? { type } : {}), ...(evaluateName ? { evaluateName } : {}) };
    if (v === undefined) return { ...base, value: "—" };
    if (typeof v === "boolean") return { ...base, value: v ? "TRUE" : "FALSE" };
    if (typeof v === "number") {
      if (/^L?TIME$/i.test(type ?? "")) return { ...base, value: `T#${v}ms` };
      if (/^LREAL$/i.test(type ?? "") || Number.isInteger(v)) return { ...base, value: String(v) };
      return { ...base, value: realText(v) };
    }
    if (typeof v === "string") return { ...base, value: `'${v}'` };
    if ("__ptr" in v) {
      const p = (v as Pointer).__ptr;
      const target = (p.obj as Record<string | number, Value>)[p.key];
      return { ...this.variable(name, target, decl, evaluateName), name };
    }
    if (isArray(v)) {
      const a = v;
      const hi = a.lo + a.items.length - 1;
      const split = !rows && type ? splitArrayType(type) : undefined;
      const r = rows ?? { dims: split?.dims.length ?? 1, element: split ? { type: split.element, typeRef: split.element.replace(/^"|"$/g, "") } : undefined, prefix: [], base: evaluateName };
      return {
        ...base,
        value: !rows && type ? type : `ARRAY[${a.lo}..${hi}]`,
        children: () =>
          a.items.map((x, i) => {
            const idx = [...r.prefix, a.lo + i];
            // a row of a multi-dimensional array: SCL names its elements [i,j], not [i][j]
            if (idx.length < r.dims && isArray(x)) return this.variable(`[${idx.join(",")}]`, x, undefined, undefined, { ...r, prefix: idx });
            return this.variable(`[${a.lo + i}]`, x, r.element, r.base && `${r.base}[${idx.join(",")}]`);
          }),
      };
    }
    const inst = "__fb" in v ? (v as Instance) : undefined;
    const mem: Struct = inst ? inst.mem : (v as Struct);
    const declared = this.membersOf(decl, inst?.__fb);
    const members = Object.entries(mem).filter(([k]) => !k.startsWith("__"));
    return {
      ...base,
      value: inst ? inst.__fb : decl?.typeRef ? `"${decl.typeRef}"` : `{${members.length}}`,
      children: () =>
        members.map(([k, x]) => {
          const d = declared?.find((m) => m.name.toUpperCase() === k);
          const label = d?.name ?? k;
          return this.variable(label, x, d, evaluateName && `${evaluateName}.${label}`);
        }),
    };
  }
}

/** The variables an expression reads (call arguments too), as written. */
function* refsOf(e: Expr): Generator<LRef> {
  if (e.k === "ref") yield e.ref;
  else if (e.k === "un") yield* refsOf(e.e);
  else if (e.k === "bin") {
    yield* refsOf(e.l);
    yield* refsOf(e.r);
  } else if (e.k === "call") for (const a of e.args) yield* refsOf(a.value);
}

/** A reference as SCL writes it: #a.b[1], "DB".x. */
function refText(r: LRef): string {
  const root = r.root.kind === "local" ? `#${r.root.name}` : r.root.kind === "global" ? `"${r.root.name}"` : r.root.name;
  return root + r.path.map((p) => ("member" in p ? `.${p.member}` : "index" in p ? `[${p.index.map((x) => (x.k === "lit" ? String(x.value) : x.k === "ref" ? refText(x.ref) : "…")).join(",")}]` : "slice" in p ? `.%${p.slice}${p.n}` : "^")).join("");
}

const shown = (v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? realText(v) : JSON.stringify(v));

function message(e: unknown): Error {
  if (e instanceof SclSyntaxError || e instanceof SimError) return new Error(e.message);
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Where a breakpoint on `line` stops: that line when a statement starts there, else the next statement line of the
 * same block; none outside code the simulator runs (declarations of a block without code, a DB, LAD/FBD).
 */
export function breakpointLine(index: WorkspaceIndex, uri: string, line: number): number | undefined {
  const doc = [...index.docs.values()].find((d) => sameUri(d.uri, uri));
  if (!doc) return undefined;
  const sim = new Simulator(index);
  for (const b of doc.parsed?.blocks ?? []) {
    if (b.lad !== undefined || b.kind === "DB") continue;
    const first = doc.lines.position(b.start).line + 1;
    const last = doc.lines.position(b.end).line + 1;
    if (line < first || line > last) continue;
    // declarations stop nowhere: only lines of the code moves on to the next statement
    if (b.bodyStart === undefined || line <= doc.lines.position(b.bodyStart).line) return undefined;
    const lines = sim
      .statementsOf(b)
      .filter((s) => s.k !== "label" && s.k !== "empty")
      .map((s) => doc.lines.position(s.at).line + 1)
      .filter((l) => l >= line)
      .sort((x, y) => x - y);
    return lines[0];
  }
  return undefined;
}