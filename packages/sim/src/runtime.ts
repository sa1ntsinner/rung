// SPDX-License-Identifier: BUSL-1.1
// Offline SCL simulator: executes FB/FC bodies with virtual time for unit tests.
// It models SCL semantics closely enough for logic tests; it is not a bit-exact TIA/PLCSIM emulation
// (no integer overflow wrap-around, no system instructions beyond the IEC standard set).
import { STANDARD_BY_NAME, type BlockModel, type VarDecl, type WorkspaceIndex } from "@rung/lsp";
import { parseBody, SclSyntaxError, type Expr, type LRef, type Stmt } from "./ast.js";

export type Value = boolean | number | string | Struct | ArrayValue | Instance | undefined;
export interface Struct {
  [upperName: string]: Value;
}
export interface ArrayValue {
  __array: true;
  lo: number;
  items: Value[];
}
export interface Instance {
  __fb: string;
  mem: Struct;
  /** Native state for standard FBs (TON, CTU, ...). */
  std?: Record<string, number | boolean>;
}

export class SimError extends Error {
  constructor(
    message: string,
    public readonly block?: string,
    public readonly offset?: number,
  ) {
    super(message);
  }
}

const INT_TYPES = /^(SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|BYTE|WORD|DWORD|LWORD)$/i;
const REAL_TYPES = /^(REAL|LREAL)$/i;
const TIME_TYPES = /^(TIME|LTIME|S5TIME)$/i;
const STRING_TYPES = /^(STRING|WSTRING|CHAR|WCHAR)$/i;
const isArray = (v: Value): v is ArrayValue => typeof v === "object" && v !== null && (v as ArrayValue).__array === true;
const isInstance = (v: Value): v is Instance => typeof v === "object" && v !== null && typeof (v as Instance).__fb === "string";

interface Frame {
  block: BlockModel;
  /** Instance memory (FB) or call memory (FC). */
  mem: Struct;
  temps: Struct;
}

class Exit {}
class Continue {}
class Return {}

