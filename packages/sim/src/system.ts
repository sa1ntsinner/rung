// SPDX-License-Identifier: BUSL-1.1
// The S7-1200/1500 system instructions the offline simulator runs, as pure functions over its values: dates as
// milliseconds since 1970 (DT, LDT) or of the day (TOD), DTL as its eight members, strings as JavaScript strings.

/** Where rung's virtual clock starts: RD_SYS_T and RD_LOC_T read this plus the virtual time of the test. */
export const CLOCK_START = Date.UTC(2024, 0, 1); // DTL#2024-01-01-00:00:00, a Monday

/** Something the simulator does not model the way the PLC does: the call stops with this message. */
export class Unsupported extends Error {}

/** The elementary data types a TypeOf comparison can name without quotes (TypeOf(#in) = Int). */
export const ELEMENTARY_TYPE =
  /^(BOOL|BYTE|WORD|DWORD|LWORD|SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|REAL|LREAL|TIME|LTIME|S5TIME|DATE|TOD|TIME_OF_DAY|LTOD|LTIME_OF_DAY|DT|DATE_AND_TIME|LDT|DTL|CHAR|WCHAR|STRING|WSTRING)$/i;

const TYPE_ALIAS: Record<string, string> = { TIME_OF_DAY: "TOD", LTIME_OF_DAY: "LTOD", DATE_AND_TIME: "DT" };

/**
 * The value TypeOf and TypeOfElements give for a data type, and a type name in a comparison with them: one text per
 * type, whatever its spelling (Int, INT; "UDT_X", udt_x; String[20] is a String; Time_Of_Day is TOD).
 */
export function typeTag(type: string): string {
  const t = type.trim().replace(/^"|"$/g, "").replace(/^(W?STRING)\s*\[.*\]$/i, "$1").toUpperCase();
  return `\u0000type ${TYPE_ALIAS[t] ?? t}`;
}

export type DtlValue = { YEAR: number; MONTH: number; DAY: number; WEEKDAY: number; HOUR: number; MINUTE: number; SECOND: number; NANOSECOND: number };

/** DTL#1970-01-01-00:00:00 to DTL#2262-04-11-23:47:16.854775807 (LDT has the same range). */
const DTL_MAX = Date.UTC(2262, 3, 11, 23, 47, 16, 854);
/** DT#1990-01-01-00:00:00 to DT#2089-12-31-23:59:59.999. */
const DT_MIN = Date.UTC(1990, 0, 1);
const DT_MAX = Date.UTC(2089, 11, 31, 23, 59, 59, 999);
const DAY_MS = 86_400_000;
/** T#24d20h31m23s647ms: a TIME is a signed 32-bit number of milliseconds. */
const TIME_MAX = 2_147_483_647;

/** The DTL of a point in time; WEEKDAY 1 is Sunday, 7 Saturday. */
export function dtlOf(ms: number): DtlValue {
  const d = new Date(ms);
  return {
    YEAR: d.getUTCFullYear(),
    MONTH: d.getUTCMonth() + 1,
    DAY: d.getUTCDate(),
    WEEKDAY: d.getUTCDay() + 1,
    HOUR: d.getUTCHours(),
    MINUTE: d.getUTCMinutes(),
    SECOND: d.getUTCSeconds(),
    NANOSECOND: d.getUTCMilliseconds() * 1_000_000,
  };
}

/** The point in time a DTL holds (the simulator keeps milliseconds: nanoseconds below one are dropped). */
export function msOfDtl(v: Record<string, unknown>, what: string): number {
  const n = (k: string) => Number(v[k] ?? 0);
  // a DTL nobody set is DTL#1970-01-01-00:00:00, as in TIA Portal
  if (!n("YEAR") && !n("MONTH") && !n("DAY")) return n("HOUR") * 3_600_000 + n("MINUTE") * 60_000 + n("SECOND") * 1000 + Math.floor(n("NANOSECOND") / 1_000_000);
  const ms = Date.UTC(n("YEAR"), n("MONTH") - 1, n("DAY"), n("HOUR"), n("MINUTE"), n("SECOND"), Math.floor(n("NANOSECOND") / 1_000_000));
  const back = dtlOf(ms);
  if (n("YEAR") < 1970 || back.MONTH !== n("MONTH") || back.DAY !== n("DAY") || n("HOUR") > 23 || n("MINUTE") > 59 || n("SECOND") > 59 || ms > DTL_MAX)
    throw new Unsupported(`${what} is not a valid DTL (${n("YEAR")}-${n("MONTH")}-${n("DAY")} ${n("HOUR")}:${n("MINUTE")}:${n("SECOND")})`);
  return ms;
}

/** Kinds of time values the time instructions take. */
export type TimeKind = "DTL" | "DT" | "LDT" | "TOD" | "LTOD" | "TIME" | "LTIME" | "DATE";

export function timeKindOfType(type: string | undefined): TimeKind | undefined {
  const t = type?.replace(/^"|"$/g, "").toUpperCase();
  switch (t) {
    case "DTL":
      return "DTL";
    case "DT":
    case "DATE_AND_TIME":
      return "DT";
    case "LDT":
      return "LDT";
    case "TOD":
    case "TIME_OF_DAY":
      return "TOD";
    case "LTOD":
    case "LTIME_OF_DAY":
      return "LTOD";
    case "TIME":
      return "TIME";
    case "LTIME":
      return "LTIME";
    case "DATE":
      return "DATE";
    default:
      return undefined;
  }
}

