// SPDX-License-Identifier: BUSL-1.1
// Built-in knowledge written for rung from the IEC 61131-3 standard: keywords, elementary types,
// standard functions and function blocks. No vendor documentation is copied; the Siemens
// instruction catalog is not bundled.

export interface CatalogParam {
  name: string;
  type: string;
  dir: "in" | "out" | "inout";
}

export interface CatalogEntry {
  name: string;
  kind: "function" | "functionBlock";
  params: CatalogParam[];
  returns?: string;
  doc: string;
  /** Instructions callable on an instance of this type: `#t.TON(IN := ..)` on an IEC_TIMER. */
  methods?: string[];
}

const p = (name: string, type: string, dir: CatalogParam["dir"] = "in"): CatalogParam => ({ name, type, dir });
const fn = (name: string, params: CatalogParam[], returns: string, doc: string): CatalogEntry => ({ name, kind: "function", params, returns, doc });
const fb = (name: string, params: CatalogParam[], doc: string): CatalogEntry => ({ name, kind: "functionBlock", params, doc });

const timer = (name: string, t: string, doc: string) => fb(name, [p("IN", "Bool"), p("PT", t), p("Q", "Bool", "out"), p("ET", t, "out")], doc);

export const STANDARD: CatalogEntry[] = [
  timer("TON", "Time", "On-delay timer: Q becomes TRUE when IN has been TRUE for PT."),
  timer("TOF", "Time", "Off-delay timer: Q stays TRUE for PT after IN falls."),
  timer("TP", "Time", "Pulse timer: Q is TRUE for PT after a rising edge of IN."),
  timer("TON_TIME", "Time", "On-delay timer (TIME)."),
  timer("TOF_TIME", "Time", "Off-delay timer (TIME)."),
  timer("TP_TIME", "Time", "Pulse timer (TIME)."),
  timer("TON_LTIME", "LTime", "On-delay timer (LTIME)."),
  timer("TOF_LTIME", "LTime", "Off-delay timer (LTIME)."),
  timer("TP_LTIME", "LTime", "Pulse timer (LTIME)."),
  fb("CTU", [p("CU", "Bool"), p("R", "Bool"), p("PV", "Int"), p("Q", "Bool", "out"), p("CV", "Int", "out")], "Up counter: CV counts rising edges of CU; Q = CV >= PV."),
  fb("CTD", [p("CD", "Bool"), p("LD", "Bool"), p("PV", "Int"), p("Q", "Bool", "out"), p("CV", "Int", "out")], "Down counter: LD loads PV; Q = CV <= 0."),
  fb("CTUD", [p("CU", "Bool"), p("CD", "Bool"), p("R", "Bool"), p("LD", "Bool"), p("PV", "Int"), p("QU", "Bool", "out"), p("QD", "Bool", "out"), p("CV", "Int", "out")], "Up/down counter."),
  fb("R_TRIG", [p("CLK", "Bool"), p("Q", "Bool", "out")], "Rising edge: Q is TRUE for one call when CLK goes from FALSE to TRUE."),
  fb("F_TRIG", [p("CLK", "Bool"), p("Q", "Bool", "out")], "Falling edge: Q is TRUE for one call when CLK goes from TRUE to FALSE."),
  fb("SR", [p("S1", "Bool"), p("R", "Bool"), p("Q1", "Bool", "out")], "Set-dominant bistable."),
  fb("RS", [p("S", "Bool"), p("R1", "Bool"), p("Q1", "Bool", "out")], "Reset-dominant bistable."),
  fn("ABS", [p("IN", "ANY_NUM")], "ANY_NUM", "Absolute value."),
  fn("SQR", [p("IN", "ANY_REAL")], "ANY_REAL", "Square."),
  fn("SQRT", [p("IN", "ANY_REAL")], "ANY_REAL", "Square root."),
  fn("LN", [p("IN", "ANY_REAL")], "ANY_REAL", "Natural logarithm."),
  fn("LOG", [p("IN", "ANY_REAL")], "ANY_REAL", "Base-10 logarithm."),
  fn("EXP", [p("IN", "ANY_REAL")], "ANY_REAL", "Exponential function e^IN."),
  fn("SIN", [p("IN", "ANY_REAL")], "ANY_REAL", "Sine (radians)."),
  fn("COS", [p("IN", "ANY_REAL")], "ANY_REAL", "Cosine (radians)."),
  fn("TAN", [p("IN", "ANY_REAL")], "ANY_REAL", "Tangent (radians)."),
  fn("ASIN", [p("IN", "ANY_REAL")], "ANY_REAL", "Arc sine."),
  fn("ACOS", [p("IN", "ANY_REAL")], "ANY_REAL", "Arc cosine."),
  fn("ATAN", [p("IN", "ANY_REAL")], "ANY_REAL", "Arc tangent."),
  fn("MIN", [p("IN1", "ANY"), p("IN2", "ANY")], "ANY", "Smallest input."),
  fn("MAX", [p("IN1", "ANY"), p("IN2", "ANY")], "ANY", "Largest input."),
  fn("LIMIT", [p("MN", "ANY"), p("IN", "ANY"), p("MX", "ANY")], "ANY", "Clamps IN to the range MN..MX."),
  fn("SEL", [p("G", "Bool"), p("IN0", "ANY"), p("IN1", "ANY")], "ANY", "Selects IN0 when G is FALSE, IN1 when TRUE."),
  fn("MUX", [p("K", "ANY_INT"), p("IN0", "ANY"), p("IN1", "ANY")], "ANY", "Selects input number K."),
  fn("TRUNC", [p("IN", "ANY_REAL")], "ANY_INT", "Truncates toward zero."),
  fn("ROUND", [p("IN", "ANY_REAL")], "ANY_NUM", "Rounds to the nearest integer."),
  fn("CEIL", [p("IN", "ANY_REAL")], "ANY_NUM", "Rounds up."),
  fn("FLOOR", [p("IN", "ANY_REAL")], "ANY_NUM", "Rounds down."),
  fn("NORM_X", [p("MIN", "ANY_NUM"), p("VALUE", "ANY_NUM"), p("MAX", "ANY_NUM")], "Real", "Normalizes VALUE from MIN..MAX to 0.0..1.0."),
  fn("SCALE_X", [p("MIN", "ANY_NUM"), p("VALUE", "Real"), p("MAX", "ANY_NUM")], "ANY_NUM", "Scales VALUE from 0.0..1.0 to MIN..MAX."),
  fn("LEN", [p("IN", "String")], "Int", "Length of a string."),
  fn("CONCAT", [p("IN1", "String"), p("IN2", "String")], "String", "Joins strings."),
  fn("LEFT", [p("IN", "String"), p("L", "Int")], "String", "Leftmost L characters."),
  fn("RIGHT", [p("IN", "String"), p("L", "Int")], "String", "Rightmost L characters."),
  fn("MID", [p("IN", "String"), p("L", "Int"), p("P", "Int")], "String", "L characters starting at position P."),
  fn("FIND", [p("IN1", "String"), p("IN2", "String")], "Int", "Position of IN2 in IN1 (0 if absent)."),
  fn("SHL", [p("IN", "ANY_BIT"), p("N", "UInt")], "ANY_BIT", "Shift left by N bits."),
  fn("SHR", [p("IN", "ANY_BIT"), p("N", "UInt")], "ANY_BIT", "Shift right by N bits."),
  fn("ROL", [p("IN", "ANY_BIT"), p("N", "UInt")], "ANY_BIT", "Rotate left by N bits."),
  fn("ROR", [p("IN", "ANY_BIT"), p("N", "UInt")], "ANY_BIT", "Rotate right by N bits."),
];

