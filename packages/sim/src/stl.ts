// SPDX-License-Identifier: BUSL-1.1
// STL (statement list), as TIA Portal exports it in .awl blocks and in the STL networks of SimaticML blocks,
// interpreted instruction by instruction with the status word and the two accumulators of an S7-300/400 CPU as the
// STEP 7 "Statement List (STL) for S7-300 and S7-400" reference manual (04/2017) describes them; § below are its
// sections. A block that uses anything outside the subset below is refused before it runs, with the list of what
// is missing.
import { parseBody, parseTime, type Expr, type LRef } from "./ast.js";
import type { Value } from "./runtime.js";

/** RND: to the nearest whole number; exactly half way, to the even one (§3.15). */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
}

type Kind = "bit" | "or" | "not" | "nest" | "close" | "assign" | "edge" | "set" | "load" | "transfer" | "accu" | "add" | "compare" | "jump" | "nop" | "timer" | "call" | "end";

/** What each instruction the simulator runs does with its operand. */
const SUBSET: Record<string, Kind> = {
  A: "bit", AN: "bit", O: "bit", ON: "bit", X: "bit", XN: "bit", NOT: "not",
  "A(": "nest", "AN(": "nest", "O(": "nest", "ON(": "nest", "X(": "nest", "XN(": "nest", ")": "close",
  "=": "assign", S: "assign", R: "assign",
  FP: "edge", FN: "edge",
  SET: "set", CLR: "set",
  L: "load", T: "transfer",
  "+I": "accu", "-I": "accu", "*I": "accu", "/I": "accu",
  "+D": "accu", "-D": "accu", "*D": "accu", "/D": "accu",
  "+R": "accu", "-R": "accu", "*R": "accu", "/R": "accu",
  "+": "add",
  ITD: "accu", DTR: "accu", RND: "accu", TRUNC: "accu", CAW: "accu", CAD: "accu",
  "==I": "compare", "<>I": "compare", ">I": "compare", "<I": "compare", ">=I": "compare", "<=I": "compare",
  "==D": "compare", "<>D": "compare", ">D": "compare", "<D": "compare", ">=D": "compare", "<=D": "compare",
  "==R": "compare", "<>R": "compare", ">R": "compare", "<R": "compare", ">=R": "compare", "<=R": "compare",
  JU: "jump", JC: "jump", JCN: "jump",
  NOP: "nop",
  SD: "timer",
  CALL: "call",
  BE: "end", BEU: "end",
};

/** The instructions the simulator runs, for messages and docs. */
export const STL_INSTRUCTIONS = Object.keys(SUBSET);

/** CALL "FB", "Inst_DB" / CALL #multiInstance / CALL "FC", with its parameter list (all written with :=). */
export interface StlCall {
  /** The FB or FC named (CALL "FB", "DB" and CALL "FC"); a multi-instance names only its instance. */
  block?: string;
  instance?: LRef;
  params: { name: string; value: Expr }[];
}

export type StlOperand =
  | { kind: "var"; ref: LRef }
  | { kind: "absolute"; address: string }
  | { kind: "const"; value: number; wide?: boolean }
  | { kind: "label"; name: string }
  | { kind: "call"; call: StlCall }
  | { kind: "none" };

export interface StlInstr {
  op: string;
  operand: StlOperand;
  /** Offset in the file, for messages. */
  at: number;
  network: number;
}

export interface StlProgram {
  code: StlInstr[];
  labels: Map<string, number>;
  /** What the block uses that the simulator does not run: refused before it runs. */
  missing: string[];
}

/** S5TIME: a BCD count 0..999 (bits 0-11) of a time base (bits 12-13: 10 ms, 100 ms, 1 s, 10 s), §12.2. */
const S5_BASE = [10, 100, 1000, 10_000];

export function s5timeToMs(w: number): number | undefined {
  const digits = [(w >> 8) & 0xf, (w >> 4) & 0xf, w & 0xf];
  if (digits.some((d) => d > 9)) return undefined;
  return (digits[0]! * 100 + digits[1]! * 10 + digits[2]!) * S5_BASE[(w >> 12) & 3]!;
}