/** T_DIFF: IN1 - IN2 of two points in time of one kind, as a duration (TIME for DTL, DT and TOD; LTIME for LDT and LTOD). */
export function timeDiff(kind: TimeKind, a: number, b: number): number {
  if (!["DTL", "DT", "LDT", "TOD", "LTOD"].includes(kind)) throw new Unsupported(`IN1 and IN2 are ${kind}: T_DIFF is simulated for DTL, DT, LDT, TOD and LTOD`);
  const d = a - b;
  if ((kind === "DTL" || kind === "DT" || kind === "TOD") && Math.abs(d) > TIME_MAX) throw new Unsupported(`the difference does not fit a TIME (at most T#24d20h31m23s647ms either way)`);
  return d;
}

/** T_ADD / T_SUB: a point in time or a duration plus or minus a duration, of IN1's kind; the ms of a DTL result. */
export function timeShift(kind: TimeKind, at: number, by: number, minus: boolean): number {
  const r = minus ? at - by : at + by;
  switch (kind) {
    case "TIME":
      if (Math.abs(r) > TIME_MAX) throw new Unsupported("the result does not fit a TIME (at most T#24d20h31m23s647ms either way)");
      return r;
    case "LTIME":
      return r;
    case "TOD":
    case "LTOD":
      if (r < 0 || r >= DAY_MS) throw new Unsupported(`the result leaves the day (${kind} past midnight is not simulated)`);
      return r;
    case "DT":
      if (r < DT_MIN || r > DT_MAX) throw new Unsupported("the result is outside DT#1990-01-01-00:00:00 to DT#2089-12-31-23:59:59.999");
      return r;
    case "LDT":
    case "DTL":
      if (r < 0 || r > DTL_MAX) throw new Unsupported(`the result is outside ${kind}#1970-01-01-00:00:00 to ${kind}#2262-04-11-23:47:16.854`);
      return r;
    default:
      throw new Unsupported(`IN1 is ${kind}: T_ADD and T_SUB are simulated for TIME, LTIME, TOD, LTOD, DT, LDT and DTL`);
  }
}

/** SWAP: the bytes of a WORD, DWORD or LWORD in reverse order (16#1234 → 16#3412). */
export function swapBytes(v: number, bits: number): number {
  let x = BigInt.asUintN(bits, BigInt(Math.trunc(v)));
  let out = 0n;
  for (let i = 0; i < bits / 8; i++) {
    out = (out << 8n) | (x & 0xffn);
    x >>= 8n;
  }
  const n = Number(out);
  if (BigInt(n) !== out) throw new Unsupported(`the result 16#${out.toString(16).toUpperCase().padStart(bits / 4, "0")} cannot be held exactly: the simulator keeps integers exact up to 2^53, and beyond only where a double holds them`);
  return n;
}

/**
 * VAL_STRG in decimal notation: the number right-aligned in SIZE characters (SIZE 0: as many as it needs), PREC
 * decimals (an integer gets its decimal point PREC places from the right: 12345 with PREC 2 is 123.45), FORMAT bit
 * 0 the separator (0 ".", 1 ","), bit 2 the sign (0 only "-", 1 "+" and "-"). Exponential notation, values that
 * are not finite and numbers longer than SIZE are refused.
 */
export function valStrg(value: number, integer: boolean, size: number, prec: number, format: number): string {
  if (!Number.isInteger(format) || format < 0 || format > 7) throw new Unsupported(`FORMAT ${format} is not one of W#16#0000 to W#16#0007`);
  if (format & 2) throw new Unsupported("exponential notation (FORMAT bit 1) is not simulated");
  if (!Number.isInteger(prec) || prec < 0 || prec > 20) throw new Unsupported(`PREC ${prec} is not simulated (0 to 20)`);
  if (!Number.isInteger(size) || size < 0) throw new Unsupported(`SIZE ${size} is not a number of characters`);
  if (!Number.isFinite(value)) throw new Unsupported(`IN is ${value}: only finite numbers are simulated`);
  const sep = format & 1 ? "," : ".";
  const abs = Math.abs(value);
  let digits: string;
  if (integer) {
    const d = BigInt(Math.trunc(abs)).toString().padStart(prec + 1, "0");
    digits = prec ? `${d.slice(0, -prec)}${sep}${d.slice(-prec)}` : d;
  } else {
    if (abs >= 1e21) throw new Unsupported(`IN ${value} is too large for decimal notation`);
    digits = abs.toFixed(prec).replace(".", sep);
  }
  const text = `${value < 0 ? "-" : format & 4 ? "+" : ""}${digits}`;
  if (size && text.length > size) throw new Unsupported(`IN needs ${text.length} characters (${text}) but SIZE is ${size}`);
  return size ? text.padStart(size, " ") : text;
}

/** DELETE: L characters of IN from position P (the first character is 1). */
export function deleteChars(s: string, l: number, p: number): string {
  if (!Number.isInteger(l) || !Number.isInteger(p) || l < 0 || p < 1 || p + l - 1 > s.length) throw new Unsupported(`L ${l} characters from P ${p} are not within IN (${s.length} characters)`);
  return s.slice(0, p - 1) + s.slice(p - 1 + l);
}

/** INSERT: IN2 into IN1 after its P-th character. */
export function insertChars(s: string, what: string, p: number): string {
  if (!Number.isInteger(p) || p < 1 || p > s.length) throw new Unsupported(`P ${p} is not a character of IN1 (1 to ${s.length})`);
  return s.slice(0, p) + what + s.slice(p);
}

/** REPLACE: L characters of IN1 from position P by IN2. */
export function replaceChars(s: string, what: string, l: number, p: number): string {
  if (!Number.isInteger(l) || !Number.isInteger(p) || l < 0 || p < 1 || p + l - 1 > s.length) throw new Unsupported(`L ${l} characters from P ${p} are not within IN1 (${s.length} characters)`);
  return s.slice(0, p - 1) + what + s.slice(p - 1 + l);
}