const counterParams = (t: string) => [p("CU", "Bool"), p("CD", "Bool"), p("R", "Bool"), p("LD", "Bool"), p("PV", t), p("QU", "Bool", "out"), p("QD", "Bool", "out"), p("CV", t, "out")];
for (const [name, t] of [["IEC_TIMER", "Time"], ["IEC_LTIMER", "LTime"]] as const) {
  STANDARD.push({ ...fb(name, [p("IN", "Bool"), p("PT", t), p("Q", "Bool", "out"), p("ET", t, "out")], `Timer instance data (${t}); call #t.TON(...), #t.TOF(...) or #t.TP(...).`), methods: ["TON", "TOF", "TP"] });
}
const INT_SUFFIX = ["SInt", "Int", "DInt", "LInt", "USInt", "UInt", "UDInt", "ULInt"];
for (const [name, t] of [["IEC_SCOUNTER", "SInt"], ["IEC_COUNTER", "Int"], ["IEC_DCOUNTER", "DInt"], ["IEC_LCOUNTER", "LInt"], ["IEC_USCOUNTER", "USInt"], ["IEC_UCOUNTER", "UInt"], ["IEC_UDCOUNTER", "UDInt"], ["IEC_ULCOUNTER", "ULInt"]] as const) {
  STANDARD.push({ ...fb(name, counterParams(t), `Counter instance data (${t}); call #c.CTU(...), #c.CTD(...) or #c.CTUD(...).`), methods: ["CTU", "CTD", "CTUD"] });
}
for (const t of INT_SUFFIX) {
  const up = t.toUpperCase();
  STANDARD.push(fb(`CTU_${up}`, [p("CU", "Bool"), p("R", "Bool"), p("PV", t), p("Q", "Bool", "out"), p("CV", t, "out")], `Up counter (${t}).`));
  STANDARD.push(fb(`CTD_${up}`, [p("CD", "Bool"), p("LD", "Bool"), p("PV", t), p("Q", "Bool", "out"), p("CV", t, "out")], `Down counter (${t}).`));
  STANDARD.push(fb(`CTUD_${up}`, [p("CU", "Bool"), p("CD", "Bool"), p("R", "Bool"), p("LD", "Bool"), p("PV", t), p("QU", "Bool", "out"), p("QD", "Bool", "out"), p("CV", t, "out")], `Up/down counter (${t}).`));
}