export class Simulator {
  /** Virtual time in milliseconds. */
  time = 0;
  readonly globals: Struct = {};
  private readonly bodies = new Map<string, Stmt[]>();
  private steps = 0;

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly maxStepsPerCall = 1_000_000,
  ) {}

  private block(name: string): BlockModel {
    const g = this.index.global(name);
    if (!g?.block) throw new SimError(`Block "${name}" is not in the workspace (only SCL sources can be simulated)`);
    return g.block;
  }

  private body(b: BlockModel): Stmt[] {
    const key = b.name.toUpperCase();
    let s = this.bodies.get(key);
    if (!s) {
      const g = this.index.global(b.name)!;
      const src = this.index.docs.get(g.uri)!.text;
      try {
        s = b.bodyStart === undefined ? [] : parseBody(src, b.bodyStart, b.end);
      } catch (e) {
        if (e instanceof SclSyntaxError) throw new SimError(`Syntax error in ${b.name}: ${e.message}`, b.name, e.offset);
        throw e;
      }
      this.bodies.set(key, s);
    }
    return s;
  }

  // ------------------------------------------------------------------ values

  defaultValue(decl: Pick<VarDecl, "type" | "typeRef" | "isArray" | "members" | "init">): Value {
    if (decl.isArray) {
      const dims = [...decl.type.matchAll(/(-?\d+)\s*\.\.\s*(-?\d+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
      const inner = { ...decl, isArray: false, type: decl.type.replace(/^.*\bof\b\s*/i, "") };
      const build = (d: number): Value => {
        const dim = dims[d];
        if (!dim) return this.defaultValue(inner);
        return { __array: true, lo: dim[0], items: Array.from({ length: dim[1] - dim[0] + 1 }, () => build(d + 1)) };
      };
      return build(0);
    }
    if (decl.members?.length) return this.structOf(decl.members);
    let v: Value;
    const t = decl.typeRef ?? decl.type;
    if (/^BOOL$/i.test(t)) v = false;
    else if (INT_TYPES.test(t) || REAL_TYPES.test(t) || TIME_TYPES.test(t)) v = 0;
    else if (STRING_TYPES.test(t.replace(/\[.*$/, ""))) v = "";
    else {
      const g = this.index.global(t);
      if (g?.block?.kind === "UDT") v = this.structOf(g.block.vars);
      else if (g?.block?.kind === "FB") v = this.newInstance(g.block.name);
      else if (STANDARD_BY_NAME.get(t.toUpperCase())?.kind === "functionBlock") v = this.newInstance(t);
      else v = 0; // unknown elementary type (DTL, Variant, …): treated as a number
    }
    if (decl.init !== undefined && !isInstance(v) && typeof v !== "object") {
      try {
        const [s] = parseBody(`#__init := ${decl.init};`);
        if (s?.k === "assign") v = this.eval(s.value, null);
      } catch {
        /* complex initializers (array lists) keep the default */
      }
    }
    return v;
  }

  private structOf(vars: VarDecl[]): Struct {
    const s: Struct = {};
    for (const m of vars) s[m.name.toUpperCase()] = this.defaultValue(m);
    return s;
  }

  newInstance(fbName: string): Instance {
    const std = STANDARD_BY_NAME.get(fbName.toUpperCase());
    if (std?.kind === "functionBlock") {
      const mem: Struct = {};
      for (const p of std.params) mem[p.name.toUpperCase()] = /Bool/i.test(p.type) ? false : 0;
      return { __fb: std.name, mem, std: {} };
    }
    const b = this.block(fbName);
    if (b.kind !== "FB") throw new SimError(`"${fbName}" is ${b.kind}, not a function block`);
    return { __fb: b.name, mem: this.structOf(b.vars.filter((v) => v.section !== "Temp" && v.section !== "Constant")) };
  }

  /** Global DB memory or tag value, created on first use from the workspace. */
  private global(name: string): { obj: Struct; key: string } {
    const key = name.toUpperCase();
    if (!(key in this.globals)) {
      const g = this.index.global(name);
      if (g?.block?.kind === "DB") this.globals[key] = g.block.dbOf ? this.newInstance(g.block.dbOf) : this.structOf(g.block.vars);
      else if (g?.tag) this.globals[key] = /^Bool$/i.test(g.tag.dataType) ? false : STRING_TYPES.test(g.tag.dataType) ? "" : 0;
      else throw new SimError(`"${name}" is not a data block or tag in the workspace`);
    }
    return { obj: this.globals, key };
  }

  // ------------------------------------------------------------------ references

  private locate(ref: LRef, frame: Frame | null): { obj: Struct | Value[]; key: string | number } {
    let obj: Struct | Value[];
    let key: string | number;
    const root = ref.root.name.toUpperCase();
    if (ref.root.kind === "global") ({ obj, key } = this.global(ref.root.name));
    else {
      if (!frame) throw new SimError(`#${ref.root.name} used outside a block`);
      if (root in frame.temps) obj = frame.temps;
      else if (root in frame.mem) obj = frame.mem;
      else if (root === frame.block.name.toUpperCase()) obj = frame.temps; // FC return value
      else if (ref.root.kind === "ident" && frame.block.kind === "DB") obj = frame.mem;
      else throw new SimError(`#${ref.root.name} is not declared in ${frame.block.name}`, frame.block.name, ref.start);
      key = root;
    }
    for (const seg of ref.path) {
      let cur = (obj as Struct)[key as string] ?? (obj as Value[])[key as number];
      if (isInstance(cur)) cur = cur.mem;
      if ("member" in seg) {
        if (typeof cur !== "object" || cur === null || isArray(cur)) throw new SimError(`${seg.member}: not a structure`, frame?.block.name, ref.start);
        obj = cur as Struct;
        key = seg.member.toUpperCase();
        if (!(key in obj)) throw new SimError(`${seg.member} is not a member`, frame?.block.name, ref.start);
      } else {
        for (let d = 0; d < seg.index.length; d++) {
          const arr = d === 0 ? cur : (obj as Value[])[key as number];
          if (!isArray(arr as Value)) throw new SimError("indexing a value that is not an array", frame?.block.name, ref.start);
          const a = arr as ArrayValue;
          const idx = Number(this.eval(seg.index[d]!, frame));
          if (!Number.isInteger(idx) || idx < a.lo || idx >= a.lo + a.items.length) throw new SimError(`array index ${idx} out of range ${a.lo}..${a.lo + a.items.length - 1}`, frame?.block.name, ref.start);
          obj = a.items;
          key = idx - a.lo;
        }
      }
    }
    return { obj, key };
  }

  read(ref: LRef, frame: Frame | null): Value {
    const { obj, key } = this.locate(ref, frame);
    return (obj as Struct)[key as string] ?? (obj as Value[])[key as number];
  }

  write(ref: LRef, value: Value, frame: Frame | null) {
    const { obj, key } = this.locate(ref, frame);
    (obj as Record<string | number, Value>)[key] = value;
  }

  // ------------------------------------------------------------------ expressions

  private isReal(e: Expr, frame: Frame | null): boolean {
    if (e.k === "lit") return e.type === "real";
    if (e.k === "un") return this.isReal(e.e, frame);
    if (e.k === "bin") return this.isReal(e.l, frame) || this.isReal(e.r, frame);
    if (e.k === "ref" && frame && e.ref.path.length === 0) {
      const d = frame.block.vars.find((v) => v.name.toUpperCase() === e.ref.root.name.toUpperCase());
      return !!d && REAL_TYPES.test(d.typeRef ?? "");
    }
    return false;
  }

  eval(e: Expr, frame: Frame | null): Value {
    switch (e.k) {
      case "lit":
        return e.value;
      case "ref":
        return this.read(e.ref, frame);
      case "un": {
        const v = this.eval(e.e, frame);
        return e.op === "NOT" ? (typeof v === "number" ? ~v : !v) : e.op === "-" ? -Number(v) : Number(v);
      }
      case "bin": {
        const l = this.eval(e.l, frame);
        if (e.op === "AND" || e.op === "&") {
          const r = this.eval(e.r, frame);
          return typeof l === "number" ? (l as number) & (r as number) : !!l && !!r;
        }
        if (e.op === "OR") {
          const r = this.eval(e.r, frame);
          return typeof l === "number" ? (l as number) | (r as number) : !!l || !!r;
        }
        const r = this.eval(e.r, frame);
        switch (e.op) {
          case "XOR":
            return typeof l === "number" ? (l as number) ^ (r as number) : !!l !== !!r;
          case "=":
            return l === r;
          case "<>":
            return l !== r;
          case "<":
            return (l as number) < (r as number);
          case ">":
            return (l as number) > (r as number);
          case "<=":
            return (l as number) <= (r as number);
          case ">=":
            return (l as number) >= (r as number);
          case "+":
            return typeof l === "string" ? l + String(r) : (l as number) + (r as number);
          case "-":
            return (l as number) - (r as number);
          case "*":
            return (l as number) * (r as number);
          case "**":
            return Math.pow(l as number, r as number);
          case "MOD":
            if (r === 0) throw new SimError("MOD by zero", frame?.block.name);
            return (l as number) % (r as number);
          case "/": {
            if (r === 0) throw new SimError("division by zero", frame?.block.name);
            const q = (l as number) / (r as number);
            return this.isReal(e.l, frame) || this.isReal(e.r, frame) ? q : Math.trunc(q);
          }
        }
        throw new SimError(`operator ${e.op} not supported`);
      }
      case "call":
        return this.call(e, frame);
    }
  }

  // ------------------------------------------------------------------ calls

  private call(c: Extract<Expr, { k: "call" }>, frame: Frame | null): Value {
    const name = c.callee.root.name;
    const upper = name.toUpperCase();
    // FB instance call: #inst(...), "Inst_DB"(...), #inst.sub(...)
    if (c.callee.root.kind !== "ident" || c.callee.path.length) {
      const target = c.callee.root.kind === "global" && !c.callee.path.length ? this.index.global(name) : undefined;
      if (target?.block?.kind === "FC") return this.callFc(target.block, c, frame);
      const inst = this.read(c.callee, frame);
      if (!isInstance(inst)) throw new SimError(`${name} is not a function block instance`, frame?.block.name, c.callee.start);
      this.runInstance(inst, c.args, frame);
      return undefined;
    }
    const std = STANDARD_BY_NAME.get(upper);
    const args = c.args.map((a) => this.eval(a.value, frame));
    const named = (n: string, i: number) => {
      const a = c.args.findIndex((x) => x.name?.toUpperCase() === n);
      return a >= 0 ? this.eval(c.args[a]!.value, frame) : args[i];
    };
    if (std?.kind === "function" || /_TO_/.test(upper)) {
      const n = (x: Value) => Number(x);
      switch (upper) {
        case "ABS":
          return Math.abs(n(args[0]));
        case "SQRT":
          return Math.sqrt(n(args[0]));
        case "SQR":
          return n(args[0]) ** 2;
        case "LN":
          return Math.log(n(args[0]));
        case "LOG":
          return Math.log10(n(args[0]));
        case "EXP":
          return Math.exp(n(args[0]));
        case "SIN":
          return Math.sin(n(args[0]));
        case "COS":
          return Math.cos(n(args[0]));
        case "TAN":
          return Math.tan(n(args[0]));
        case "ASIN":
          return Math.asin(n(args[0]));
        case "ACOS":
          return Math.acos(n(args[0]));
        case "ATAN":
          return Math.atan(n(args[0]));
        case "MIN":
          return Math.min(...args.map(n));
        case "MAX":
          return Math.max(...args.map(n));
        case "LIMIT":
          return Math.min(Math.max(n(named("IN", 1)), n(named("MN", 0))), n(named("MX", 2)));
        case "SEL":
          return named("G", 0) ? named("IN1", 2) : named("IN0", 1);
        case "MUX":
          return args[1 + n(named("K", 0))];
        case "TRUNC":
          return Math.trunc(n(args[0]));
        case "ROUND":
          return Math.round(n(args[0]));
        case "CEIL":
          return Math.ceil(n(args[0]));
        case "FLOOR":
          return Math.floor(n(args[0]));
        case "NORM_X":
          return (n(named("VALUE", 1)) - n(named("MIN", 0))) / (n(named("MAX", 2)) - n(named("MIN", 0)));
        case "SCALE_X":
          return n(named("VALUE", 1)) * (n(named("MAX", 2)) - n(named("MIN", 0))) + n(named("MIN", 0));
        case "LEN":
          return String(args[0]).length;
        case "CONCAT":
          return args.map(String).join("");
        case "LEFT":
          return String(named("IN", 0)).slice(0, n(named("L", 1)));
        case "RIGHT":
          return String(named("IN", 0)).slice(-n(named("L", 1)) || undefined);
        case "MID":
          return String(named("IN", 0)).substr(n(named("P", 2)) - 1, n(named("L", 1)));
        case "FIND":
          return String(named("IN1", 0)).indexOf(String(named("IN2", 1))) + 1;
        case "SHL":
          return n(args[0]) << n(args[1]);
        case "SHR":
          return n(args[0]) >>> n(args[1]);
      }
      const to = upper.split("_TO_")[1] ?? "";
      if (/^(BOOL)$/.test(to)) return !!args[0] && args[0] !== 0;
      if (REAL_TYPES.test(to)) return Number(args[0]);
      if (STRING_TYPES.test(to)) return String(args[0]);
      if (INT_TYPES.test(to) || TIME_TYPES.test(to)) return typeof args[0] === "boolean" ? (args[0] ? 1 : 0) : Math.round(Number(args[0]));
      throw new SimError(`function ${name} is not supported by the simulator`, frame?.block.name, c.callee.start);
    }
    const g = this.index.global(name);
    if (g?.block?.kind === "FC") return this.callFc(g.block, c, frame);
    throw new SimError(`${name} is not a known function (system instructions are not simulated)`, frame?.block.name, c.callee.start);
  }

  private callFc(b: BlockModel, c: Extract<Expr, { k: "call" }>, caller: Frame | null): Value {
    const mem: Struct = this.structOf(b.vars.filter((v) => v.section === "Input" || v.section === "Output" || v.section === "InOut"));
    const temps: Struct = this.structOf(b.vars.filter((v) => v.section === "Temp"));
    const consts = b.vars.filter((v) => v.section === "Constant");
    for (const k of consts) temps[k.name.toUpperCase()] = this.defaultValue(k);
    this.bindInputs(mem, b, c.args, caller);
    const frame: Frame = { block: b, mem, temps };
    temps[b.name.toUpperCase()] = b.returnType && !/^void$/i.test(b.returnType) ? this.defaultValue({ type: b.returnType, typeRef: b.returnType, isArray: false }) : undefined;
    this.exec(this.body(b), frame);
    this.bindOutputs(mem, b, c.args, caller);
    return temps[b.name.toUpperCase()];
  }

  private bindInputs(mem: Struct, b: BlockModel | null, args: { name?: string; out?: boolean; value: Expr }[], caller: Frame | null) {
    const params = b ? b.vars.filter((v) => v.section === "Input" || v.section === "InOut") : [];
    args.forEach((a, i) => {
      if (a.out) return;
      const key = (a.name ?? params[i]?.name)?.toUpperCase();
      if (!key) throw new SimError("positional argument without matching parameter", caller?.block.name);
      if (!(key in mem)) throw new SimError(`${a.name ?? key} is not an input of ${b?.name ?? "the block"}`, caller?.block.name);
      mem[key] = this.eval(a.value, caller);
    });
  }

  private bindOutputs(mem: Struct, b: BlockModel | null, args: { name?: string; out?: boolean; value: Expr }[], caller: Frame | null) {
    for (const a of args) {
      if (!a.name) continue;
      const key = a.name.toUpperCase();
      const isInOut = b?.vars.some((v) => v.section === "InOut" && v.name.toUpperCase() === key);
      if ((a.out || isInOut) && a.value.k === "ref") this.write(a.value.ref, mem[key], caller);
    }
  }

  /** Runs one call of an FB instance (user FB or standard FB). */
  runInstance(inst: Instance, args: { name?: string; out?: boolean; value: Expr }[] = [], caller: Frame | null = null) {
    if (inst.std) {
      this.bindInputs(inst.mem, null, args.map((a) => a), caller);
      this.stdStep(inst);
      this.bindOutputs(inst.mem, null, args, caller);
      return;
    }
    const b = this.block(inst.__fb);
    this.bindInputs(inst.mem, b, args, caller);
    const temps = this.structOf(b.vars.filter((v) => v.section === "Temp"));
    for (const k of b.vars.filter((v) => v.section === "Constant")) temps[k.name.toUpperCase()] = this.defaultValue(k);
    this.exec(this.body(b), { block: b, mem: inst.mem, temps });
    this.bindOutputs(inst.mem, b, args, caller);
  }

  private stdStep(inst: Instance) {
    const m = inst.mem;
    const s = inst.std!;
    const now = this.time;
    switch (inst.__fb.toUpperCase().replace(/_(L?TIME)$/, "")) {
      case "TON": {
        if (m.IN && !s.prev) s.start = now;
        if (m.IN) {
          m.ET = Math.min(now - (s.start as number), m.PT as number);
          m.Q = (m.ET as number) >= (m.PT as number);
        } else {
          m.ET = 0;
          m.Q = false;
        }
        s.prev = !!m.IN;
        break;
      }
      case "TOF": {
        if (m.IN) {
          m.Q = true;
          m.ET = 0;
          s.running = false;
        } else if (s.prev) {
          s.start = now;
          s.running = true;
        }
        if (!m.IN && s.running) {
          m.ET = Math.min(now - (s.start as number), m.PT as number);
          m.Q = (m.ET as number) < (m.PT as number);
          if (!m.Q) s.running = false;
        }
        s.prev = !!m.IN;
        break;
      }
      case "TP": {
        if (m.IN && !s.prev && !s.running) {
          s.start = now;
          s.running = true;
        }
        if (s.running) {
          m.ET = Math.min(now - (s.start as number), m.PT as number);
          if ((m.ET as number) >= (m.PT as number)) s.running = false;
        } else if (!m.IN) m.ET = 0;
        m.Q = !!s.running;
        s.prev = !!m.IN;
        break;
      }
      case "CTU":
        if (m.R) m.CV = 0;
        else if (m.CU && !s.prev) m.CV = (m.CV as number) + 1;
        m.Q = (m.CV as number) >= (m.PV as number);
        s.prev = !!m.CU;
        break;
      case "CTD":
        if (m.LD) m.CV = m.PV;
        else if (m.CD && !s.prev) m.CV = (m.CV as number) - 1;
        m.Q = (m.CV as number) <= 0;
        s.prev = !!m.CD;
        break;
      case "CTUD":
        if (m.R) m.CV = 0;
        else if (m.LD) m.CV = m.PV;
        else {
          if (m.CU && !s.prevU) m.CV = (m.CV as number) + 1;
          if (m.CD && !s.prevD) m.CV = (m.CV as number) - 1;
        }
        m.QU = (m.CV as number) >= (m.PV as number);
        m.QD = (m.CV as number) <= 0;
        s.prevU = !!m.CU;
        s.prevD = !!m.CD;
        break;
      case "R_TRIG":
        m.Q = !!m.CLK && !s.prev;
        s.prev = !!m.CLK;
        break;
      case "F_TRIG":
        m.Q = !m.CLK && !!s.prev;
        s.prev = !!m.CLK;
        break;
      case "SR":
        m.Q1 = !!m.S1 || (!m.R && !!m.Q1);
        break;
      case "RS":
        m.Q1 = !m.R1 && (!!m.S || !!m.Q1);
        break;
      default:
        throw new SimError(`${inst.__fb} is not simulated`);
    }
  }

  // ------------------------------------------------------------------ statements

  private exec(stmts: Stmt[], f: Frame) {
    for (const s of stmts) this.stmt(s, f);
  }

  private stmt(s: Stmt, f: Frame) {
    if (++this.steps > this.maxStepsPerCall) throw new SimError("step limit exceeded (endless loop?)", f.block.name, s.at);
    try {
      switch (s.k) {
        case "empty":
          return;
        case "assign":
          return this.write(s.target, this.eval(s.value, f), f);
        case "call":
          this.call(s.call, f);
          return;
        case "if": {
          for (const b of s.branches)
            if (this.eval(b.cond, f)) {
              this.exec(b.body, f);
              return;
            }
          if (s.else) this.exec(s.else, f);
          return;
        }
        case "case": {
          const v = this.eval(s.sel, f) as number;
          for (const item of s.items)
            for (const l of item.labels) {
              const lo = this.eval(l.lo, f) as number;
              const hi = l.hi ? (this.eval(l.hi, f) as number) : lo;
              if (v >= lo && v <= hi) {
                this.exec(item.body, f);
                return;
              }
            }
          if (s.else) this.exec(s.else, f);
          return;
        }
        case "for": {
          const by = s.by ? (this.eval(s.by, f) as number) : 1;
          const to = this.eval(s.to, f) as number;
          this.write(s.v, this.eval(s.from, f), f);
          while (by >= 0 ? (this.read(s.v, f) as number) <= to : (this.read(s.v, f) as number) >= to) {
            try {
              this.exec(s.body, f);
            } catch (e) {
              if (e instanceof Exit) break;
              if (!(e instanceof Continue)) throw e;
            }
            this.write(s.v, (this.read(s.v, f) as number) + by, f);
          }
          return;
        }
        case "while":
          while (this.eval(s.cond, f)) {
            try {
              this.exec(s.body, f);
            } catch (e) {
              if (e instanceof Exit) break;
              if (!(e instanceof Continue)) throw e;
            }
            if (++this.steps > this.maxStepsPerCall) throw new SimError("step limit exceeded (endless loop?)", f.block.name, s.at);
          }
          return;
        case "repeat":
          do {
            try {
              this.exec(s.body, f);
            } catch (e) {
              if (e instanceof Exit) break;
              if (!(e instanceof Continue)) throw e;
            }
            if (++this.steps > this.maxStepsPerCall) throw new SimError("step limit exceeded (endless loop?)", f.block.name, s.at);
          } while (!this.eval(s.until, f));
          return;
        case "exit":
          throw new Exit();
        case "continue":
          throw new Continue();
        case "return":
          throw new Return();
      }
    } catch (e) {
      if (e instanceof SimError && e.offset === undefined) throw new SimError(e.message, f.block.name, s.at);
      throw e;
    }
  }

  /** Top-level call of a block from a test: FB instance or FC with argument values. */
  callBlock(target: Instance | string, inputs: Record<string, Value> = {}): { returnValue?: Value; outputs: Struct } {
    this.steps = 0;
    const lit = (v: Value): Expr => ({ k: "lit", value: v as never, type: typeof v === "boolean" ? "bool" : typeof v === "string" ? "string" : "real" });
    const args = Object.entries(inputs).map(([name, value]) => ({ name, value: lit(value) }));
    try {
      if (typeof target === "string") {
        const b = this.block(target);
        const call = { k: "call" as const, callee: { root: { kind: "global" as const, name: b.name }, path: [], start: 0 }, args };
        const mem: Struct = {};
        const r = this.callFcCapture(b, call, mem);
        return { returnValue: r, outputs: mem };
      }
      this.runInstance(target, args);
      return { outputs: target.mem };
    } catch (e) {
      if (e instanceof Return) return { outputs: typeof target === "string" ? {} : target.mem };
      throw e;
    }
  }

  private callFcCapture(b: BlockModel, c: Extract<Expr, { k: "call" }>, capture: Struct): Value {
    const mem: Struct = this.structOf(b.vars.filter((v) => v.section === "Input" || v.section === "Output" || v.section === "InOut"));
    const temps: Struct = this.structOf(b.vars.filter((v) => v.section === "Temp"));
    this.bindInputs(mem, b, c.args, null);
    temps[b.name.toUpperCase()] = b.returnType && !/^void$/i.test(b.returnType) ? this.defaultValue({ type: b.returnType, typeRef: b.returnType, isArray: false }) : undefined;
    try {
      this.exec(this.body(b), { block: b, mem, temps });
    } catch (e) {
      if (!(e instanceof Return)) throw e;
    }
    Object.assign(capture, mem);
    return temps[b.name.toUpperCase()];
  }
}

/** Public helper: TIME text or number of ms. */
export function toMs(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(s);
  if (m) return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as Record<string, number>)[m[2]!.toLowerCase()]!;
  if (/^(T|TIME|LT|LTIME)#/i.test(s)) {
    return [...s.slice(s.indexOf("#") + 1).matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/gi)].reduce((acc, x) => acc + Number(x[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[x[2]!.toLowerCase()]!, 0);
  }
  throw new SimError(`not a duration: ${s}`);
}
