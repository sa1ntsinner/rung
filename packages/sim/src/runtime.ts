// SPDX-License-Identifier: BUSL-1.1
// Offline SCL simulator: executes FB/FC bodies with virtual time for unit tests.
// It models SCL semantics closely enough for logic tests; it is not a bit-exact TIA/PLCSIM emulation
// (integers wrap around like on an S7-1500; of the system instructions only those in system.ts).
import { STANDARD_BY_NAME, SYSTEM_TYPES, parseAbsolute, type BlockModel, type Member, type VarDecl, type WorkspaceIndex } from "@rung/lsp";
import { parseStl, runStl, stlState, type S5Timer, type StlCall, type StlHost, type StlProgram, type StlState } from "./stl.js";
import { parseBody, SclSyntaxError, type Arg, type Expr, type LRef, type Stmt } from "./ast.js";
import { CLOCK_START, Unsupported, deleteChars, dtlOf, insertChars, msOfDtl, replaceChars, swapBytes, timeDiff, timeKindOfType, timeShift, typeTag, valStrg, type TimeKind } from "./system.js";

export type Value = boolean | number | string | Struct | ArrayValue | Instance | Pointer | undefined;
/** ADR(x) (a POINTER TO), or with `ref` a bound REFERENCE TO: where the value lives. */
export interface Pointer {
  __ptr: { obj: Struct | Value[]; key: string | number };
  ref?: true;
  /** A VARIANT or ARRAY[*] parameter bound to the caller's variable, with that variable's declared type when known. */
  variant?: { decl?: Pick<VarDecl, "type" | "typeRef" | "isArray" | "members"> };
  /** The caller's variable by its root and path (indices fixed at the call), found again at each use. */
  via?: { ref: LRef; frame: object | null };
}
const isPointer = (v: Value): v is Pointer => typeof v === "object" && v !== null && "__ptr" in v;
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
  /** A stubbed type nobody describes (rung test stubs:): members come from the stub, the call arguments and the test. */
  stub?: true;
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
/** Nesting of FB/FC calls before the simulator reports endless recursion. */
const MAX_CALL_DEPTH = 100;

/** The system instructions the simulator runs (systemCall); docs/testing.md lists them. */
export const SYSTEM_FUNCTIONS = new Set([
  "SWAP", "RD_SYS_T", "RD_LOC_T", "RUNTIME", "T_DIFF", "T_ADD", "T_SUB", "IS_ARRAY", "COUNTOFELEMENTS", "LOWER_BOUND", "UPPER_BOUND",
  "MOVE_BLK", "UMOVE_BLK", "FILL_BLK", "UFILL_BLK", "VAL_STRG", "DELETE", "INSERT", "REPLACE",
  "TYPEOF", "TYPEOFELEMENTS", "VARIANTGET", "VARIANTPUT", "MOVE_BLK_VARIANT", "IS_NULL", "NOT_NULL",
]);
/** What an instruction outside that list is, for its message. */
const NOT_SIMULATED = "communication, motion, diagnostics, data logging and the other system instructions are not part of the offline simulator (docs/testing.md lists the ones it runs)";

/** A copy of a value, as the PLC copies one: a structure or array element by element (an FB instance is not copied). */
function copyValue(v: Value): Value {
  if (isArray(v)) return { __array: true, lo: v.lo, items: v.items.map(copyValue) };
  if (v && typeof v === "object" && !isInstance(v) && !isPointer(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copyValue(x as Value)]));
  return v;
}

type Decl = Pick<VarDecl, "type" | "typeRef" | "isArray" | "members" | "init">;
type Kind = "real" | "int" | "unknown";

interface Frame {
  block: BlockModel;
  /** Instance memory (FB) or call memory (FC). */
  mem: Struct;
  temps: Struct;
  /** The FB instance an FB body or one of its METHODs runs on (THIS). */
  inst?: Instance;
  /** The accessor of a PROPERTY that runs: its own locals, not the other accessor's. */
  accessor?: "get" | "set";
  stl?: { network: number; state: StlState };
}

class Exit {}
class Continue {}
class Return {}
class Goto {
  constructor(
    readonly label: string,
    readonly at: number,
  ) {}
}

