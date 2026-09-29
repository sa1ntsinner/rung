// SPDX-License-Identifier: BUSL-1.1
// Offline SCL simulator: executes FB/FC bodies with virtual time for unit tests.
// It models SCL semantics closely enough for logic tests; it is not a bit-exact TIA/PLCSIM emulation
// (integers wrap around like on an S7-1500; no system instructions beyond the IEC standard set).
import { STANDARD_BY_NAME, SYSTEM_TYPES, type BlockModel, type Member, type VarDecl, type WorkspaceIndex } from "@rung/lsp";
import { parseBody, SclSyntaxError, type Expr, type LRef, type Stmt } from "./ast.js";

export type Value = boolean | number | string | Struct | ArrayValue | Instance | Pointer | undefined;
/** ADR(x) (a POINTER TO), or with `ref` a bound REFERENCE TO: where the value lives. */
export interface Pointer {
  __ptr: { obj: Struct | Value[]; key: string | number };
  ref?: true;
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

type Decl = Pick<VarDecl, "type" | "typeRef" | "isArray" | "members" | "init">;
type Kind = "real" | "int" | "unknown";

interface Frame {
  block: BlockModel;
  /** Instance memory (FB) or call memory (FC). */
  mem: Struct;
  temps: Struct;
  /** The FB instance an FB body or one of its METHODs runs on (THIS). */
  inst?: Instance;
}

class Exit {}
class Continue {}
class Return {}

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

function sliceSet(base: Value, s: { slice: keyof typeof SLICE_WIDTH; n: number }, value: Value): number {
  const width = BigInt(SLICE_WIDTH[s.slice]);
  const shift = BigInt(s.n) * width;
  const mask = ((1n << width) - 1n) << shift;
  const v = BigInt(typeof base === "boolean" ? (base ? 1 : 0) : Math.trunc(Number(base ?? 0)));
  const nv = (BigInt(s.slice === "X" ? (value ? 1 : 0) : Math.trunc(Number(value ?? 0))) << shift) & mask;
  return Number((v & ~mask) | nv);
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
  const [bits, signed] = w;
  if (bits === 64 && !Number.isSafeInteger(v)) return v; // beyond a double's integers: no exact wrap
  const size = 2n ** BigInt(bits);
  let x = BigInt(v) % size;
  if (x < 0n) x += size;
  if (signed && x >= size / 2n) x -= size;
  return Number(x);
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
  readonly globals: Struct = {};
  private readonly bodies = new Map<string, Stmt[]>();
  private readonly consts = new Map<string, Struct>();
  private steps = 0;
  private depth = 0;

  constructor(
    private readonly index: WorkspaceIndex,
    private readonly maxStepsPerCall = 1_000_000,
  ) {}

  private block(name: string): BlockModel {
    const g = this.index.global(name);
    if (g?.kind === "OBJECT") throw this.objectError(name);
    if (!g?.block) throw new SimError(`Block "${name}" is not in the workspace (only SCL sources can be simulated)`);
    return g.block;
  }

  private objectError(name: string): SimError {
    return new SimError(`"${name}" is a technology object or a graphical/protected block; it is not simulated`);
  }

  private body(b: BlockModel): Stmt[] {
    const key = `${b.kind}:${b.owner ? b.owner.toUpperCase() + "." : ""}${b.name.toUpperCase()}`;
    let s = this.bodies.get(key);
    if (!s) {
      if (b.stl) throw new SimError(`"${b.name}" is an STL block; STL is not simulated`, b.name);
      if (b.xml) throw new SimError(`"${b.name}" is kept as SimaticML XML (FBD, GRAPH, or LAD whose texts SD would lose); it is not simulated`, b.name);
      if (b.ladUnsupported?.length) throw new SimError(`"${b.name}" uses LAD elements the simulator does not run yet: ${b.ladUnsupported.join("; ")}`, b.name);
      if (b.lad !== undefined) {
        try {
          s = parseBody(b.lad);
        } catch (e) {
          if (e instanceof SclSyntaxError) throw new SimError(`LAD block ${b.name} could not be translated for the simulator: ${e.message}`, b.name);
          throw e;
        }
        this.bodies.set(key, s);
        return s;
      }
      const g = this.index.global(b.name)!;
      const doc = this.index.docs.get(g.uri)!;
      const src = doc.code ?? doc.text; // TwinCAT XML: code with the markup blanked out
      const iec = doc.code !== undefined || /\.st$/i.test(doc.uri);
      try {
        s = b.bodyStart === undefined ? [] : parseBody(src, b.bodyStart, b.end, { iec });
      } catch (e) {
        if (e instanceof SclSyntaxError) throw new SimError(`Syntax error in ${b.name} (line ${doc.lines.position(e.offset).line + 1}): ${e.message}`, b.name, e.offset);
        throw e;
      }
      this.bodies.set(key, s);
    }
    return s;
  }

  /** 1-based source line of an offset in a block's file (for error messages). */
  lineOf(blockName: string, offset: number): number | undefined {
    const g = this.index.global(blockName);
    const doc = g ? this.index.docs.get(g.uri) : undefined;
    return doc ? doc.lines.position(offset).line + 1 : undefined;
  }

  // ------------------------------------------------------------------ values

  /** Constants of a block (VAR CONSTANT), evaluated once; used for array bounds and initial values. */
  private constants(scope: BlockModel | undefined): Struct {
    if (!scope) return {};
    const key = `${scope.kind}:${scope.name.toUpperCase()}`;
    let c = this.consts.get(key);
    if (!c) {
      c = {};
      this.consts.set(key, c);
      for (const v of scope.vars) if (v.section === "Constant" && !v.isArray && !v.members?.length) c[v.name.toUpperCase()] = this.defaultValue(v, scope);
    }
    return c;
  }

  private constFrame(scope: BlockModel | undefined): Frame {
    const block: BlockModel = scope ?? { kind: "FC", name: "", nameStart: 0, nameEnd: 0, start: 0, end: 0, vars: [], regions: [], refs: [] };
    const temps = { ...this.constants(scope) };
    // inside a GVL, its constants are also reachable qualified: ARRAY[0..GVL_Cfg.N_ITEMS - 1]
    if (scope?.kind === "GVL") temps[scope.name.toUpperCase()] = this.constants(scope);
    return { block, mem: {}, temps };
  }

  private constValue(text: string, scope: BlockModel | undefined): number {
    const t = text.trim();
    if (/^[-+]?\d+$/.test(t)) return Number(t);
    let v: Value;
    try {
      const [s] = parseBody(`#__c := ${t};`);
      v = s?.k === "assign" ? this.eval(s.value, this.constFrame(scope)) : undefined;
    } catch {
      v = undefined;
    }
    if (typeof v !== "number" || !Number.isInteger(v)) throw new SimError(`array bound ${t} is not a constant the simulator can evaluate (literals, block constants and GVL constants are supported)`, scope?.name);
    return v;
  }

  private bounds(dim: string, scope: BlockModel | undefined): [number, number] {
    const at = dim.indexOf("..");
    if (at < 0) {
      if (dim.trim() === "*") return [0, -1]; // Array[*] parameter: sized by the caller
      throw new SimError(`array dimension ${dim.trim()} is not a range`, scope?.name);
    }
    return [this.constValue(dim.slice(0, at), scope), this.constValue(dim.slice(at + 2), scope)];
  }

  defaultValue(decl: Decl, scope?: BlockModel): Value {
    if (decl.isArray) {
      const shape = splitArrayType(decl.type);
      if (!shape) return { __array: true, lo: 0, items: [] };
      const dims = shape.dims.map((d) => this.bounds(d, scope));
      // the element keeps the struct members / named type; only the outer `Array[..] of` is removed
      const element: Decl = { type: shape.element, typeRef: decl.typeRef, isArray: /^array\b/i.test(shape.element), members: decl.members };
      const build = (k: number): Value => {
        if (k === dims.length) return this.defaultValue(element, scope);
        const [lo, hi] = dims[k]!;
        return { __array: true, lo, items: Array.from({ length: Math.max(0, hi - lo + 1) }, () => build(k + 1)) };
      };
      return build(0);
    }
    if (decl.members?.length) return this.structOf(decl.members, scope);
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
      else if (sys) v = Object.fromEntries(sys.map((m) => [m.name.toUpperCase(), this.defaultValue({ type: m.type, typeRef: m.typeRef ?? m.type, isArray: !!m.isArray })]));
      else v = 0; // unknown elementary type (Variant, system types, …): treated as a number
    }
    if (decl.init !== undefined && !isInstance(v) && typeof v !== "object") {
      try {
        const [s] = parseBody(`#__init := ${decl.init};`);
        if (s?.k === "assign") v = this.eval(s.value, this.constFrame(scope));
      } catch {
        /* complex initializers (array lists) keep the default */
      }
    }
    return v;
  }