/** The S5TIME of a duration: the time base is chosen automatically, the value rounded down to it (§12.2). */
export function msToS5time(ms: number): number | undefined {
  if (!(ms >= 0)) return undefined;
  const base = S5_BASE.findIndex((b) => Math.floor(ms / b) <= 999);
  if (base < 0) return undefined;
  const n = Math.floor(ms / S5_BASE[base]!);
  return (base << 12) | (Math.floor(n / 100) << 8) | (Math.floor(n / 10) % 10 << 4) | (n % 10);
}

const f32 = new DataView(new ArrayBuffer(4));
export const bitsOfReal = (x: number) => (f32.setFloat32(0, x), f32.getUint32(0));
export const realOfBits = (b: number) => (f32.setUint32(0, b >>> 0), f32.getFloat32(0));
const s16 = (v: number) => (v << 16) >> 16;
const lo16 = (acc: number, v: number) => ((acc & 0xffff0000) | (v & 0xffff)) >>> 0;

/** A constant operand of L (or +) as a 32-bit accumulator value; undefined for a form the simulator does not load. */
function constant(text: string): { value: number; wide: boolean } | undefined {
  const t = text.replace(/_/g, "");
  const typed = /^([A-Za-z0-9]+)#(.*)$/.exec(t);
  if (typed) {
    const [, prefix, rest] = typed as unknown as [string, string, string];
    const p = prefix.toUpperCase();
    const s5 = /^(S5T|S5TIME)$/.test(p) ? msToS5time(parseTime(t)) : undefined;
    if (s5 !== undefined) return { value: s5, wide: false };
    if (/^(T|TIME)$/.test(p)) return { value: parseTime(t) >>> 0, wide: true };
    if (/^(L)$/.test(p) && /^[+-]?\d+$/.test(rest)) return { value: Number(rest) >>> 0, wide: true };
    const based = /^(?:(B|W|DW)#)?(2|8|16)#([0-9A-F]+)$/i.exec(t);
    if (based) return { value: parseInt(based[3]!, Number(based[2])) >>> 0, wide: based[1]?.toUpperCase() === "DW" };
    return undefined;
  }
  if (/^[+-]?\d+$/.test(t)) {
    const n = Number(t);
    if (n >= -32768 && n <= 32767) return { value: n & 0xffff, wide: false }; // an INT constant: ACCU1-H stays 0, as for any 16-bit load
    return n >= -2147483648 && n <= 2147483647 ? { value: n >>> 0, wide: true } : undefined;
  }
  if (/^[+-]?(\d+\.\d*|\d+(?=e))(e[+-]?\d+)?$/i.test(t)) return { value: bitsOfReal(Number(t)), wide: true };
  return undefined;
}

/** An SCL expression ("DB".member, "Tag", #local, #x.y[2], a constant), read with the SCL simulator's own resolution. */
function expression(text: string): Expr | undefined {
  try {
    const [s] = parseBody(`#__stl := ${text};`);
    return s?.k === "assign" ? s.value : undefined;
  } catch {
    return undefined;
  }
}

function variable(text: string): LRef | undefined {
  const e = expression(text);
  return e?.k === "ref" ? e.ref : undefined;
}

/** Splits at the commas outside quotes, brackets and parentheses. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** CALL's operand: "FB", "Inst_DB" ( a := 1, b := #x ) / #inst ( ... ) / "FC" ( ... ); undefined for another form. */
function callOf(arg: string): StlCall | string {
  if (/^(FB|FC|SFB|SFC)\s*\d+/i.test(arg)) return "CALL of a block by number (FB 10, DB 10)";
  const m =/^((?:"[^"]*"|#?[A-Za-z_]\w*)(?:\.(?:"[^"]*"|[A-Za-z_]\w*))*)\s*(?:,\s*("[^"]*"|[A-Za-z_]\w*))?\s*(?:\(([\s\S]*)\))?\s*$/.exec(arg);
  if (!m) return "CALL of a block by number or through a pointer";
  const [, head, db, list] = m as unknown as [string, string, string | undefined, string | undefined];
  const params: StlCall["params"] = [];
  for (const p of splitTop(list ?? "")) {
    const pm = /^("[^"]*"|[A-Za-z_]\w*)\s*:=\s*([\s\S]+)$/.exec(p);
    const value = pm ? expression(pm[2]!.trim()) : undefined;
    if (!pm || !value) return `CALL parameter ${p}`;
    params.push({ name: pm[1]!.replace(/^"|"$/g, ""), value });
  }
  if (head.startsWith("#")) {
    const instance = variable(head);
    return instance ? { instance, params } : `CALL ${head}`;
  }
  const name = head.replace(/^"|"$/g, "");
  if (/^(FB|FC|SFB|SFC)\s*\d+$/i.test(name) || (db && /^DB\s*\d+$/i.test(db))) return "CALL of a block by number (FB 10, DB 10)";
  if (!db) return { block: name, params };
  const instance = variable(db);
  return instance ? { block: name, instance, params } : `CALL ${head}, ${db}`;
}

/** Parses STL source (a block body between BEGIN and END_..., or the text of one network): networks, labels, instructions. */
export function parseStl(src: string, from: number, to: number): StlProgram {
  const code: StlInstr[] = [];
  const labels = new Map<string, number>();
  const missing = new Set<string>();
  let network = 0;
  let stmt = "";
  let stmtAt = -1;
  let offset = from;
  const flush = () => {
    const at = stmtAt;
    let s = stmt.trim();
    stmt = "";
    stmtAt = -1;
    if (!s) return;
    const label = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(?!=)\s*(.*)$/s.exec(s);
    if (label) {
      labels.set(label[1]!.toUpperCase(), code.length);
      s = label[2]!.trim();
      if (!s) return;
    }
    const m = /^(\S+)\s*(.*)$/s.exec(s)!;
    const op = m[1]!.toUpperCase();
    const arg = m[2]!.trim();
    const kind = SUBSET[op];
    if (!kind) {
      missing.add(op);
      return;
    }
    let operand: StlOperand = { kind: "none" };
    const wants = (what: string) => missing.add(`${op} ${what}`);
    if (kind === "jump") {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) wants("without a label");
      operand = { kind: "label", name: arg.toUpperCase() };
    } else if (kind === "call") {
      const call = callOf(arg);
      if (typeof call === "string") missing.add(call);
      else operand = { kind: "call", call };
    } else if (kind === "add") {
      const v = constant(arg);
      if (!v || /^[#"]/.test(arg)) wants(arg ? `${arg} (+ takes an integer constant)` : "without a constant");
      else operand = { kind: "const", ...v };
    } else if (kind === "nop") {
      if (!/^[01]$/.test(arg)) wants(arg);
    } else if (["close", "set", "accu", "compare", "nest", "end", "not"].includes(kind)) {
      if (arg) wants(arg);
    } else if (op === "O" && !arg) {
      // O without an operand: AND before OR (§1.8)
    } else if (!arg) wants("without an operand");
    else if (/^[^"#]*\[/.test(arg)) missing.add("indirect addressing ([...])"); // not an element: "DB".bits[5]
    else if (/^P#/i.test(arg)) missing.add("pointer constants (P#)");
    else if (/^(STW|AR1|AR2|DBNO|DINO|DBLG|DILG)$/i.test(arg)) missing.add(`${op} ${arg.toUpperCase()}`);
    else if (/^(OV|OS|BR|UO|==0|<>0|>0|<0|>=0|<=0)$/i.test(arg)) missing.add("status bits as operands (OV, OS, BR, ==0 ...)");
    else if (/^%?D[BI][XBWD]\s*\d/i.test(arg) || /^%?DB\d+\.DB/i.test(arg)) missing.add("absolute DB addresses (DBX, DBW, %DB1.DBX0.0 ...)");
    else if (/^%?[IQMETACZ][XBWD]?\s*\d+(\.\d)?$/i.test(arg)) {
      // %I0.0 / I 0.0: the PLC tag at that address
      const a = arg.replace(/\s+/g, "").replace(/^%?/, "%").toUpperCase();
      operand = { kind: "absolute", address: a };
    } else if (kind === "load" && !/^[#"]/.test(arg)) {
      const v = constant(arg);
      if (v === undefined) missing.add(`L ${arg.replace(/#.*$/, "#")} constants`);
      else operand = { kind: "const", ...v };
    } else {
      const ref = variable(arg);
      if (!ref) missing.add(`${op} ${arg}`);
      else operand = { kind: "var", ref };
    }
    code.push({ op, operand, at, network });
  };
  for (const raw of src.slice(from, to).split("\n")) {
    const lineAt = offset;
    offset += raw.length + 1;
    const line = raw.replace(/\/\/.*$/, "").trim(); // a comment runs to the end of the line
    if (!line) continue;
    if (/^NETWORK$/i.test(line)) {
      flush();
      network++;
      continue;
    }
    if (/^TITLE\s*=/i.test(line) || /^END_(FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK)\b/i.test(line)) continue;
    let rest = line;
    while (rest) {
      const semi = rest.search(/;(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/);
      if (stmtAt < 0) stmtAt = lineAt + raw.indexOf(rest.trimStart().charAt(0));
      if (semi < 0) {
        stmt += ` ${rest}`;
        break;
      }
      stmt += ` ${rest.slice(0, semi)}`;
      flush();
      rest = rest.slice(semi + 1).trim();
    }
  }
  flush();
  for (const c of code) if (c.operand.kind === "label" && !labels.has(c.operand.name)) missing.add(`${c.op} to a label that is not in the block (${c.operand.name})`);
  return { code, labels, missing: [...missing].sort() };
}

/** An S5 timer: started by SD, running on virtual time. */
export interface S5Timer {
  running: boolean;
  start: number;
  preset: number;
  /** The RLO at the last SD: SD starts the timer on a rising edge. */
  last: boolean;
}

/** What the interpreter needs of the simulator: the block's variables, virtual time, timers and calls. */
export interface StlHost {
  read(ref: LRef): Value;
  write(ref: LRef, value: Value): void;
  /** Declared type, upper case, without quotes (BOOL, INT, "TIMER"...), undefined when unknown. */
  typeOf(ref: LRef): string | undefined;
  /** The PLC tag at an absolute address. */
  tagAt(address: string): LRef | undefined;
  now(): number;
  timer(ref: LRef): S5Timer;
  /** A CALL through the simulator's own call path (stubs included). */
  call(c: StlCall, at: number): void;
  tick(at: number): void;
  fail(message: string, at: number): never;
}

/**
 * Runs an STL program once, with the status word of the STL manual:
 * - a first check (/FC = 0) starts a logic string; A, AN, X, XN and O, ON combine the test result with the RLO
 *   (§1.2-1.7): A a; O b; A c is (a OR b) AND c. Only O without an operand puts AND before OR (§1.8): A a; A b; O;
 *   A c; A d is (a AND b) OR (c AND d);
 * - A( ... ) saves the RLO and the OR bit on a nesting stack of at most 7 entries; ) combines them with the RLO
 *   inside, the OR bit included for AND (§1.9-1.15);
 * - =, S, R, SD and CALL end the string (/FC = 0) and keep the RLO; JC and JCN leave RLO = 1 and /FC = 0 whether they
 *   jump or not (§6.4, §6.5); a network does not end a string (§1.22).
 * With `endOpen`, a string still open at the end is refused (an STL network of a SimaticML block: on the PLC it goes
 * on in the next network).
 */
export function runStl(p: StlProgram, host: StlHost, opts: { endOpen?: string } = {}): void {
  let fc = false; // /FC: 0 = the next check is a first check
  let orb = false; // the OR bit: the AND terms before an O without operand, together
  let grp = false; // the current AND term
  let fresh = false; // after O without operand: the next check starts a term
  let rlo = false; // the RLO once the string is ended
  const stack: { op: string; fc: boolean; orb: boolean; grp: boolean; fresh: boolean; rlo: boolean }[] = [];
  let accu1 = 0;
  let accu2 = 0;
  const RLO = () => (fc ? orb || grp : rlo);
  const end = () => {
    rlo = RLO();
    fc = false;
    orb = false;
    fresh = false;
  };
  /** A, O or X of the test result x with the RLO (x already negated for AN, ON, XN). */
  const check = (op: string, x: boolean, at: number) => {
    if (!fc) {
      orb = false;
      grp = x;
      fc = true;
    } else if (op === "A") grp = fresh ? x : grp && x; // a set OR bit stays in: an earlier AND term was already true
    else {
      if (fresh && op === "X") host.fail("X directly after O without an operand is not simulated", at);
      const now = orb || grp;
      grp = op === "O" ? now || x : now !== x; // ORs / XORs the test result with the RLO and clears the OR bit (§1.4, §1.6)
      orb = false;
    }
    fresh = false;
  };
  const location = (c: StlInstr): LRef => {
    const o = c.operand;
    if (o.kind === "var") return o.ref;
    if (o.kind === "absolute") return host.tagAt(o.address) ?? host.fail(`${o.address} has no PLC tag: an address without a tag is not simulated`, c.at);
    return host.fail(`${c.op} needs a variable`, c.at);
  };
  const bit = (c: StlInstr): boolean => {
    const ref = location(c);
    const t = host.typeOf(ref);
    if (t === "TIMER") {
      const s = host.timer(ref);
      return s.running && host.now() - s.start >= s.preset;
    }
    // a member of a stub nothing describes has no declared type: it is a BOOL when it holds one
    const v = host.read(ref);
    if (t !== "BOOL" && !(t === undefined && typeof v === "boolean")) host.fail(`${c.op} reads a ${t ?? "variable of unknown type"}: it needs a BOOL or a timer`, c.at);
    return !!v;
  };
  const boolTarget = (c: StlInstr): LRef => {
    const ref = location(c);
    const t = host.typeOf(ref);
    if (t !== "BOOL" && !(t === undefined && typeof host.read(ref) === "boolean")) host.fail(`${c.op} writes a ${t ?? "variable of unknown type"}: it needs a BOOL`, c.at);
    return ref;
  };
  const load = (c: StlInstr): number => {
    if (c.operand.kind === "const") return c.operand.value;
    const ref = location(c);
    const t = host.typeOf(ref);
    const v = host.read(ref);
    switch (t) {
      case "BYTE":
      case "USINT":
        return Number(v) & 0xff;
      case "WORD":
      case "UINT":
      case "INT":
        return Number(v) & 0xffff; // ACCU1 is reset to 0 first (§9.2): an Int of -1 is 16#0000FFFF until ITD
      case "S5TIME": {
        const w = msToS5time(Number(v));
        return w ?? host.fail(`${c.op}: ${String(v)} ms does not fit an S5TIME (at most 2h46m30s)`, c.at);
      }
      case "DWORD":
      case "UDINT":
      case "DINT":
      case "TIME":
      case "TOD":
      case "TIME_OF_DAY":
        return Number(v) >>> 0;
      case "REAL":
        return bitsOfReal(Number(v));
      default:
        return host.fail(`L of a ${t ?? "variable of unknown type"} is not simulated (BYTE, WORD, INT, DWORD, DINT, REAL, TIME, S5TIME ...)`, c.at);
    }
  };
  const transfer = (c: StlInstr) => {
    const ref = location(c);
    const t = host.typeOf(ref);
    let v: Value;
    switch (t) {
      case "BYTE":
      case "USINT":
        v = accu1 & 0xff;
        break;
      case "WORD":
      case "UINT":
        v = accu1 & 0xffff;
        break;
      case "INT":
        v = s16(accu1);
        break;
      case "S5TIME":
        v = s5timeToMs(accu1 & 0xffff) ?? host.fail(`T: 16#${(accu1 & 0xffff).toString(16)} is not an S5TIME (BCD digits 0 to 9)`, c.at);
        break;
      case "DWORD":
      case "UDINT":
      case "TOD":
      case "TIME_OF_DAY":
        v = accu1 >>> 0;
        break;
      case "DINT":
      case "TIME":
        v = accu1 | 0;
        break;
      case "REAL":
        v = realOfBits(accu1);
        break;
      default:
        return host.fail(`T to a ${t ?? "variable of unknown type"} is not simulated (BYTE, WORD, INT, DWORD, DINT, REAL, TIME, S5TIME ...)`, c.at);
    }
    host.write(ref, v);
  };
  const arith = (c: StlInstr) => {
    const op = c.op;
    if (op.endsWith("I") && op.length === 2) {
      const a = s16(accu2);
      const b = s16(accu1);
      if (op === "+I") accu1 = lo16(accu1, a + b); // the result in ACCU1-L; ACCU2 stays, as on a CPU with two ACCUs (§7.3)
      else if (op === "-I") accu1 = lo16(accu1, a - b);
      else if (op === "*I") accu1 = (a * b) >>> 0; // a 32-bit result in ACCU1 (§7.5)
      else {
        if (b === 0) host.fail("/I: division by 0", c.at);
        accu1 = ((((a % b) & 0xffff) << 16) | (Math.trunc(a / b) & 0xffff)) >>> 0; // quotient in ACCU1-L, remainder in ACCU1-H (§7.6)
      }
      return;
    }
    if (op.endsWith("D") && op.length === 2) {
      const a = accu2 | 0;
      const b = accu1 | 0;
      if (op === "+D") accu1 = (a + b) >>> 0;
      else if (op === "-D") accu1 = (a - b) >>> 0;
      else if (op === "*D") accu1 = Number(BigInt.asUintN(32, BigInt(a) * BigInt(b)));
      else {
        if (b === 0) host.fail("/D: division by 0", c.at);
        accu1 = Math.trunc(a / b) >>> 0;
      }
      return;
    }
    if (op.endsWith("R") && op.length === 2) {
      const a = realOfBits(accu2);
      const b = realOfBits(accu1);
      accu1 = bitsOfReal(op === "+R" ? a + b : op === "-R" ? a - b : op === "*R" ? a * b : a / b);
      return;
    }
    switch (op) {
      case "ITD":
        accu1 = s16(accu1) >>> 0;
        return;
      case "DTR":
        accu1 = bitsOfReal(accu1 | 0);
        return;
      case "RND":
      case "TRUNC": {
        const x = realOfBits(accu1);
        const r = op === "RND" ? roundHalfEven(x) : Math.trunc(x);
        if (!Number.isFinite(r) || r < -2147483648 || r > 2147483647) host.fail(`${op}: ${x} does not fit a DINT`, c.at);
        accu1 = r >>> 0;
        return;
      }
      case "CAW":
        accu1 = lo16(accu1, ((accu1 & 0xff) << 8) | ((accu1 >> 8) & 0xff));
        return;
      case "CAD":
        accu1 = (((accu1 & 0xff) << 24) | ((accu1 & 0xff00) << 8) | ((accu1 >>> 8) & 0xff00) | (accu1 >>> 24)) >>> 0;
        return;
    }
  };
  const compare = (c: StlInstr): boolean => {
    const type = c.op.slice(-1);
    const rel = c.op.slice(0, -1);
    const [a, b] = type === "I" ? [s16(accu2), s16(accu1)] : type === "D" ? [accu2 | 0, accu1 | 0] : [realOfBits(accu2), realOfBits(accu1)];
    if (Number.isNaN(a) || Number.isNaN(b)) host.fail(`${c.op}: comparing a REAL that is not a number is not simulated`, c.at);
    return rel === "==" ? a === b : rel === "<>" ? a !== b : rel === ">" ? a > b : rel === "<" ? a < b : rel === ">=" ? a >= b : a <= b;
  };

  for (let i = 0; i < p.code.length; i++) {
    const c = p.code[i]!;
    host.tick(c.at);
    switch (SUBSET[c.op]!) {
      case "bit": {
        if (c.op === "O" && c.operand.kind === "none") {
          // the AND term so far is kept in the OR bit; the next check starts a new term (§1.8)
          if (fc) {
            orb = orb || grp;
            fresh = true;
          }
          break;
        }
        const x = bit(c);
        check(c.op[0]!, c.op.endsWith("N") ? !x : x, c.at);
        break;
      }
      case "not":
        // NOT negates the RLO and leaves /FC and the OR bit (§1.19): with an AND term waiting in the OR bit that is left open
        if (fc && orb) host.fail("NOT after O without an operand is not simulated", c.at);
        if (fc) grp = !grp;
        else rlo = !rlo;
        break;
      case "nest":
        if (stack.length === 7) host.fail("more than 7 nested A( / O( ...", c.at);
        stack.push({ op: c.op.slice(0, -1), fc, orb, grp, fresh, rlo });
        fc = false;
        orb = false;
        fresh = false;
        break;
      case "close": {
        const e = stack.pop() ?? host.fail(") without A( or O( before it", c.at);
        const inner = RLO();
        ({ fc, orb, grp, fresh, rlo } = e);
        check(e.op[0]!, e.op.endsWith("N") ? !inner : inner, c.at);
        break;
      }
      case "assign": {
        // also inside A( ... ): the string there ends, its RLO stays and ) takes it (as LAD writes a coil in a branch)
        const ref = boolTarget(c);
        const r = RLO();
        if (c.op === "=") host.write(ref, r);
        else if (r) host.write(ref, c.op === "S");
        end();
        break;
      }
      case "edge": {
        // FP: RLO 1 now and 0 at the last scan (kept in the edge bit); FN the other way round. The string goes on.
        const ref = boolTarget(c);
        const r = RLO();
        const before = !!host.read(ref);
        host.write(ref, r);
        const edge = c.op === "FP" ? r && !before : !r && before;
        orb = false;
        grp = edge;
        fresh = false;
        fc = true;
        break;
      }
      case "set":
        rlo = c.op === "SET";
        fc = false;
        orb = false;
        fresh = false;
        break;
      case "load":
        accu2 = accu1;
        accu1 = load(c);
        break;
      case "transfer":
        transfer(c);
        break;
      case "accu":
        arith(c);
        break;
      case "add": {
        // + <constant>: a 16-bit constant to ACCU1-L, a 32-bit one (L#) to ACCU1; the status word stays (§7.7)
        const k = c.operand as { value: number; wide?: boolean };
        accu1 = k.wide ? ((accu1 | 0) + (k.value | 0)) >>> 0 : lo16(accu1, s16(accu1) + s16(k.value));
        break;
      }
      case "compare": {
        // "RLO = 1 indicates that the result of the comparison is true" (§2.2): as the first check of a string (at its
        // start or in A( ... )). How it combines with a running string the manual leaves open, so that is refused.
        if (fc) host.fail(`${c.op} inside a running logic string is not simulated: start the string with it, or put it in A( ... )`, c.at);
        check("A", compare(c), c.at);
        break;
      }
      case "jump": {
        if (stack.length) host.fail(`${c.op} inside A( ... ) is not simulated`, c.at);
        const r = RLO();
        let go = true;
        if (c.op !== "JU") {
          go = c.op === "JC" ? r : !r;
          rlo = true;
          fc = false;
          orb = false;
          fresh = false;
        }
        if (go) i = p.labels.get((c.operand as { name: string }).name)! - 1;
        break;
      }
      case "timer": {
        // SD: starts on a rising RLO with the S5TIME in ACCU1-L, runs while RLO = 1, stops on RLO = 0 (§12.9)
        const ref = location(c);
        if (host.typeOf(ref) !== "TIMER") host.fail("SD needs a timer (a PLC tag of type Timer)", c.at);
        const s = host.timer(ref);
        const r = RLO();
        if (r && !s.last) {
          s.preset = s5timeToMs(accu1 & 0xffff) ?? host.fail(`SD: 16#${(accu1 & 0xffff).toString(16)} in ACCU1 is not an S5TIME (BCD digits 0 to 9)`, c.at);
          s.start = host.now();
          s.running = true;
        }
        if (!r) s.running = false;
        s.last = r;
        end();
        break;
      }
      case "call":
        // independent of the RLO; afterwards /FC = 0 and the OR bit 0, the RLO as it was (§10.5 to §10.7)
        if (stack.length) host.fail("CALL inside A( ... ) is not simulated", c.at);
        host.call((c.operand as { call: StlCall }).call, c.at);
        end();
        break;
      case "end":
        return;
      case "nop":
        break;
    }
  }
  if (opts.endOpen && (fc || stack.length)) host.fail(opts.endOpen, p.code[p.code.length - 1]?.at ?? 0);
}