/** Rounds to the nearest integer; exact halves go to the even neighbour (IEEE 754 round-to-nearest-even, as the S7 FPU and TIA's ROUND do). */
export function roundHalfEven(x: number): number {
  if (!Number.isFinite(x)) return x;
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** `Array[lo..hi, lo..hi] of <element>`: the dimension texts of the outermost array and the element type text. */
export function splitArrayType(type: string): { dims: string[]; element: string } | undefined {
  const m = /^\s*array\s*\[/i.exec(type);
  if (!m) return undefined;
  let depth = 0;
  let j = m[0].length - 1;
  for (; j < type.length; j++) {
    if (type[j] === "[") depth++;
    else if (type[j] === "]" && --depth === 0) break;
  }
  const inside = type.slice(m[0].length, j);
  const dims: string[] = [];
  let d = 0;
  let from = 0;
  for (let k = 0; k < inside.length; k++) {
    const c = inside[k];
    if (c === "[" || c === "(") d++;
    else if (c === "]" || c === ")") d--;
    else if (c === "," && d === 0) {
      dims.push(inside.slice(from, k));
      from = k + 1;
    }
  }
  dims.push(inside.slice(from));
  return { dims, element: type.slice(j + 1).replace(/^\s*of\b\s*/i, "").trim() };
}

const SLICE_WIDTH = { X: 1, B: 8, W: 16, D: 32 } as const;

function sliceGet(base: Value, s: { slice: keyof typeof SLICE_WIDTH; n: number }): Value {
  const width = BigInt(SLICE_WIDTH[s.slice]);
  const v = BigInt(typeof base === "boolean" ? (base ? 1 : 0) : Math.trunc(Number(base ?? 0)));
  const bits = (v >> (BigInt(s.n) * width)) & ((1n << width) - 1n);
  return s.slice === "X" ? bits === 1n : Number(bits);
}

/** `of`: the variable's own width, applied before the result must fit a double (an LInt with its top bit set is negative). */
function sliceSet(base: Value, s: { slice: keyof typeof SLICE_WIDTH; n: number }, value: Value, of?: [bits: number, signed: boolean]): number {
  const width = BigInt(SLICE_WIDTH[s.slice]);
  const shift = BigInt(s.n) * width;
  const mask = ((1n << width) - 1n) << shift;
  const v = BigInt(typeof base === "boolean" ? (base ? 1 : 0) : Math.trunc(Number(base ?? 0)));
  const nv = (BigInt(s.slice === "X" ? (value ? 1 : 0) : Math.trunc(Number(value ?? 0))) << shift) & mask;
  const r = (v & ~mask) | nv;
  return exactInteger(of ? (of[1] ? BigInt.asIntN(of[0], r) : BigInt.asUintN(of[0], r)) : r);
}

/** The declaration of what a POINTER TO / REFERENCE TO points at. */
function targetDecl(d: Decl, prefix: RegExp): Decl {
  const t = d.typeRef ?? d.type;
  if (!prefix.test(t) && !prefix.test(d.type)) return d;
  const inner = (d.type.replace(prefix, "") || t.replace(prefix, "")).trim();
  return { type: inner, typeRef: inner, isArray: /^array\b/i.test(inner) };
}

const INT_WIDTH: Record<string, [bits: number, signed: boolean]> = {
  SINT: [8, true], INT: [16, true], DINT: [32, true], LINT: [64, true],
  USINT: [8, false], UINT: [16, false], UDINT: [32, false], ULINT: [64, false],
  BYTE: [8, false], WORD: [16, false], DWORD: [32, false], LWORD: [64, false],
};

/** An S7-1500 integer that overflows wraps around (32767 + 1 = -32768 in an Int), as on the PLC. */
function wrapInteger(v: number, d: Decl | undefined): number {
  if (!d || d.isArray || !Number.isInteger(v)) return v;
  const w = INT_WIDTH[(d.typeRef ?? d.type).replace(/^"|"$/g, "").toUpperCase()];
  if (!w) return v;
  return wrapBig(BigInt(v), w);
}

/** An integer wrapped into its width, exactly: a 64-bit result a double cannot hold stops the test. */
function wrapBig(x: bigint, [bits, signed]: [number, boolean]): number {
  return exactInteger(signed ? BigInt.asIntN(bits, x) : BigInt.asUintN(bits, x));
}

/**
 * An integer result as the simulator's number, when a double holds it exactly: every integer up to 2^53, and
 * beyond that those with enough zero bits at the end (16#FF00_0000_0000_0000). Any other 64-bit value would lose
 * bits, so the test stops instead of going on with a wrong one.
 */
function exactInteger(x: bigint): number {
  const n = Number(x);
  if (BigInt(n) !== x) throw new SimError(`the 64-bit value 16#${BigInt.asUintN(64, x).toString(16).toUpperCase()} cannot be held exactly: the simulator keeps integers exact up to 2^53, and beyond only where a double holds them`);
  return n;
}

/** A string cut to what its type holds, as the PLC stores it: String[5] keeps five characters, a String 254, a Char one. */
function fitString(v: string, d: Decl | undefined): string {
  if (!d || d.isArray) return v;
  const t = d.type.trim();
  if (/^W?CHAR$/i.test(t)) return v.slice(0, 1);
  const m = /^W?STRING\s*(?:\[\s*(\d+)\s*\])?$/i.exec(t);
  return m ? v.slice(0, m[1] !== undefined ? Number(m[1]) : 254) : v;
}

/**
 * AND, OR, XOR of integers and bit strings, exact at every width: JavaScript's & | ^ work on 32-bit signed
 * numbers, which turns a DWORD with its top bit set negative (16#FFFF0000 AND 16#FFFF0000 would be -65536).
 */
function bitwise(op: string, l: number, r: number): number {
  if (!Number.isInteger(l) || !Number.isInteger(r)) return op === "XOR" ? l ^ r : op === "OR" ? l | r : l & r;
  const a = BigInt(l);
  const b = BigInt(r);
  return exactInteger(op === "XOR" ? a ^ b : op === "OR" ? a | b : a & b);
}

/** + - * of two integers: past 2^53 a double rounds, so the result is worked out exactly and refused if it cannot be held. */
function exactArith(op: string, l: number, r: number, n: number): number {
  if (Number.isSafeInteger(n) || !Number.isInteger(l) || !Number.isInteger(r)) return n;
  const a = BigInt(l);
  const b = BigInt(r);
  return exactInteger(op === "+" ? a + b : op === "-" ? a - b : a * b);
}

const combine = (a: Kind, b: Kind): Kind => (a === "real" || b === "real" ? "real" : a === "int" && b === "int" ? "int" : "unknown");

function kindOfType(d: Decl | undefined): Kind {
  if (!d || d.isArray || d.members?.length) return "unknown";
  const t = (d.typeRef ?? d.type).replace(/^"|"$/g, "");
  if (REAL_TYPES.test(t)) return "real";
  if (INT_TYPES.test(t) || TIME_TYPES.test(t)) return "int";
  return "unknown";
}

export class Simulator {
  /** Virtual time in milliseconds. */
  time = 0;
  /** The date and time the virtual clock starts at (RD_SYS_T, RD_LOC_T), in milliseconds since 1970. */
  clockStart = CLOCK_START;
  readonly globals: Struct = {};
  // by the block object, not its name: two PLCs, or two FBs' properties, can have blocks of one name
  private readonly bodies = new WeakMap<BlockModel, Map<string, Stmt[]>>();
  private readonly consts = new WeakMap<BlockModel, Map<string, Struct>>();
  private blockUris = new WeakMap<BlockModel, string>();
  private readonly stlPrograms = new WeakMap<BlockModel, Map<string, StlProgram>>();
  /** The S5 timers STL starts with SD, by the timer tag. */
  private readonly s5timers = new Map<string, S5Timer>();
  private steps = 0;
  private depth = 0;

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly maxStepsPerCall = 1_000_000,
  ) {}

  private block(name: string): BlockModel {
    const g = this.index.global(name);
    if (g?.kind === "OBJECT") throw this.objectError(name);
    if (!g?.block) throw new SimError(`Block "${name}" is not in the workspace, or has no code the simulator can run (know-how protected)`);
    return g.block;
  }

  private objectError(name: string): SimError {
    return new SimError(`"${name}" is a technology object or a graphical/protected block; it is not simulated`);
  }

  /** The statements of a block, or of one accessor of a PROPERTY. */
  private body(b: BlockModel, accessor?: "get" | "set"): Stmt[] {
    const key = accessor ?? "";
    let cached = this.bodies.get(b);
    if (!cached) this.bodies.set(b, (cached = new Map()));
    const bodies = cached;
    let s = bodies.get(key);
    if (!s) {
      if (b.stl) throw new SimError(`"${b.name}" is an STL block; STL is not simulated`, b.name);
      if (b.ladUnsupported?.length) throw new SimError(`"${b.name}" uses ${b.xml ? "LAD/FBD" : "LAD"} elements the simulator does not run yet: ${b.ladUnsupported.join("; ")}`, b.name);
      if (b.lad === undefined && b.xml) throw new SimError(`"${b.name}" is kept as SimaticML XML in a language the simulator does not run (GRAPH, or a data block)`, b.name);
      if (b.lad !== undefined) {
        // its STL networks are refused before anything runs, as a block of STL is
        for (const [n, net] of (b.stlNetworks ?? []).entries()) {
          const p = this.stlProgram(b, String(n), () => parseStl(net.source, 0, net.source.length));
          if (p.missing.length) throw new SimError(`"${b.name}" uses STL instructions the simulator does not run yet (network ${net.network}): ${p.missing.join(", ")}`, b.name);
        }
        try {
          s = parseBody(b.lad);
        } catch (e) {
          if (e instanceof SclSyntaxError) throw new SimError(`LAD block ${b.name} could not be translated for the simulator: ${e.message}`, b.name);
          throw e;
        }
        bodies.set(key, s);
        return s;
      }
      const doc = this.index.docs.get(this.uriOf(b))!;
      const src = doc.code ?? doc.text; // TwinCAT XML: code with the markup blanked out
      const iec = doc.code !== undefined || /\.st$/i.test(doc.uri);
      const range = accessor ? b.property?.[accessor] : b.bodyStart === undefined ? undefined : { start: b.bodyStart, end: b.end };
      try {
        s = range ? parseBody(src, range.start, range.end, { iec }) : [];
      } catch (e) {
        if (e instanceof SclSyntaxError) throw new SimError(`Syntax error in ${b.name} (line ${doc.lines.position(e.offset).line + 1}): ${e.message}`, b.name, e.offset);
        throw e;
      }
      bodies.set(key, s);
    }
    return s;
  }

  /** The file a block was read from. */
  private uriOf(b: BlockModel): string {
    let uri = this.blockUris.get(b);
    if (uri === undefined) {
      // files come and go (rung simulate reloads them): look again
      this.blockUris = new WeakMap();
      for (const d of this.index.docs.values()) for (const x of d.parsed?.blocks ?? []) this.blockUris.set(x, d.uri);
      uri = this.blockUris.get(b);
    }
    if (uri === undefined) throw new SimError(`"${b.name}" is not in the workspace`, b.name);
    return uri;
  }

  /** 1-based source line of an offset in a block's file (for error messages). */
  lineOf(blockName: string, offset: number): number | undefined {
    const g = this.index.global(blockName);
    const doc = g ? this.index.docs.get(g.uri) : undefined;
    return doc ? doc.lines.position(offset).line + 1 : undefined;
  }

  // ------------------------------------------------------------------ values

  /** Constants of a block (VAR CONSTANT), evaluated once; used for array bounds and initial values. */
  /** With `accessor`, the constants a PROPERTY's GET or SET sees (its own, not the other accessor's). */
  private constants(scope: BlockModel | undefined, accessor?: "get" | "set"): Struct {
    if (!scope) return {};
    let byAccessor = this.consts.get(scope);
    if (!byAccessor) this.consts.set(scope, (byAccessor = new Map()));
    let c = byAccessor.get(accessor ?? "");
    if (!c) {
      c = {};
      byAccessor.set(accessor ?? "", c);
      for (const v of scope.vars)
        if (v.section === "Constant" && !v.isArray && !v.members?.length && (!v.accessor || v.accessor === accessor)) c[v.name.toUpperCase()] = this.defaultValue(v, scope, accessor);
    }
    return c;
  }

  private constFrame(scope: BlockModel | undefined, accessor?: "get" | "set"): Frame {
    const block: BlockModel = scope ?? { kind: "FC", name: "", nameStart: 0, nameEnd: 0, start: 0, end: 0, vars: [], regions: [], refs: [] };
    const temps = { ...this.constants(scope, accessor) };
    // inside a GVL, its constants are also reachable qualified: ARRAY[0..GVL_Cfg.N_ITEMS - 1]
    if (scope?.kind === "GVL") temps[scope.name.toUpperCase()] = this.constants(scope);
    return { block, mem: {}, temps };
  }

  private constValue(text: string, scope: BlockModel | undefined, accessor?: "get" | "set"): number {
    const t = text.trim();
    if (/^[-+]?\d+$/.test(t)) return Number(t);
    let v: Value;
    try {
      const [s] = parseBody(`#__c := ${t};`);
      v = s?.k === "assign" ? this.eval(s.value, this.constFrame(scope, accessor)) : undefined;
    } catch {
      v = undefined;
    }
    if (typeof v !== "number" || !Number.isInteger(v)) throw new SimError(`array bound ${t} is not a constant the simulator can evaluate (literals, block constants and GVL constants are supported)`, scope?.name);
    return v;
  }

  private bounds(dim: string, scope: BlockModel | undefined, accessor?: "get" | "set"): [number, number] {
    const at = dim.indexOf("..");
    if (at < 0) {
      if (dim.trim() === "*") return [0, -1]; // Array[*] parameter: sized by the caller
      throw new SimError(`array dimension ${dim.trim()} is not a range`, scope?.name);
    }
    return [this.constValue(dim.slice(0, at), scope, accessor), this.constValue(dim.slice(at + 2), scope, accessor)];
  }

  /** With `accessor`: as a PROPERTY's GET or SET sees it (its own constants, for initial values and array bounds). */
  defaultValue(decl: Decl, scope?: BlockModel, accessor?: "get" | "set"): Value {
    if (decl.isArray) {
      const shape = splitArrayType(decl.type);
      if (!shape) return { __array: true, lo: 0, items: [] };
      const dims = shape.dims.map((d) => this.bounds(d, scope, accessor));
      // the element keeps the struct members / named type; only the outer `Array[..] of` is removed
      const element: Decl = { type: shape.element, typeRef: decl.typeRef, isArray: /^array\b/i.test(shape.element), members: decl.members };
      const build = (k: number): Value => {
        if (k === dims.length) return this.defaultValue(element, scope, accessor);
        const [lo, hi] = dims[k]!;
        return { __array: true, lo, items: Array.from({ length: Math.max(0, hi - lo + 1) }, () => build(k + 1)) };
      };
      return build(0);
    }
    if (decl.members?.length) return this.structOf(decl.members, scope, accessor);
    let v: Value;
    const t = (decl.typeRef ?? decl.type).replace(/^"|"$/g, "");
    if (/^BOOL$/i.test(t)) v = false;
    else if (INT_TYPES.test(t) || REAL_TYPES.test(t) || TIME_TYPES.test(t)) v = 0;
    else if (STRING_TYPES.test(t.replace(/\[.*$/, ""))) v = "";
    else {
      const g = this.index.global(t);
      const sys = SYSTEM_TYPES.get(t.toUpperCase());
      if (g?.block?.enumValues) {
        const def = g.block.enumDefault?.toUpperCase();
        v = (g.block.enumValues.find((e) => e.name.toUpperCase() === def) ?? g.block.enumValues[0])?.value ?? 0;
      } else if (g?.block?.kind === "UDT") v = this.structOf(g.block.vars, g.block);
      else if (g?.block?.kind === "FB") v = this.newInstance(g.block.name);
      else if (STANDARD_BY_NAME.get(t.toUpperCase())?.kind === "functionBlock") v = this.newInstance(t);
      else if (sys) {
        v = Object.fromEntries(sys.map((m) => [m.name.toUpperCase(), this.defaultValue({ type: m.type, typeRef: m.typeRef ?? m.type, isArray: !!m.isArray })]));
        // a DTL nobody set is DTL#1970-01-01-00:00:00, a Thursday (WEEKDAY 5), as in TIA Portal
        if (/^DTL$/i.test(t)) Object.assign(v as Struct, { YEAR: 1970, MONTH: 1, DAY: 1, WEEKDAY: 5 });
      }
      else v = 0; // unknown elementary type (Variant, system types, …): treated as a number
    }
    if (decl.init !== undefined && !isInstance(v) && typeof v !== "object") {
      try {
        const [s] = parseBody(`#__init := ${decl.init};`);
        if (s?.k === "assign") v = this.eval(s.value, this.constFrame(scope, accessor));
      } catch {
        /* complex initializers (array lists) keep the default */
      }
    }
    return v;
  }

  private structOf(vars: VarDecl[], scope?: BlockModel, accessor?: "get" | "set"): Struct {
    const s: Struct = {};
    for (const m of vars) s[m.name.toUpperCase()] = this.defaultValue(m, scope, accessor);
    return s;
  }

  newInstance(fbName: string): Instance {
    const std = STANDARD_BY_NAME.get(fbName.toUpperCase());
    const stub = this.stubOf(fbName);
    if (std?.kind === "functionBlock") {
      const mem: Struct = {};
      for (const p of std.params) mem[p.name.toUpperCase()] = /Bool/i.test(p.type) ? false : 0;
      return { __fb: std.name, mem: stub ? Object.assign(mem, copyValue(stub) as Struct) : mem, std: {} };
    }
    // a stubbed FB nobody describes (a system FB, a missing block): its members are the stub's, then what calls and tests name
    if (stub && !this.index.global(fbName)?.block) return { __fb: fbName, mem: copyValue(stub) as Struct, stub: true };
    const b = this.block(fbName);
    if (b.kind !== "FB" && b.kind !== "PRG") throw new SimError(`"${fbName}" is ${b.kind}, not a function block`);
    const vars = b.vars.filter((v) => v.section !== "Temp" && v.section !== "Constant");
    const mem = this.structOf(vars, b);
    this.stubMembers(mem, vars);
    return { __fb: b.name, mem: stub ? Object.assign(mem, copyValue(stub) as Struct) : mem };
  }

  // ------------------------------------------------------------------ stubs (rung test: stubs:)

  /**
   * What a test stands in for, by block, instruction or technology object name (upper case, no quotes): the values
   * its outputs start with. Only what is named here is stubbed.
   */
  stubs = new Map<string, Struct>();
  /** How often each stub was called (a technology object: used) since the simulator started. */
  readonly stubCalls = new Map<string, number>();
  /** Values a test gives hardware identifiers ("Rack~Module"), system constants of a device configuration rung does not have. */
  hardwareIds = new Map<string, number>();

  private stubOf(name: string): Struct | undefined {
    return this.stubs.size ? this.stubs.get(name.replace(/^"|"$/g, "").toUpperCase()) : undefined;
  }

  private stubCalled(name: string) {
    const k = name.replace(/^"|"$/g, "").toUpperCase();
    this.stubCalls.set(k, (this.stubCalls.get(k) ?? 0) + 1);
  }

  /** Multi-instances of a stubbed type that structOf left as placeholders (a type the workspace does not have) get their stub instance. */
  private stubMembers(mem: Struct, vars: VarDecl[]) {
    if (!this.stubs.size) return;
    for (const v of vars) {
      const shape = v.isArray ? splitArrayType(v.type) : undefined;
      const type = (shape ? shape.element : (v.typeRef ?? v.type)).replace(/^"|"$/g, "");
      if (!this.stubOf(type) || this.index.global(type)?.block || STANDARD_BY_NAME.has(type.toUpperCase())) continue;
      const fill = (x: Value): Value => (isArray(x) ? { ...x, items: x.items.map(fill) } : isInstance(x) ? x : this.newInstance(type));
      mem[v.name.toUpperCase()] = fill(mem[v.name.toUpperCase()]);
    }
  }

  /** One call of a stubbed FB: the arguments reach its members, its outputs go back to the caller, no code runs. */
  private runStub(inst: Instance, args: { name?: string; out?: boolean; value: Expr }[], caller: Frame | null) {
    this.stubCalled(inst.__fb);
    const b = inst.stub ? undefined : this.index.global(inst.__fb)?.block;
    if (!inst.stub) {
      // a type with an interface (a user FB, an IEC FB): its parameters as declared
      this.bindInputs(inst.mem, b?.kind === "FB" ? b : null, args, caller);
      this.bindOutputs(inst.mem, b?.kind === "FB" ? b : null, args, caller);
      return;
    }
    for (const a of args) {
      if (!a.name) throw new SimError(`${inst.__fb} is stubbed: name its arguments (REQ := ...), the stub has no parameter list`, caller?.block.name);
      const key = a.name.toUpperCase();
      if (!a.out) inst.mem[key] = copyValue(this.eval(a.value, caller));
      else if (!(key in inst.mem)) {
        // an output first named here starts at its type's default, like a fresh FB's
        const d = a.value.k === "ref" ? this.declOf(a.value.ref, caller) : undefined;
        inst.mem[key] = d ? this.defaultValue(d) : 0;
      }
    }
    for (const a of args) if (a.out && a.value.k === "ref") this.write(a.value.ref, inst.mem[a.name!.toUpperCase()], caller);
  }

  /** A call of a stubbed FC or function: inputs are evaluated, outputs and the return value come from the stub. */
  private callStub(name: string, c: Extract<Expr, { k: "call" }>, frame: Frame | null, stub: Struct): Value {
    this.stubCalled(name);
    const b = this.index.global(name)?.block;
    for (const a of c.args) {
      const key = a.name?.toUpperCase();
      const inOut = !!key && !!b?.vars.some((v) => v.section === "InOut" && v.name.toUpperCase() === key);
      if ((a.out || inOut) && a.value.k === "ref") {
        if (key && key in stub) this.write(a.value.ref, stub[key], frame); // an output the stub does not name keeps the caller's value
      } else this.eval(a.value, frame);
    }
    if ("RET_VAL" in stub) return copyValue(stub.RET_VAL);
    return b?.returnType && !/^void$/i.test(b.returnType) ? this.defaultValue({ type: b.returnType, typeRef: b.returnType, isArray: false }, b) : 0;
  }

  /** IEC 61131-3 globals are referenced without quotes: GVL lists, their variables and PROGRAMs. */
  isIecGlobal(name: string): boolean {
    const k = this.index.global(name);
    return k?.kind === "GVAR" || k?.block?.kind === "GVL" || k?.block?.kind === "PRG";
  }

  /** Global DB memory or tag value, created on first use from the workspace. */
  private global(name: string): { obj: Struct; key: string } {
    const key = name.toUpperCase();
    if (!(key in this.globals)) {
      const g = this.index.global(name);
      if (g?.kind === "GVAR") return { obj: this.global(g.gvar!.list).obj[g.gvar!.list.toUpperCase()] as Struct, key: g.name.toUpperCase() };
      if (g?.block?.kind === "GVL" || g?.block?.kind === "PRG") this.globals[key] = g.block.kind === "GVL" ? this.structOf(g.block.vars, g.block) : this.newInstance(g.block.name);
      else if (g?.block?.kind === "DB") {
        const b = g.block;
        const of = b.dbOf ? this.index.global(b.dbOf)?.block : undefined;
        const value: Value = b.dbOf ? (of?.kind === "UDT" ? this.structOf(of.vars, of) : this.newInstance(b.dbOf)) : this.structOf(b.vars, b);
        this.globals[key] = value;
        this.applyStartValues(b, value);
      } else if (g?.tag) {
        // PLC tags start at their type's default; user constants from a tag table have a value
        this.globals[key] = this.defaultValue({ type: g.tag.dataType, typeRef: g.tag.dataType, isArray: false, ...(g.tag.value !== undefined ? { init: g.tag.value } : {}) });
      }
      else if (g?.kind === "OBJECT") {
        // a stubbed technology object: its members as the stub names them, readable, settable and callable like an instance
        const stub = this.stubOf(name);
        if (!stub) throw this.objectError(name);
        this.globals[key] = { __fb: g.name, mem: copyValue(stub) as Struct, stub: true };
        this.stubCalled(name);
      } else if (name.includes("~")) {
        // a hardware identifier: its value is in the device configuration, which rung does not have offline
        const id = this.hardwareIds.get(key);
        if (id === undefined) throw new SimError(`"${name}" is a hardware identifier: it has no value offline; give it one in the test (stubs: { '"${name}"': 257 })`);
        this.globals[key] = id;
        this.stubCalled(name);
      } else throw new SimError(`"${name}" is not a data block or tag in the workspace`);
    }
    return { obj: this.globals, key };
  }

  /** DB start values from the BEGIN part (`cnt := 200;`, `T1.PT := T#2s;`) override declared defaults. */
  private applyStartValues(b: BlockModel, value: Value) {
    if (b.bodyStart === undefined) return;
    const mem = isInstance(value) ? value.mem : (value as Struct);
    // "Valve 1".delay := T#2s; names the DB's own member, as Counter := 0; does
    const own = (s: Stmt): Stmt => (s.k === "assign" && s.target.root.kind === "global" && s.target.root.name.toUpperCase() in mem ? { ...s, target: { ...s.target, root: { kind: "ident", name: s.target.root.name } } } : s);
    const stmts = this.body(b).map(own);
    if (!stmts.length) return;
    this.exec(stmts, { block: b, mem, temps: {} });
  }

  // ------------------------------------------------------------------ references

  /** Where a reference lives. A bound REFERENCE TO is followed to its target unless `raw` (REF= rebinds the variable itself). */
  private locate(ref: LRef, frame: Frame | null, raw = false): { obj: Struct | Value[]; key: string | number } {
    let obj: Struct | Value[];
    let key: string | number;
    let path = ref.path;
    const root = ref.root.name.toUpperCase();
    const follow = () => {
      for (let v = (obj as Struct)[key as string] ?? (obj as Value[])[key as number]; isPointer(v) && v.ref; v = (obj as Struct)[key as string] ?? (obj as Value[])[key as number])
        ({ obj, key } = this.placeOf(v));
    };
    const first = path[0];
    const second = path[1];
    if (root === "THIS" && ref.root.kind === "ident" && first && "deref" in first) {
      // THIS^.x: the variable x of the instance the FB or METHOD runs on, even where a local has the same name
      if (!frame?.inst) throw new SimError("THIS^ outside a function block", frame?.block.name, ref.start);
      if (!second || !("member" in second)) throw new SimError("THIS^ needs a member, e.g. THIS^.nCount", frame.block.name, ref.start);
      obj = frame.inst.mem;
      key = second.member.toUpperCase();
      if (!(key in obj)) throw new SimError(`${second.member} is not a variable of ${frame.inst.__fb}`, frame.block.name, ref.start);
      path = path.slice(2);
    } else if (ref.root.kind === "global") ({ obj, key } = this.global(ref.root.name));
    else {
      if (!frame) throw new SimError(`#${ref.root.name} used outside a block`);
      if (root in frame.temps) obj = frame.temps;
      else if (root in frame.mem) obj = frame.mem;
      else if (root === frame.block.name.toUpperCase() && frame.block.kind === "FC") obj = frame.temps; // FC return value
      else if (ref.root.kind === "ident" && frame.block.kind === "DB") obj = frame.mem;
      else if (ref.root.kind === "ident" && this.isIecGlobal(ref.root.name)) ({ obj, key } = this.global(ref.root.name));
      else throw new SimError(`#${ref.root.name} is not declared in ${frame.block.name}`, frame.block.name, ref.start);
      key = root;
    }
    for (const seg of path) {
      follow();
      let cur: Value = (obj as Struct)[key as string] ?? (obj as Value[])[key as number];
      if ("deref" in seg) {
        // p^: the value p points to (ADR(x))
        if (!isPointer(cur)) throw new SimError(cur === 0 || cur === undefined ? "^ on a pointer that points nowhere (0)" : "^ on a value that is not a pointer", frame?.block.name, ref.start);
        ({ obj, key } = cur.__ptr);
        continue;
      }
      const stubbed = isInstance(cur) && cur.stub ? cur.__fb : undefined;
      if (isInstance(cur)) cur = cur.mem;
      if ("member" in seg) {
        if (typeof cur !== "object" || cur === null || isArray(cur)) throw new SimError(`${seg.member}: not a structure`, frame?.block.name, ref.start);
        obj = cur as Struct;
        key = seg.member.toUpperCase();
        if (!(key in obj))
          throw new SimError(stubbed ? `${seg.member} is not a member of the stub of ${stubbed}: give it a start value in the test (stubs: { ${stubbed}: { ${seg.member}: … } })` : `${seg.member} is not a member`, frame?.block.name, ref.start);
      } else if ("index" in seg) {
        for (let d = 0; d < seg.index.length; d++) {
          const arr = d === 0 ? cur : (obj as Value[])[key as number];
          if (!isArray(arr as Value)) throw new SimError("indexing a value that is not an array", frame?.block.name, ref.start);
          const a = arr as ArrayValue;
          const idx = Number(this.eval(seg.index[d]!, frame));
          if (!Number.isInteger(idx) || idx < a.lo || idx >= a.lo + a.items.length) throw new SimError(`array index ${idx} out of range ${a.lo}..${a.lo + a.items.length - 1}`, frame?.block.name, ref.start);
          obj = a.items;
          key = idx - a.lo;
        }
      } else throw new SimError("slice access (.%X, .%B, .%W, .%D) must come last", frame?.block.name, ref.start);
    }
    if (!raw) follow();
    return { obj, key };
  }

  /** An enumeration value (E_State.Idle, E_State#Idle, or a bare Idle in IEC code) where no variable has the name. */
  private enumConst(ref: LRef, frame: Frame | null): number | undefined {
    if (ref.root.kind !== "ident") return undefined;
    const root = ref.root.name.toUpperCase();
    if (frame && (root in frame.temps || root in frame.mem)) return undefined;
    const seg = ref.path[0];
    if (ref.path.length === 1 && seg && "member" in seg) {
      const u = seg.member.toUpperCase();
      return this.index.global(ref.root.name)?.block?.enumValues?.find((e) => e.name.toUpperCase() === u)?.value;
    }
    if (ref.path.length || this.isIecGlobal(ref.root.name)) return undefined;
    if (!this.bareEnums) {
      // an enumerator two types share is ambiguous without its type: left out
      const seen = new Map<string, number | null>();
      for (const g of this.index.allGlobals())
        for (const e of g.block?.enumValues ?? []) seen.set(e.name.toUpperCase(), seen.has(e.name.toUpperCase()) ? null : e.value);
      this.bareEnums = new Map([...seen].filter((x): x is [string, number] => x[1] !== null));
    }
    return this.bareEnums.get(root);
  }
  private bareEnums?: Map<string, number>;

  read(ref: LRef, frame: Frame | null): Value {
    const en = this.enumConst(ref, frame);
    if (en !== undefined) return en;
    const last = ref.path[ref.path.length - 1];
    if (last && "slice" in last) return sliceGet(this.read({ ...ref, path: ref.path.slice(0, -1) }, frame), last);
    const p = this.propertyAt(ref, frame);
    if (p) return this.runProperty(p.inst, p.prop, "get");
    const { obj, key } = this.locate(ref, frame);
    return (obj as Struct)[key as string] ?? (obj as Value[])[key as number];
  }

  write(ref: LRef, value: Value, frame: Frame | null) {
    const last = ref.path[ref.path.length - 1];
    if (last && "slice" in last) {
      const base = { ...ref, path: ref.path.slice(0, -1) };
      const d = this.declOf(base, frame);
      const of = d && !d.isArray ? INT_WIDTH[(d.typeRef ?? d.type).replace(/^"|"$/g, "").toUpperCase()] : undefined;
      this.write(base, sliceSet(this.read(base, frame), last, value, of), frame);
      return;
    }
    const p = this.propertyAt(ref, frame);
    if (p) {
      this.runProperty(p.inst, p.prop, "set", value);
      return;
    }
    const { obj, key } = this.locate(ref, frame);
    // an assigned structure or array is copied, as on the PLC: #b := #a; then #a.x := 5; leaves #b.x alone
    (obj as Record<string | number, Value>)[key] =
      typeof value === "number" ? wrapInteger(value, this.declOf(ref, frame)) : typeof value === "string" ? fitString(value, this.declOf(ref, frame)) : copyValue(value);
  }

  // ------------------------------------------------------------------ static types (REAL vs integer division)

  /**
   * The elementary type an expression has, where the source says it: a variable's declaration, a typed literal
   * (WORD#16#00FF), a conversion (INT_TO_WORD), and NOT or a bit operation of those. Integer widths follow it.
   */
  private staticDecl(e: Expr, frame: Frame | null): Decl | undefined {
    const named = (t: string): Decl => ({ type: t, typeRef: t, isArray: false });
    switch (e.k) {
      case "ref":
        return this.declOf(e.ref, frame);
      case "lit":
        return e.typeName && INT_WIDTH[e.typeName] ? named(e.typeName) : undefined;
      case "un":
        return e.op === "NOT" ? this.staticDecl(e.e, frame) : undefined;
      case "bin":
        return ["AND", "&", "OR", "XOR"].includes(e.op) ? (this.staticDecl(e.l, frame) ?? this.staticDecl(e.r, frame)) : undefined;
      case "call": {
        if (e.callee.path.length) return undefined;
        // a shift or rotation has the width of its input: NOT SHL(IN := BYTE#16#01, N := 1) is a BYTE
        if (/^(SHL|SHR|ROL|ROR)$/i.test(e.callee.root.name)) {
          const input = e.args.find((a) => a.name?.toUpperCase() === "IN") ?? e.args.find((a) => !a.name);
          return input ? this.staticDecl(input.value, frame) : undefined;
        }
        const to = /_TO_([A-Z]+)$/i.exec(e.callee.root.name)?.[1]?.toUpperCase();
        return to && INT_WIDTH[to] ? named(to) : undefined;
      }
      default:
        return undefined;
    }
  }

  /** Declared type of a reference, when the workspace knows it. */
  private declOf(ref: LRef, frame: Frame | null): Decl | undefined {
    let d: Decl | undefined;
    const name = ref.root.name.toUpperCase();
    let path = ref.path;
    const fbVar = (n: string) => (frame?.inst ? this.index.global(frame.inst.__fb)?.block?.vars.find((x) => x.name.toUpperCase() === n) : undefined);
    const [p0, p1] = path;
    if (name === "THIS" && p0 && "deref" in p0 && p1 && "member" in p1) {
      d = fbVar(p1.member.toUpperCase());
      path = path.slice(2);
    } else if (ref.root.kind !== "global" && frame) {
      const b = frame.block;
      d = b.vars.find((x) => x.name.toUpperCase() === name && (!x.accessor || x.accessor === frame.accessor));
      if (!d && name === b.name.toUpperCase() && b.returnType) d = { type: b.returnType, typeRef: b.returnType, isArray: false };
      if (!d && b.kind === "DB" && b.dbOf) d = this.index.membersOfType(b.dbOf).find((m) => m.name.toUpperCase() === name);
      if (!d && b.owner) d = fbVar(name); // a METHOD sees the variables of its FB
    }
    if (!d && name !== "THIS") {
      const g = this.index.global(ref.root.name);
      if (g?.gvar) d = g.gvar.decl;
      else if (g?.tag) d = { type: g.tag.dataType, typeRef: g.tag.dataType, isArray: false };
      else if (g?.block && (g.block.kind === "DB" || g.block.kind === "GVL" || g.block.kind === "PRG")) d = { type: g.name, typeRef: g.name, isArray: false };
    }
    for (const seg of path) {
      if (!d) return undefined;
      d = targetDecl(d, /^REFERENCE\s+TO\s+/i);
      if ("deref" in seg) {
        d = targetDecl(d, /^POINTER\s+TO\s+/i);
        continue;
      }
      if ("member" in seg) {
        const u = seg.member.toUpperCase();
        d = this.index.membersOf(d as Member).find((m) => m.name.toUpperCase() === u);
      } else if ("index" in seg) {
        const shape = d.isArray ? splitArrayType(d.type) : undefined;
        if (!shape) return undefined;
        d = { type: shape.element, typeRef: d.typeRef, isArray: /^array\b/i.test(shape.element), members: d.members };
      } else d = { type: ({ X: "Bool", B: "Byte", W: "Word", D: "DWord" } as const)[seg.slice], isArray: false }; // .%B is a Byte, .%W a Word
    }
    return d && targetDecl(d, /^REFERENCE\s+TO\s+/i);
  }

  private kindOf(e: Expr, frame: Frame | null): Kind {
    switch (e.k) {
      case "lit":
        return e.type === "real" ? "real" : e.type === "int" || e.type === "time" ? "int" : "unknown";
      case "un":
        return this.kindOf(e.e, frame);
      case "bin":
        if (e.op === "**") return "real";
        if (!["+", "-", "*", "/", "MOD"].includes(e.op)) return "unknown";
        return combine(this.kindOf(e.l, frame), this.kindOf(e.r, frame));
      case "ref":
        return kindOfType(this.declOf(e.ref, frame));
      case "call": {
        if (e.callee.path.length) return "unknown";
        const upper = e.callee.root.name.toUpperCase();
        if (/_TO_/.test(upper)) return kindOfType({ type: upper.split("_TO_")[1] ?? "", isArray: false });
        if (/^(SQRT|SQR|LN|LOG|EXP|SIN|COS|TAN|ASIN|ACOS|ATAN|NORM_X)$/.test(upper)) return "real";
        if (/^(LEN|FIND|SWAP|COUNTOFELEMENTS|LOWER_BOUND|UPPER_BOUND|T_DIFF|MOVE_BLK_VARIANT)$/.test(upper)) return "int";
        if (upper === "RUNTIME") return "real";
        if (/^(ABS|MIN|MAX|LIMIT|SEL|MUX)$/.test(upper)) {
          const values = e.args.filter((a, i) => !(upper === "SEL" && (a.name?.toUpperCase() === "G" || (!a.name && i === 0))) && !(upper === "MUX" && (a.name?.toUpperCase() === "K" || (!a.name && i === 0))));
          return values.map((a) => this.kindOf(a.value, frame)).reduce(combine, values.length ? "int" : "unknown");
        }
        const g = this.index.global(e.callee.root.name);
        if (g?.block?.kind === "FC" && g.block.returnType) return kindOfType({ type: g.block.returnType, typeRef: g.block.returnType, isArray: false });
        return "unknown";
      }
    }
  }

  // ------------------------------------------------------------------ expressions

  eval(e: Expr, frame: Frame | null): Value {
    switch (e.k) {
      case "lit":
        return e.value;
      case "ref":
        return this.read(e.ref, frame);
      case "un": {
        const v = this.eval(e.e, frame);
        if (e.op !== "NOT") return e.op === "-" ? -Number(v) : Number(v);
        if (typeof v !== "number") return !v;
        // in the width of the operand's type: NOT 16#00FF of a Word is 16#FF00 (worked out exactly, 64 bits too)
        if (!Number.isInteger(v)) return ~v;
        const d = this.staticDecl(e.e, frame);
        const w = d && !d.isArray ? INT_WIDTH[(d.typeRef ?? d.type).replace(/^"|"$/g, "").toUpperCase()] : undefined;
        return w ? wrapBig(~BigInt(v), w) : exactInteger(~BigInt(v));
      }
      case "bin": {
        const l = this.eval(e.l, frame);
        if (e.op === "AND" || e.op === "&") {
          const r = this.eval(e.r, frame);
          return typeof l === "number" ? bitwise("AND", l, r as number) : !!l && !!r;
        }
        if (e.op === "OR") {
          const r = this.eval(e.r, frame);
          return typeof l === "number" ? bitwise("OR", l, r as number) : !!l || !!r;
        }
        const r = this.eval(e.r, frame);
        switch (e.op) {
          case "XOR":
            return typeof l === "number" ? bitwise("XOR", l, r as number) : !!l !== !!r;
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
            return typeof l === "string" ? l + String(r) : this.intExact(e, frame, "+", l as number, r as number, (l as number) + (r as number));
          case "-":
            return this.intExact(e, frame, "-", l as number, r as number, (l as number) - (r as number));
          case "*":
            return this.intExact(e, frame, "*", l as number, r as number, (l as number) * (r as number));
          case "**":
            return Math.pow(l as number, r as number);
          case "MOD":
            if (r === 0) throw new SimError("integer division by zero (MOD 0)", frame?.block.name);
            return (l as number) % (r as number);
          case "/": {
            const kl = this.kindOf(e.l, frame);
            const kr = this.kindOf(e.r, frame);
            // REAL when either side is declared REAL; integer when both are declared integers;
            // otherwise (types unknown to the workspace) decide by the values
            const real = kl === "real" || kr === "real" || (!(kl === "int" && kr === "int") && !(Number.isInteger(l) && Number.isInteger(r)));
            if (real) return (l as number) / (r as number); // x / 0.0 gives ±Inf or NaN like the PLC
            if (r === 0) throw new SimError("integer division by zero", frame?.block.name);
            // past 2^53 the quotient of two doubles rounds before it is cut: divide exactly (BigInt cuts towards 0, as SCL)
            if (!Number.isSafeInteger(l) && Number.isInteger(l) && Number.isInteger(r)) return exactInteger(BigInt(l as number) / BigInt(r as number));
            return Math.trunc((l as number) / (r as number));
          }
        }
        throw new SimError(`operator ${e.op} not supported`);
      }
      case "call":
        return this.call(e, frame);
    }
  }

  /** An integer + - * past 2^53 exactly (or refused); REAL arithmetic stays floating point. */
  private intExact(e: Extract<Expr, { k: "bin" }>, frame: Frame | null, op: string, l: number, r: number, n: number): number {
    if (Number.isSafeInteger(n) || !Number.isFinite(n)) return n;
    const kl = this.kindOf(e.l, frame);
    const kr = this.kindOf(e.r, frame);
    return kl !== "real" && kr !== "real" && (kl === "int" || kr === "int") ? exactArith(op, l, r, n) : n;
  }

  // ------------------------------------------------------------------ calls

  private call(c: Extract<Expr, { k: "call" }>, frame: Frame | null): Value {
    const name = c.callee.root.name;
    const upper = name.toUpperCase();
    const path = c.callee.path;
    // an STL network of a SimaticML block, where the block's translation has it
    if (upper === "__RUNG_STL" && c.callee.root.kind === "ident" && !path.length && frame) {
      this.runStlNetwork(frame, Number(this.eval(c.args[0]!.value, frame)));
      return undefined;
    }
    // METHODs: fb.M(...), and inside the FB or one of its methods M(...) or THIS^.M(...)
    if (c.callee.root.kind === "ident") {
      const [p0, p1] = path;
      if (upper === "THIS" && p0 && "deref" in p0 && p1 && "member" in p1 && path.length === 2 && frame?.inst) {
        const m = this.callableOf(frame.inst.__fb, p1.member);
        if (!m) throw new SimError(`${frame.inst.__fb} has no METHOD ${p1.member}`, frame.block.name, c.callee.start);
        return this.callMethod(frame.inst, m, c, frame);
      }
      if (!path.length && frame?.inst && !(upper in frame.temps) && !(upper in frame.mem)) {
        const m = this.callableOf(frame.inst.__fb, name);
        if (m) return this.callMethod(frame.inst, m, c, frame);
      }
      if (!path.length && (upper === "ADR" || upper === "REF") && c.args.length === 1 && c.args[0]!.value.k === "ref") return { __ptr: this.locate(c.args[0]!.value.ref, frame) };
      if (!path.length && upper === "__ISVALIDREF" && c.args[0]?.value.k === "ref") {
        const at = this.locate(c.args[0].value.ref, frame, true);
        const v = (at.obj as Struct)[at.key as string] ?? (at.obj as Value[])[at.key as number];
        return isPointer(v) && !!v.ref;
      }
    }
    const lastSeg = path[path.length - 1];
    if (lastSeg && "member" in lastSeg) {
      const base = this.read({ ...c.callee, path: path.slice(0, -1) }, frame);
      if (isInstance(base) && !base.std) {
        const m = this.callableOf(base.__fb, lastSeg.member);
        if (m) return this.callMethod(base, m, c, frame);
      }
    }
    // FB instance call: #inst(...), "Inst_DB"(...), #inst.sub(...)
    if (c.callee.root.kind !== "ident" || c.callee.path.length || (frame && (upper in frame.mem || upper in frame.temps))) {
      const target = c.callee.root.kind === "global" && !c.callee.path.length ? this.index.global(name) : undefined;
      // a stubbed FC, or a block the workspace does not have, called by its name
      const stubbed = c.callee.root.kind === "global" && !c.callee.path.length ? this.stubOf(name) : undefined;
      if (stubbed && (!target || target.block?.kind === "FC")) return this.callStub(name, c, frame, stubbed);
      if (target?.block?.kind === "FC") return this.callFc(target.block, c, frame);
      if (target?.kind === "OBJECT" && !stubbed) throw this.objectError(name);
      // instruction called on typed instance data: #t.TON(...) on an IEC_TIMER, #c.CTU(...) on an IEC_COUNTER
      const last = c.callee.path[c.callee.path.length - 1];
      if (last && "member" in last) {
        const base = this.read({ ...c.callee, path: c.callee.path.slice(0, -1) }, frame);
        const method = last.member.toUpperCase();
        if (isInstance(base) && base.std && STANDARD_BY_NAME.get(base.__fb.toUpperCase())?.methods?.includes(method)) {
          this.bindInputs(base.mem, null, c.args, frame);
          this.stdStep(base, method);
          this.bindOutputs(base.mem, null, c.args, frame);
          return undefined;
        }
      }
      const inst = this.read(c.callee, frame);
      if (!isInstance(inst)) {
        const d = this.declOf(c.callee, frame);
        const type = (d?.typeRef ?? d?.type)?.replace(/^"|"$/g, "");
        if (type && !this.index.global(type)?.block && !d?.members?.length) throw new SimError(`${name} (${type}) is not simulated: ${NOT_SIMULATED}; a test can stand in for it with stubs: { ${type}: {} }`, frame?.block.name, c.callee.start);
        throw new SimError(`${name} is not a function block instance`, frame?.block.name, c.callee.start);
      }
      this.runInstance(inst, c.args, frame);
      return undefined;
    }
    const stubbed = path.length ? undefined : this.stubOf(name);
    if (stubbed) return this.callStub(name, c, frame, stubbed);
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
        case "MUX": {
          // IN<K> by name (in any order) or the K-th after K; INELSE when K selects none
          const k = n(named("K", 0));
          const byName = c.args.some((a) => a.name);
          const inputs = byName ? c.args.filter((a) => /^IN\d+$/i.test(a.name ?? "")).length : c.args.length - 1;
          const at = byName ? c.args.findIndex((a) => a.name?.toUpperCase() === `IN${k}`) : Number.isInteger(k) && k >= 0 && k < inputs ? 1 + k : -1;
          const other = c.args.findIndex((a) => a.name?.toUpperCase() === "INELSE");
          if (at >= 0 || other >= 0) return args[at >= 0 ? at : other];
          throw new SimError(`MUX: K = ${k} selects no input (IN0..IN${inputs - 1}) and there is no INELSE`, frame?.block.name, c.callee.start);
        }
        case "TRUNC":
          return Math.trunc(n(args[0]));
        case "ROUND":
          return roundHalfEven(n(args[0]));
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
        case "CONCAT": {
          // IN1, IN2, ... in the order of their numbers, however the call lists them
          const order = c.args.map((a, i) => ({ i, k: Number(/^IN(\d+)$/i.exec(a.name ?? "")?.[1] ?? i + 1) }));
          return order.sort((x, y) => x.k - y.k).map((x) => String(args[x.i])).join("");
        }
        case "LEFT":
          return String(named("IN", 0)).slice(0, Math.max(0, n(named("L", 1))));
        case "RIGHT": {
          const l = n(named("L", 1));
          return l > 0 ? String(named("IN", 0)).slice(-l) : "";
        }
        case "MID":
          return String(named("IN", 0)).substr(n(named("P", 2)) - 1, n(named("L", 1)));
        case "FIND":
          return String(named("IN1", 0)).indexOf(String(named("IN2", 1))) + 1;
        case "SHL":
        case "SHR": {
          // in the width of IN's type (JavaScript shifts 32 bits and takes the count modulo 32)
          const v = n(named("IN", 0));
          const by = n(named("N", 1));
          if (!Number.isInteger(v) || !Number.isInteger(by) || by < 0) throw new SimError(`${upper}: IN and N must be integers (N at least 0)`, frame?.block.name, c.callee.start);
          const count = BigInt(Math.min(by, 64)); // every bit is gone after 64, whatever the width
          const shifted = upper === "SHL" ? BigInt(v) << count : BigInt(v) >> count;
          // cut to IN's width before it becomes a number: LWORD 1 shifted left by 64 is 0, not 2^64
          const input = c.args.find((a) => a.name?.toUpperCase() === "IN") ?? c.args.find((a) => !a.name);
          const d = input ? this.staticDecl(input.value, frame) : undefined;
          const w = d && !d.isArray ? INT_WIDTH[(d.typeRef ?? d.type).replace(/^"|"$/g, "").toUpperCase()] : undefined;
          return w ? wrapBig(shifted, w) : exactInteger(shifted);
        }
      }
      const to = upper.split("_TO_")[1] ?? "";
      if (/^(BOOL)$/.test(to)) return !!args[0] && args[0] !== 0;
      if (REAL_TYPES.test(to)) return Number(args[0]);
      if (STRING_TYPES.test(to)) return String(args[0]);
      // the value of the target type: WORD_TO_INT(16#FFFF) is -1 also inside an expression
      if (INT_TYPES.test(to)) return wrapInteger(typeof args[0] === "boolean" ? (args[0] ? 1 : 0) : roundHalfEven(Number(args[0])), { type: to, isArray: false });
      if (TIME_TYPES.test(to)) return typeof args[0] === "boolean" ? (args[0] ? 1 : 0) : roundHalfEven(Number(args[0]));
      throw new SimError(`function ${name} is not supported by the simulator`, frame?.block.name, c.callee.start);
    }
    const g = this.index.global(name);
    if (g?.block?.kind === "FC") return this.callFc(g.block, c, frame);
    if (SYSTEM_FUNCTIONS.has(upper)) {
      try {
        return this.systemCall(upper, c, frame);
      } catch (e) {
        if (e instanceof Unsupported) throw new SimError(`${upper}: ${e.message}`, frame?.block.name, c.callee.start);
        throw e;
      }
    }
    throw new SimError(`${name} is not simulated: ${NOT_SIMULATED}; a test can stand in for it with stubs: { ${name}: {} }`, frame?.block.name, c.callee.start);
  }

  /**
   * A system instruction the simulator runs (SYSTEM_FUNCTIONS), as the TIA Portal help describes it for the
   * S7-1200/1500. What it does not model the way the PLC would stops the call with an Unsupported message.
   */
  private systemCall(upper: string, c: Extract<Expr, { k: "call" }>, frame: Frame | null): Value {
    // SCL names every argument or none: then they follow the order of the parameters
    const named = c.args.some((a) => a.name);
    const argOf = (param: string, pos: number): Arg => {
      const a = named ? c.args.find((x) => x.name?.toUpperCase() === param) : c.args[pos];
      if (!a) throw new Unsupported(`${param} is missing`);
      return a;
    };
    const input = (param: string, pos: number) => this.eval(argOf(param, pos).value, frame);
    const number = (param: string, pos: number) => Number(input(param, pos));
    const variable = (param: string, pos: number): LRef => {
      const a = argOf(param, pos);
      if (a.value.k !== "ref") throw new Unsupported(`${param} must be a variable`);
      return a.value.ref;
    };
    const typeOf = (e: Expr) => {
      const d = e.k === "ref" ? this.declOf(e.ref, frame) : this.staticDecl(e, frame);
      return (d?.typeRef ?? d?.type)?.replace(/^"|"$/g, "").toUpperCase();
    };
    /** The kind and value (ms) of a time argument: a DTL by its members, the others by their declared type. */
    const timeOf = (param: string, pos: number): { kind: TimeKind | undefined; ms: number } => {
      const e = argOf(param, pos).value;
      const v = this.eval(e, frame);
      if (v && typeof v === "object" && !isArray(v) && "YEAR" in v) return { kind: "DTL", ms: msOfDtl(v as Struct, param) };
      return { kind: timeKindOfType(typeOf(e)), ms: Number(v) };
    };
    type Place = { obj: Struct | Value[]; key: string | number };
    type Declared = Pick<VarDecl, "type" | "typeRef" | "isArray" | "members">;
    const get = (at: Place): Value => (at.obj as Record<string | number, Value>)[at.key];
    // as write() stores a value, into a place that a VARIANT names
    const put = (at: Place, v: Value, d: Declared | undefined) =>
      void ((at.obj as Record<string | number, Value>)[at.key] = typeof v === "number" ? wrapInteger(v, d) : typeof v === "string" ? fitString(v, d) : copyValue(v));
    /** Where an operand is and its declared type; for a VARIANT parameter, the caller's variable it is bound to. */
    const bound = (param: string, pos: number): { at: Place; decl: Declared | undefined } => {
      const e = argOf(param, pos).value;
      if (e.k !== "ref") return { at: { obj: [this.eval(e, frame)], key: 0 }, decl: this.staticDecl(e, frame) };
      const raw = this.locate(e.ref, frame, true);
      const v = get(raw);
      if (isPointer(v) && v.variant) return { at: this.placeOf(v), decl: v.variant.decl };
      const decl = this.declOf(e.ref, frame);
      if (decl && /^variant$/i.test(decl.type.trim())) throw new Unsupported(`${param} is a VARIANT that points nowhere (the call gave it no variable)`);
      return { at: this.locate(e.ref, frame), decl };
    };
    /** VariantGet, VariantPut and MOVE_BLK_VARIANT copy between one data type only. */
    const sameType = (a: Declared | undefined, b: Declared | undefined, what: [string, string]) => {
      if (!a || !b) throw new Unsupported(`the data type of ${!a ? what[0] : what[1]} is not known here`);
      if (typeTag(a.type) !== typeTag(b.type)) throw new Unsupported(`${what[0]} is ${a.type} and ${what[1]} is ${b.type}: it copies between one data type only`);
    };
    /** The element an IN or OUT of MOVE_BLK / FILL_BLK names (#a[2]): its array and position there. */
    const element = (param: string, pos: number) => {
      const at = this.locate(variable(param, pos), frame);
      if (!Array.isArray(at.obj)) throw new Unsupported(`${param} must be an element of an array, such as #buffer[0]`);
      return { items: at.obj, from: at.key as number };
    };
    switch (upper) {
      case "SWAP": {
        // a WORD, DWORD or LWORD; an integer of that width is converted implicitly, bit for bit (an Int tag of a CAN frame)
        const e = argOf("IN", 0).value;
        const last = e.k === "ref" ? e.ref.path[e.ref.path.length - 1] : undefined;
        const bits = last && "slice" in last ? SLICE_WIDTH[last.slice] : INT_WIDTH[typeOf(e) ?? ""]?.[0];
        if (!bits || bits < 16) throw new Unsupported(`IN must be 16, 32 or 64 bits wide (a WORD, DWORD, LWORD or an integer of that width)${typeOf(e) ? `; it is ${typeOf(e)}` : "; its type is not known here: assign it to one first"}`);
        return swapBytes(Number(this.eval(e, frame)), bits);
      }
      case "COUNTOFELEMENTS": {
        // every element of every dimension; an ARRAY of BOOL also counts the fill bits of its last byte, which rung does not model
        const v = input("OPERAND", 0);
        if (!isArray(v)) throw new Unsupported("OPERAND is not an array");
        const count = (a: ArrayValue): number => (a.items.length && isArray(a.items[0]!) ? a.items.length * count(a.items[0] as ArrayValue) : a.items.length);
        const leaf = (a: Value): Value => (isArray(a) ? leaf(a.items[0]) : a);
        if (typeof leaf(v) === "boolean") throw new Unsupported("an ARRAY of BOOL is counted with its fill bits on the PLC; that is not simulated");
        return count(v);
      }
      case "RD_SYS_T":
      case "RD_LOC_T": {
        // rung's clock has no time zone and no daylight saving time: system and local time are the same
        const out = variable("OUT", 0);
        const now = this.clockStart + this.time;
        const kind = timeKindOfType(typeOf({ k: "ref", ref: out }));
        if (kind === "DTL") this.write(out, { ...dtlOf(now) }, frame);
        else if (kind === "DT" || kind === "LDT") this.write(out, now, frame);
        else throw new Unsupported("OUT must be a DTL, DT or LDT variable");
        return 0;
      }
      case "RUNTIME": {
        // seconds of virtual time since the last call with this MEM; code runs in no time, so 0 within one cycle
        const mem = variable("MEM", 0);
        const before = Number(this.read(mem, frame) ?? 0);
        this.write(mem, this.time / 1000, frame);
        return (this.time - before * 1000) / 1000; // in milliseconds first: 0.35 - 0.1 is not 0.25 in floating point
      }
      case "T_DIFF": {
        const a = timeOf("IN1", 0);
        const b = timeOf("IN2", 1);
        if (!a.kind || a.kind !== b.kind) throw new Unsupported(`IN1 and IN2 must be variables of one kind (DTL, DT, LDT, TOD or LTOD)${a.kind || b.kind ? `: they are ${a.kind ?? "?"} and ${b.kind ?? "?"}` : ""}`);
        return timeDiff(a.kind, a.ms, b.ms);
      }
      case "T_ADD":
      case "T_SUB": {
        const a = timeOf("IN1", 0);
        const by = argOf("IN2", 1).value;
        const byKind = timeKindOfType(typeOf(by));
        if (byKind && byKind !== "TIME" && byKind !== "LTIME") throw new Unsupported(`IN2 is ${byKind}: it must be a duration (TIME or LTIME)`);
        if (!a.kind) throw new Unsupported("IN1 must be a variable of a time type (TIME, LTIME, TOD, LTOD, DT, LDT or DTL)");
        const r = timeShift(a.kind, a.ms, Number(this.eval(by, frame)), upper === "T_SUB");
        return a.kind === "DTL" ? { ...dtlOf(r) } : r;
      }
      case "IS_ARRAY":
        return isArray(input("OPERAND", 0));
      case "LOWER_BOUND":
      case "UPPER_BOUND": {
        let arr = input("ARR", 0);
        const dim = number("DIM", 1);
        if (!isArray(arr)) throw new Unsupported("ARR is not an array");
        if (!Number.isInteger(dim) || dim < 1) throw new Unsupported(`DIM ${dim} is not a dimension (1 is the first)`);
        for (let d = 1; d < dim; d++) {
          const inner: Value = arr.items[0];
          if (!isArray(inner)) throw new Unsupported(`DIM ${dim}: the array has ${d} dimension${d > 1 ? "s" : ""}`);
          arr = inner;
        }
        return upper === "LOWER_BOUND" ? arr.lo : arr.lo + arr.items.length - 1;
      }
      case "MOVE_BLK":
      case "UMOVE_BLK":
      case "FILL_BLK":
      case "UFILL_BLK": {
        const count = number("COUNT", 1);
        if (!Number.isInteger(count) || count < 0) throw new Unsupported(`COUNT ${count} is not a number of elements`);
        const to = element("OUT", 2);
        const past = (p: string, at: { items: Value[]; from: number }) => {
          if (at.from + count > at.items.length) throw new Unsupported(`COUNT ${count} from ${p} runs past the end of its array (${at.items.length - at.from} elements from there)`);
        };
        past("OUT", to);
        let values: Value[];
        if (upper.endsWith("FILL_BLK")) {
          const v = input("IN", 0);
          values = Array.from({ length: count }, () => copyValue(v));
        } else {
          const from = element("IN", 0);
          past("IN", from);
          if (from.items === to.items && from.from < to.from + count && to.from < from.from + count && count) throw new Unsupported("IN and OUT overlap in one array: an overlapping copy is not simulated");
          values = from.items.slice(from.from, from.from + count).map(copyValue);
        }
        values.forEach((v, k) => (to.items[to.from + k] = v));
        return undefined;
      }
      case "VAL_STRG": {
        const e = argOf("IN", 0).value;
        const kind = this.kindOf(e, frame);
        if (kind === "unknown") throw new Unsupported("IN must be a variable of an integer or floating-point type");
        const raw = Number(this.eval(e, frame));
        // a REAL is single precision on the PLC: 12.345 is 12.3450003 there, and rounds up
        const text = valStrg(typeOf(e) === "REAL" ? Math.fround(raw) : raw, kind === "int", number("SIZE", 1), number("PREC", 2), number("FORMAT", 3));
        const p = number("P", 4);
        const out = variable("OUT", 5);
        const old = String(this.read(out, frame) ?? "");
        // the text goes into OUT from position P; what is already at P and after is not modelled
        if (!Number.isInteger(p) || p < 1 || old.length !== p - 1)
          throw new Unsupported(old.length > p - 1 ? `OUT already has characters at P ${p} and after: clear it first (writing into the middle of a string is not simulated)` : `P ${p} is past the end of OUT (${old.length} characters)`);
        const max = Number(/\[\s*(\d+)\s*\]/.exec(this.declOf(out, frame)?.type ?? "")?.[1] ?? 254);
        if ((old + text).length > max) throw new Unsupported(`the result '${old + text}' does not fit OUT (${max} characters)`);
        this.write(out, old + text, frame);
        return undefined;
      }
      case "TYPEOF": {
        const { decl } = bound("OPERAND", 0);
        if (!decl) throw new Unsupported("the data type of OPERAND is not known here");
        if (decl.isArray) throw new Unsupported("OPERAND is an ARRAY: TypeOfElements gives the data type of its elements");
        return typeTag(decl.type);
      }
      case "TYPEOFELEMENTS": {
        const { decl } = bound("OPERAND", 0);
        const shape = decl?.isArray ? splitArrayType(decl.type) : undefined;
        if (!shape) throw new Unsupported(decl ? `OPERAND is not an ARRAY (it is ${decl.type})` : "the data type of OPERAND is not known here");
        return typeTag(shape.element);
      }
      case "VARIANTGET": {
        // the value of the variable SRC points to, into DST
        const src = bound("SRC", 0);
        const dst = variable("DST", 1);
        sameType(src.decl, this.declOf(dst, frame), ["SRC", "DST"]);
        this.write(dst, get(src.at), frame);
        return undefined;
      }
      case "VARIANTPUT": {
        // SRC into the variable DST points to
        const e = argOf("SRC", 0).value;
        const dst = bound("DST", 1);
        sameType(e.k === "ref" ? this.declOf(e.ref, frame) : this.staticDecl(e, frame), dst.decl, ["SRC", "DST"]);
        put(dst.at, this.eval(e, frame), dst.decl);
        return undefined;
      }
      case "MOVE_BLK_VARIANT": {
        // SRC_INDEX and DEST_INDEX count from 0, whatever the arrays' low bounds; a variable that is no array is one element
        const count = number("COUNT", 1);
        const si = number("SRC_INDEX", 2);
        const di = number("DEST_INDEX", 3);
        const elements = (b: { at: Place; decl: Declared | undefined }, p: string) => {
          const v = get(b.at);
          if (!isArray(v)) return { items: [v], decl: b.decl, array: false };
          if (v.items.length && isArray(v.items[0]!)) throw new Unsupported(`${p} is a multi-dimensional ARRAY: not simulated`);
          const shape = b.decl ? splitArrayType(b.decl.type) : undefined;
          return { items: v.items, decl: shape ? { type: shape.element, isArray: false } : undefined, array: true };
        };
        const src = elements(bound("SRC", 0), "SRC");
        const target = bound("DEST", 4);
        const dst = elements(target, "DEST");
        sameType(src.decl, dst.decl, ["an element of SRC", "an element of DEST"]);
        for (const [p, n] of [["COUNT", count], ["SRC_INDEX", si], ["DEST_INDEX", di]] as const)
          if (!Number.isInteger(n) || n < 0) throw new Unsupported(`${p} ${n} is not a whole number of 0 or more`);
        if (si + count > src.items.length) throw new Unsupported(`SRC_INDEX ${si} and COUNT ${count} run past SRC (${src.items.length} element${src.items.length === 1 ? "" : "s"})`);
        if (di + count > dst.items.length) throw new Unsupported(`DEST_INDEX ${di} and COUNT ${count} run past DEST (${dst.items.length} element${dst.items.length === 1 ? "" : "s"})`);
        if (src.items === dst.items && si < di + count && di < si + count && count) throw new Unsupported("SRC and DEST overlap in one array: an overlapping copy is not simulated");
        const values = src.items.slice(si, si + count).map(copyValue);
        if (dst.array) values.forEach((v, k) => (dst.items[di + k] = v));
        else if (count) put(target.at, values[0], target.decl);
        return 0;
      }
      case "IS_NULL":
      case "NOT_NULL": {
        // a REF_TO or VARIANT that points nowhere: a REF_TO nobody assigned, a VARIANT the call gave no variable
        const e = argOf("OPERAND", 0).value;
        const d = e.k === "ref" ? this.declOf(e.ref, frame) : undefined;
        if (e.k !== "ref" || !d || !/^(variant$|ref_to\b)/i.test(d.type.trim())) throw new Unsupported("OPERAND must be a REF_TO or VARIANT variable");
        const none = !isPointer(get(this.locate(e.ref, frame, true)));
        return upper === "IS_NULL" ? none : !none;
      }
      case "DELETE":
        return deleteChars(String(input("IN", 0)), number("L", 1), number("P", 2));
      case "INSERT":
        return insertChars(String(input("IN1", 0)), String(input("IN2", 1)), number("P", 2));
      case "REPLACE":
        return replaceChars(String(input("IN1", 0)), String(input("IN2", 1)), number("L", 2), number("P", 3));
    }
    throw new SimError(`${upper} is not simulated: ${NOT_SIMULATED}`, frame?.block.name, c.callee.start);
  }

  /** Guards against endless recursion; JS would otherwise die with a RangeError. */
  private enter<T>(b: BlockModel, run: () => T): T {
    if (++this.depth > MAX_CALL_DEPTH) {
      this.depth--;
      throw new SimError(`call depth limit (${MAX_CALL_DEPTH}) exceeded in ${b.name} (endless recursion?)`, b.name);
    }
    try {
      return run();
    } finally {
      this.depth--;
    }
  }

  /** Executes a block body: RETURN ends this call only; EXIT/CONTINUE outside a loop are errors. */
  private runBody(b: BlockModel, frame: Frame, accessor?: "get" | "set") {
    if (b.stl) return this.runStlBody(b, frame);
    try {
      this.exec(this.body(b, accessor), frame);
    } catch (e) {
      if (e instanceof Return) return;
      if (e instanceof Exit || e instanceof Continue) throw new SimError(`${e instanceof Exit ? "EXIT" : "CONTINUE"} outside of a loop in ${b.name}`, b.name);
      if (e instanceof Goto) throw new SimError(`GOTO ${e.label}: ${b.name} has no label ${e.label}: in a statement list around the GOTO`, b.name, e.at);
      throw e;
    }
  }

  /** An STL block (stl.ts): parsed once, and refused before it runs when it uses instructions outside the subset. */
  private runStlBody(b: BlockModel, frame: Frame) {
    const p = this.stlProgram(b, "", () => parseStl(this.index.docs.get(this.uriOf(b))!.text, b.bodyStart ?? b.start, b.end));
    if (p.missing.length) throw new SimError(`"${b.name}" uses STL instructions the simulator does not run yet: ${p.missing.join(", ")}`, b.name);
    runStl(p, this.stlHost(b, frame, (message, offset) => new SimError(message, b.name, offset)));
  }

  /** STL network `n` of a SimaticML block (its translation calls __RUNG_STL(n)), in the block's own frame. */
  private runStlNetwork(frame: Frame, n: number) {
    const b = frame.block;
    const net = b.stlNetworks?.[n];
    if (!net) throw new SimError(`${b.name} has no STL network ${n}`, b.name);
    const p = this.stlProgram(b, String(n), () => parseStl(net.source, 0, net.source.length));
    const fail = (message: string) => new SimError(`STL network ${net.network}: ${message}`, b.name);
    if (p.missing.length) throw fail(`uses STL instructions the simulator does not run yet: ${p.missing.join(", ")}`);
    const previous = frame.stl;
    // SCL/LAD compiler code is not executed as STL, so its ACCUs and RLO are unknown; a new string starts with /FC = 0.
    const state = previous?.network === net.network - 1 ? previous.state : stlState(net.network === 1);
    frame.stl = { network: net.network, state };
    const next = b.stlNetworks?.[n + 1];
    // a string still open at the end of the block ends with it, as in an .awl block
    const goesOn = net.last || next?.network === net.network + 1;
    const ended = runStl(p, this.stlHost(b, frame, fail), {
      state,
      endOpen: goesOn ? undefined : "the logic string is still open at the end of the network and cannot continue in STL: not simulated",
    });
    if (ended) throw new Return();
  }

  /** The parsed STL of a block (key: "" for an .awl body, the network for a SimaticML block), with #RET_VAL as the FC's return value. */
  private stlProgram(b: BlockModel, key: string, parse: () => StlProgram): StlProgram {
    let byKey = this.stlPrograms.get(b);
    if (!byKey) this.stlPrograms.set(b, (byKey = new Map()));
    let p = byKey.get(key);
    if (!p) {
      p = parse();
      if (b.returnType && !b.vars.some((v) => v.name.toUpperCase() === "RET_VAL")) {
        const own = (r: LRef): LRef => (r.root.kind === "local" && r.root.name.toUpperCase() === "RET_VAL" ? { ...r, root: { kind: "local", name: b.name } } : r);
        for (const c of p.code) {
          if (c.operand.kind === "var") c.operand.ref = own(c.operand.ref);
          if (c.operand.kind === "call") for (const q of c.operand.call.params) if (q.value.k === "ref") q.value = { ...q.value, ref: own(q.value.ref) };
        }
      }
      byKey.set(key, p);
    }
    return p;
  }

  /**
   * A CALL of STL through the normal call path, so stubs stand in too. STL writes every parameter with :=; the
   * callee's interface says which are outputs (a block of the workspace or the catalogue); for a type nothing
   * describes they are inputs. RET_VAL := #x takes an FC's return value.
   */
  private stlCall(sc: StlCall, frame: Frame, at: number) {
    const callee: LRef = sc.instance ?? { root: { kind: "global", name: sc.block! }, path: [], start: at };
    const d = sc.instance && !sc.block ? this.declOf(sc.instance, frame) : undefined;
    const type = (sc.block ?? d?.typeRef ?? d?.type)?.replace(/^"|"$/g, "");
    const b = type ? this.index.global(type)?.block : undefined;
    const std = type ? STANDARD_BY_NAME.get(type.toUpperCase()) : undefined;
    const output = (n: string) => {
      const u = n.toUpperCase();
      const v = b?.vars.find((x) => x.name.toUpperCase() === u);
      return v ? v.section === "Output" : std?.params.find((q) => q.name.toUpperCase() === u)?.dir === "out";
    };
    const args: Arg[] = [];
    let ret: LRef | undefined;
    for (const q of sc.params) {
      const isRet = q.name.toUpperCase() === "RET_VAL";
      if ((isRet || output(q.name)) && q.value.k !== "ref") throw new SimError(`CALL: ${q.name} is an output and needs a variable`, frame.block.name, at);
      if (isRet) ret = (q.value as Extract<Expr, { k: "ref" }>).ref;
      else args.push({ name: q.name, ...(output(q.name) ? { out: true } : {}), value: q.value });
    }
    const r = this.call({ k: "call", callee, args }, frame);
    if (ret) this.write(ret, r, frame);
  }

  private stlHost(b: BlockModel, frame: Frame, error: (message: string, offset: number) => SimError): StlHost {
    const at = (ref: LRef) => `${ref.root.kind === "global" ? `"${ref.root.name}"` : ref.root.name}${JSON.stringify(ref.path)}`.toUpperCase();
    return {
      read: (ref) => this.read(ref, frame),
      write: (ref, v) => this.write(ref, v, frame),
      typeOf: (ref) => {
        const d = this.declOf(ref, frame);
        return d && !d.isArray && !d.members?.length ? (d.typeRef ?? d.type).replace(/^"|"$/g, "").toUpperCase() : undefined;
      },
      tagAt: (address) => {
        const a = parseAbsolute(address)?.address;
        const g = a ? this.index.allGlobals().find((s) => s.tag?.address && parseAbsolute(s.tag.address)?.address === a) : undefined;
        return g ? { root: { kind: "global", name: g.name }, path: [], start: 0 } : undefined;
      },
      now: () => this.time,
      timer: (ref) => {
        let t = this.s5timers.get(at(ref));
        if (!t) this.s5timers.set(at(ref), (t = { running: false, start: 0, preset: 0, last: false }));
        return t;
      },
      call: (c, offset) => this.stlCall(c, frame, offset),
      tick: (offset) => this.tick(frame, offset),
      fail: (message, offset) => {
        throw error(message, offset);
      },
    };
  }

  private callFc(b: BlockModel, c: Extract<Expr, { k: "call" }>, caller: Frame | null, capture?: Struct): Value {
    return this.enter(b, () => {
      const mem: Struct = this.structOf(b.vars.filter((v) => v.section === "Input" || v.section === "Output" || v.section === "InOut"), b);
      const temps: Struct = this.structOf(b.vars.filter((v) => v.section === "Temp"), b);
      Object.assign(temps, this.constants(b));
      for (const t of b.ladTemps ?? []) temps[t.toUpperCase()] = false;
      this.bindInputs(mem, b, c.args, caller);
      const frame: Frame = { block: b, mem, temps };
      temps[b.name.toUpperCase()] = b.returnType && !/^void$/i.test(b.returnType) ? this.defaultValue({ type: b.returnType, typeRef: b.returnType, isArray: false }, b) : undefined;
      this.runBody(b, frame);
      this.bindOutputs(mem, b, c.args, caller);
      if (capture) Object.assign(capture, mem);
      return temps[b.name.toUpperCase()];
    });
  }

  private bindInputs(mem: Struct, b: BlockModel | null, args: { name?: string; out?: boolean; value: Expr }[], caller: Frame | null) {
    const params = b ? b.vars.filter((v) => v.section === "Input" || v.section === "InOut") : [];
    args.forEach((a, i) => {
      // a VARIANT or ARRAY[*] parameter, an output one too, is bound to the caller's variable before the call
      const byRef = (k: string | undefined) => {
        const d = k ? b?.vars.find((v) => v.name.toUpperCase() === k) : undefined;
        return !!d && (/^variant$/i.test(d.type.trim()) || !!splitArrayType(d.type)?.dims.some((x) => x.trim() === "*"));
      };
      if (a.out) {
        const k = a.name?.toUpperCase();
        if (byRef(k)) mem[k!] = this.bindReference(a.value, caller);
        return;
      }
      const key = (a.name ?? params[i]?.name)?.toUpperCase();
      if (!key) throw new SimError("positional argument without matching parameter", caller?.block.name);
      if (!(key in mem)) throw new SimError(`${a.name ?? key} is not an input of ${b?.name ?? "the block"}`, caller?.block.name);
      if (byRef(key)) {
        mem[key] = this.bindReference(a.value, caller);
        return;
      }
      // an input gets a copy; an IN_OUT is the caller's variable itself (by reference)
      const inOut = b?.vars.some((v) => v.section === "InOut" && v.name.toUpperCase() === key);
      const value = this.eval(a.value, caller);
      mem[key] = inOut ? value : copyValue(value);
    });
  }

  /**
   * What a VARIANT or ARRAY[*] parameter holds: where the caller's variable is and its declared type (TypeOf reads
   * it). A parameter of the caller passed on is passed as it is; a constant or expression gets a place of its own.
   */
  /** Where a pointer points: a VARIANT's variable found again from its root, else the place it was made for. */
  private placeOf(p: Pointer): { obj: Struct | Value[]; key: string | number } {
    return p.via ? this.locate(p.via.ref, p.via.frame as Frame | null) : p.__ptr;
  }

  private bindReference(e: Expr, caller: Frame | null): Pointer {
    if (e.k === "ref") {
      // the array indices evaluated once, as the PLC evaluates an actual parameter once (an index may call an FC)
      const ref = { ...e.ref, path: e.ref.path.map((s) => ("index" in s ? { index: s.index.map((x): Expr => ({ k: "lit", value: Number(this.eval(x, caller)), type: "int" })) } : s)) };
      const at = this.locate(ref, caller, true);
      const raw = (at.obj as Struct)[at.key as string] ?? (at.obj as Value[])[at.key as number];
      if (isPointer(raw) && raw.variant) return raw;
      const decl = this.declOf(e.ref, caller);
      // found again from its root at every use, with those indices: an assignment to the structure or array around
      // it ("DB".point := "DB".other) replaces the storage, not the variable
      return { __ptr: this.locate(ref, caller), ref: true, variant: decl ? { decl } : {}, via: { ref, frame: caller } };
    }
    const decl = this.staticDecl(e, caller);
    return { __ptr: { obj: [this.eval(e, caller)], key: 0 }, ref: true, variant: decl ? { decl } : {} };
  }

  private bindOutputs(mem: Struct, b: BlockModel | null, args: { name?: string; out?: boolean; value: Expr }[], caller: Frame | null) {
    const params = b ? b.vars.filter((v) => v.section === "Input" || v.section === "InOut") : [];
    args.forEach((a, i) => {
      const key = (a.name ?? (a.out ? undefined : params[i]?.name))?.toUpperCase();
      if (!key) return;
      const bound = mem[key];
      if (isPointer(bound) && bound.variant) return; // a VARIANT or ARRAY[*] wrote into the caller's variable itself
      const isInOut = b?.vars.some((v) => v.section === "InOut" && v.name.toUpperCase() === key);
      if ((a.out || isInOut) && a.value.k === "ref") this.write(a.value.ref, mem[key], caller);
    });
  }

  /** Runs one call of an FB instance (user FB or standard FB). */
  runInstance(inst: Instance, args: { name?: string; out?: boolean; value: Expr }[] = [], caller: Frame | null = null) {
    if (inst.stub || this.stubOf(inst.__fb)) return this.runStub(inst, args, caller);
    if (inst.std) {
      this.bindInputs(inst.mem, null, args, caller);
      this.stdStep(inst);
      this.bindOutputs(inst.mem, null, args, caller);
      return;
    }
    const b = this.block(inst.__fb);
    this.enter(b, () => {
      this.bindInputs(inst.mem, b, args, caller);
      const temps = this.structOf(b.vars.filter((v) => v.section === "Temp"), b);
      Object.assign(temps, this.constants(b));
      for (const t of b.ladTemps ?? []) temps[t.toUpperCase()] = false;
      this.runBody(b, { block: b, mem: inst.mem, temps, inst });
      this.bindOutputs(inst.mem, b, args, caller);
    });
  }

  /** A METHOD of a user FB: its own inputs, outputs and locals for each call; the instance's variables shared. */
  private callMethod(inst: Instance, m: BlockModel, c: Extract<Expr, { k: "call" }>, caller: Frame | null): Value {
    return this.enter(m, () => {
      const own = this.structOf(m.vars, m);
      Object.assign(own, this.constants(m));
      this.bindInputs(own, m, c.args, caller);
      own[m.name.toUpperCase()] = m.returnType && !/^void$/i.test(m.returnType) ? this.defaultValue({ type: m.returnType, typeRef: m.returnType, isArray: false }, m) : undefined;
      this.runBody(m, { block: m, mem: inst.mem, temps: own, inst });
      this.bindOutputs(own, m, c.args, caller);
      return own[m.name.toUpperCase()];
    });
  }

  /**
   * A PROPERTY of a function block instance: fb.Speed, THIS^.Speed, or Speed inside the FB or its methods (where no
   * variable has the name). Reading it runs its GET, writing its SET.
   */
  private propertyAt(ref: LRef, frame: Frame | null): { inst: Instance; prop: BlockModel } | undefined {
    this.methodOf("", ""); // fills the table of methods and properties
    if (!this.hasProperties) return undefined;
    let inst: Instance | undefined;
    let name: string;
    const last = ref.path[ref.path.length - 1];
    if (!ref.path.length) {
      if (!frame?.inst || ref.root.kind !== "ident") return undefined;
      const u = ref.root.name.toUpperCase();
      if (u in frame.temps || u in frame.mem) return undefined;
      inst = frame.inst;
      name = ref.root.name;
    } else {
      if (!last || !("member" in last)) return undefined;
      const base = { ...ref, path: ref.path.slice(0, -1) };
      const first = base.path[0];
      if (ref.root.name.toUpperCase() === "THIS" && base.path.length === 1 && first && "deref" in first) inst = frame?.inst;
      else {
        let v: Value;
        try {
          v = this.read(base, frame);
        } catch {
          return undefined; // not an instance: the normal path reports what is wrong
        }
        if (!isInstance(v)) return undefined;
        inst = v;
      }
      name = last.member;
    }
    if (!inst) return undefined;
    const prop = this.methodOf(inst.__fb, name);
    return prop?.property ? { inst, prop } : undefined;
  }

  private runProperty(inst: Instance, prop: BlockModel, accessor: "get" | "set", value?: Value): Value {
    if (!prop.property?.[accessor])
      throw new SimError(`${prop.owner}.${prop.name} has no ${accessor.toUpperCase()}: it ${accessor === "set" ? "is read-only" : "can only be written"}`, prop.name);
    return this.enter(prop, () => {
      const own = this.structOf(prop.vars.filter((v) => !v.accessor || v.accessor === accessor), prop, accessor);
      Object.assign(own, this.constants(prop, accessor));
      const key = prop.name.toUpperCase();
      own[key] = accessor === "set" ? value : this.defaultValue({ type: prop.returnType ?? "INT", typeRef: prop.returnType, isArray: false }, prop);
      this.runBody(prop, { block: prop, mem: inst.mem, temps: own, inst, accessor }, accessor);
      return own[key];
    });
  }

  /** A METHOD to call: a PROPERTY of the same name is read or written, never called. */
  private callableOf(fb: string, name: string): BlockModel | undefined {
    const m = this.methodOf(fb, name);
    return m?.property ? undefined : m;
  }

  private hasProperties = false;
  private methods?: Map<string, BlockModel>;
  /** METHOD `name` of the function block `fb`. */
  private methodOf(fb: string, name: string): BlockModel | undefined {
    if (!this.methods) {
      this.methods = new Map();
      for (const g of this.index.allGlobals())
        if (g.block?.owner) {
          this.methods.set(`${g.block.owner}.${g.block.name}`.toUpperCase(), g.block);
          if (g.block.property) this.hasProperties = true;
        }
    }
    return this.methods.get(`${fb}.${name}`.toUpperCase());
  }

  /** One step of a standard FB; `method` is the instruction called on IEC_TIMER/IEC_COUNTER data. */
  private stdStep(inst: Instance, method?: string) {
    const m = inst.mem;
    const s = inst.std!;
    const now = this.time;
    // CTU and CTD on IEC_COUNTER data report through QU / QD instead of Q
    const setQ = (fallback: "QU" | "QD", v: boolean) => void ("Q" in m ? (m.Q = v) : (m[fallback] = v));
    const kind = (method ?? inst.__fb)
      .toUpperCase()
      .replace(/_(L?TIME)$/, "")
      .replace(/_(SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT)$/, "");
    switch (kind) {
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
        setQ("QU", (m.CV as number) >= (m.PV as number));
        s.prev = !!m.CU;
        break;
      case "CTD":
        if (m.LD) m.CV = m.PV;
        else if (m.CD && !s.prevD) m.CV = (m.CV as number) - 1;
        setQ("QD", (m.CV as number) <= 0);
        s.prevD = !!m.CD;
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
        throw new SimError(`${inst.__fb}${method ? `.${method}` : ""} is not simulated`);
    }
  }

  // ------------------------------------------------------------------ statements

  private exec(stmts: Stmt[], f: Frame) {
    for (let i = 0; i < stmts.length; i++) {
      try {
        this.stmt(stmts[i]!, f);
      } catch (e) {
        // GOTO: on after the label when it is in this list; the jump leaves every list inside it
        const to = e instanceof Goto ? stmts.findIndex((s) => s.k === "label" && s.name.toUpperCase() === e.label.toUpperCase()) : -1;
        if (to < 0) throw e;
        i = to;
      }
    }
  }

  /** Counts a statement or loop iteration against the per-call step budget. */
  private tick(f: Frame, at: number) {
    if (++this.steps > this.maxStepsPerCall) throw new SimError("step limit exceeded (endless loop?)", f.block.name, at);
  }

  private stmt(s: Stmt, f: Frame) {
    this.tick(f, s.at);
    try {
      switch (s.k) {
        case "empty":
          return;
        case "assign":
          return this.write(s.target, this.eval(s.value, f), f);
        case "bind": {
          const at = this.locate(s.target, f, true);
          (at.obj as Record<string | number, Value>)[at.key] = { __ptr: this.locate(s.source, f), ref: true };
          return;
        }
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
            this.tick(f, s.at);
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
            this.tick(f, s.at);
            try {
              this.exec(s.body, f);
            } catch (e) {
              if (e instanceof Exit) break;
              if (!(e instanceof Continue)) throw e;
            }
          }
          return;
        case "repeat":
          do {
            this.tick(f, s.at);
            try {
              this.exec(s.body, f);
            } catch (e) {
              if (e instanceof Exit) break;
              if (!(e instanceof Continue)) throw e;
            }
          } while (!this.eval(s.until, f));
          return;
        case "label":
          return;
        case "goto":
          throw new Goto(s.label, s.at);
        case "exit":
          throw new Exit();
        case "continue":
          throw new Continue();
        case "return":
          throw new Return();
      }
    } catch (e) {
      if (e instanceof SimError && e.offset === undefined) throw new SimError(e.message, e.block ?? f.block.name, s.at);
      throw e;
    }
  }

  /** Top-level call of a block from a test: FB instance or FC with argument values. */
  callBlock(target: Instance | string, inputs: Record<string, Value> = {}): { returnValue?: Value; outputs: Struct } {
    this.steps = 0;
    this.depth = 0;
    const lit = (v: Value): Expr => ({ k: "lit", value: v as never, type: typeof v === "boolean" ? "bool" : typeof v === "string" ? "string" : "real" });
    const args = Object.entries(inputs).map(([name, value]) => ({ name, value: lit(value) }));
    try {
      if (typeof target === "string") {
        const b = this.block(target);
        const call = { k: "call" as const, callee: { root: { kind: "global" as const, name: b.name }, path: [], start: 0 }, args };
        const mem: Struct = {};
        const r = this.callFc(b, call, null, mem);
        return { returnValue: r, outputs: mem };
      }
      this.runInstance(target, args);
      return { outputs: target.mem };
    } catch (e) {
      if (e instanceof RangeError) throw new SimError(`call depth exceeded (endless recursion?): ${e.message}`);
      throw e;
    }
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