  private structOf(vars: VarDecl[], scope?: BlockModel): Struct {
    const s: Struct = {};
    for (const m of vars) s[m.name.toUpperCase()] = this.defaultValue(m, scope);
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
    if (b.kind !== "FB" && b.kind !== "PRG") throw new SimError(`"${fbName}" is ${b.kind}, not a function block`);
    return { __fb: b.name, mem: this.structOf(b.vars.filter((v) => v.section !== "Temp" && v.section !== "Constant"), b) };
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
      else if (g?.kind === "OBJECT") throw this.objectError(name);
      else throw new SimError(`"${name}" is not a data block or tag in the workspace`);
    }
    return { obj: this.globals, key };
  }

  /** DB start values from the BEGIN part (`cnt := 200;`, `T1.PT := T#2s;`) override declared defaults. */
  private applyStartValues(b: BlockModel, value: Value) {
    if (b.bodyStart === undefined) return;
    const stmts = this.body(b);
    if (!stmts.length) return;
    const mem = isInstance(value) ? value.mem : (value as Struct);
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
        ({ obj, key } = v.__ptr);
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
      if (isInstance(cur)) cur = cur.mem;
      if ("member" in seg) {
        if (typeof cur !== "object" || cur === null || isArray(cur)) throw new SimError(`${seg.member}: not a structure`, frame?.block.name, ref.start);
        obj = cur as Struct;
        key = seg.member.toUpperCase();
        if (!(key in obj)) throw new SimError(`${seg.member} is not a member`, frame?.block.name, ref.start);
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
    const { obj, key } = this.locate(ref, frame);
    return (obj as Struct)[key as string] ?? (obj as Value[])[key as number];
  }

  write(ref: LRef, value: Value, frame: Frame | null) {
    const last = ref.path[ref.path.length - 1];
    if (last && "slice" in last) {
      const base = { ...ref, path: ref.path.slice(0, -1) };
      this.write(base, sliceSet(this.read(base, frame), last, value), frame);
      return;
    }
    const { obj, key } = this.locate(ref, frame);
    (obj as Record<string | number, Value>)[key] = typeof value === "number" ? wrapInteger(value, this.declOf(ref, frame)) : value;
  }

  // ------------------------------------------------------------------ static types (REAL vs integer division)

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
      d = b.vars.find((x) => x.name.toUpperCase() === name);
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
      } else d = { type: seg.slice === "X" ? "Bool" : "DWord", isArray: false };
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
        if (/^(LEN|FIND)$/.test(upper)) return "int";
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
            return Math.trunc((l as number) / (r as number));
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
    const path = c.callee.path;
    // METHODs: fb.M(...), and inside the FB or one of its methods M(...) or THIS^.M(...)
    if (c.callee.root.kind === "ident") {
      const [p0, p1] = path;
      if (upper === "THIS" && p0 && "deref" in p0 && p1 && "member" in p1 && path.length === 2 && frame?.inst) {
        const m = this.methodOf(frame.inst.__fb, p1.member);
        if (!m) throw new SimError(`${frame.inst.__fb} has no METHOD ${p1.member}`, frame.block.name, c.callee.start);
        return this.callMethod(frame.inst, m, c, frame);
      }
      if (!path.length && frame?.inst && !(upper in frame.temps) && !(upper in frame.mem)) {
        const m = this.methodOf(frame.inst.__fb, name);
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
        const m = this.methodOf(base.__fb, lastSeg.member);
        if (m) return this.callMethod(base, m, c, frame);
      }
    }
    // FB instance call: #inst(...), "Inst_DB"(...), #inst.sub(...)
    if (c.callee.root.kind !== "ident" || c.callee.path.length || (frame && (upper in frame.mem || upper in frame.temps))) {
      const target = c.callee.root.kind === "global" && !c.callee.path.length ? this.index.global(name) : undefined;
      if (target?.block?.kind === "FC") return this.callFc(target.block, c, frame);
      if (target?.kind === "OBJECT") throw this.objectError(name);
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
        if (type && !this.index.global(type)?.block && !d?.members?.length) throw new SimError(`${name} (${type}) is not simulated: system and technology instructions are not part of the offline simulator`, frame?.block.name, c.callee.start);
        throw new SimError(`${name} is not a function block instance`, frame?.block.name, c.callee.start);
      }
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
      if (INT_TYPES.test(to) || TIME_TYPES.test(to)) return typeof args[0] === "boolean" ? (args[0] ? 1 : 0) : roundHalfEven(Number(args[0]));
      throw new SimError(`function ${name} is not supported by the simulator`, frame?.block.name, c.callee.start);
    }
    const g = this.index.global(name);
    if (g?.block?.kind === "FC") return this.callFc(g.block, c, frame);
    throw new SimError(`${name} is not a known function (system instructions are not simulated)`, frame?.block.name, c.callee.start);
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
  private runBody(b: BlockModel, frame: Frame) {
    try {
      this.exec(this.body(b), frame);
    } catch (e) {
      if (e instanceof Return) return;
      if (e instanceof Exit || e instanceof Continue) throw new SimError(`${e instanceof Exit ? "EXIT" : "CONTINUE"} outside of a loop in ${b.name}`, b.name);
      throw e;
    }
  }

  private callFc(b: BlockModel, c: Extract<Expr, { k: "call" }>, caller: Frame | null, capture?: Struct): Value {
    return this.enter(b, () => {
      const mem: Struct = this.structOf(b.vars.filter((v) => v.section === "Input" || v.section === "Output" || v.section === "InOut"), b);
      const temps: Struct = this.structOf(b.vars.filter((v) => v.section === "Temp"), b);
      Object.assign(temps, this.constants(b));
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
      if (a.out) return;
      const key = (a.name ?? params[i]?.name)?.toUpperCase();
      if (!key) throw new SimError("positional argument without matching parameter", caller?.block.name);
      if (!(key in mem)) throw new SimError(`${a.name ?? key} is not an input of ${b?.name ?? "the block"}`, caller?.block.name);
      mem[key] = this.eval(a.value, caller);
    });
  }

  private bindOutputs(mem: Struct, b: BlockModel | null, args: { name?: string; out?: boolean; value: Expr }[], caller: Frame | null) {
    const params = b ? b.vars.filter((v) => v.section === "Input" || v.section === "InOut") : [];
    args.forEach((a, i) => {
      const key = (a.name ?? (a.out ? undefined : params[i]?.name))?.toUpperCase();
      if (!key) return;
      const isInOut = b?.vars.some((v) => v.section === "InOut" && v.name.toUpperCase() === key);
      if ((a.out || isInOut) && a.value.k === "ref") this.write(a.value.ref, mem[key], caller);
    });
  }

  /** Runs one call of an FB instance (user FB or standard FB). */
  runInstance(inst: Instance, args: { name?: string; out?: boolean; value: Expr }[] = [], caller: Frame | null = null) {
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

  private methods?: Map<string, BlockModel>;
  /** METHOD `name` of the function block `fb`. */
  private methodOf(fb: string, name: string): BlockModel | undefined {
    if (!this.methods) {
      this.methods = new Map();
      for (const g of this.index.allGlobals()) if (g.block?.owner) this.methods.set(`${g.block.owner}.${g.block.name}`.toUpperCase(), g.block);
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
    for (const s of stmts) this.stmt(s, f);
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