/** Structured system data types whose members are known (S7-1200/1500 elementary structures). */
export interface SystemTypeMember {
  name: string;
  type: string;
  isArray?: boolean;
  typeRef?: string;
}
export const SYSTEM_TYPES = new Map<string, SystemTypeMember[]>([
  [
    "DTL",
    [
      { name: "YEAR", type: "UInt" },
      { name: "MONTH", type: "USInt" },
      { name: "DAY", type: "USInt" },
      { name: "WEEKDAY", type: "USInt" },
      { name: "HOUR", type: "USInt" },
      { name: "MINUTE", type: "USInt" },
      { name: "SECOND", type: "USInt" },
      { name: "NANOSECOND", type: "UDInt" },
    ],
  ],
  ["IP_V4", [{ name: "ADDR", type: "Array[1..4] of Byte", typeRef: "Byte", isArray: true }]],
  [
    "TCON_IP_V4",
    [
      { name: "InterfaceId", type: "HW_ANY" },
      { name: "ID", type: "CONN_OUC" },
      { name: "ConnectionType", type: "Byte" },
      { name: "ActiveEstablished", type: "Bool" },
      { name: "RemoteAddress", type: "IP_V4", typeRef: "IP_V4" },
      { name: "RemotePort", type: "UInt" },
      { name: "LocalPort", type: "UInt" },
    ],
  ],
]);

export const STANDARD_BY_NAME = new Map(STANDARD.map((e) => [e.name.toUpperCase(), e]));

export const ELEMENTARY_TYPES = [
  "Bool", "Byte", "Word", "DWord", "LWord", "SInt", "Int", "DInt", "LInt", "USInt", "UInt", "UDInt", "ULInt",
  "Real", "LReal", "Time", "LTime", "Date", "Time_Of_Day", "LTime_Of_Day", "Date_And_Time", "LDT", "DTL",
  "Char", "WChar", "String", "WString", "Variant", "Void",
];

export const KEYWORDS = [
  "FUNCTION_BLOCK", "END_FUNCTION_BLOCK", "FUNCTION", "END_FUNCTION", "ORGANIZATION_BLOCK", "END_ORGANIZATION_BLOCK",
  "DATA_BLOCK", "END_DATA_BLOCK", "TYPE", "END_TYPE", "STRUCT", "END_STRUCT", "VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT",
  "VAR", "VAR_TEMP", "VAR_STAT", "END_VAR", "CONSTANT", "RETAIN", "NON_RETAIN", "BEGIN", "VERSION", "TITLE",
  "IF", "THEN", "ELSIF", "ELSE", "END_IF", "CASE", "OF", "END_CASE", "FOR", "TO", "BY", "DO", "END_FOR",
  "WHILE", "END_WHILE", "REPEAT", "UNTIL", "END_REPEAT", "EXIT", "CONTINUE", "RETURN", "GOTO",
  "REGION", "END_REGION", "AND", "OR", "XOR", "NOT", "MOD", "TRUE", "FALSE", "ARRAY", "AT",
];

/** Conversion functions follow the pattern <FROM>_TO_<TO>; recognized generically. */
export const CONVERSION = /^[A-Z_]+_TO_[A-Z_]+$/;
