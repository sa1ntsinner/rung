// SPDX-License-Identifier: MIT
// The test file model the language server sends (rung/testModel) and the messages between the extension and its
// test table. The model types mirror packages/lsp/src/testModel.ts and testEdit.ts; a type test keeps them identical.

export interface TRange {
  start: number;
  end: number;
}

export interface TScalar {
  value: string;
  range: TRange;
}

export interface TEntry {
  key: string;
  value: string;
  keyRange: TRange;
  valueRange: TRange;
  pairRange: TRange;
  complex?: boolean;
}

export interface TMap {
  flow: boolean;
  range: TRange;
  entries: TEntry[];
  keyRange: TRange;
}

export interface TStep {
  index: number;
  flow: boolean;
  range: TRange;
  line: number;
  set?: TMap;
  cycle?: TScalar & { keyRange: TRange };
  advance?: TScalar & { keyRange: TRange };
  expect?: TMap;
  unknown: string[];
}

export interface TCase {
  index: number;
  name?: TScalar;
  range: TRange;
  line: number;
  steps: TStep[];
  stepsRange?: TRange;
}

export interface TStub {
  name: string;
  nameRange: TRange;
  entries: TEntry[];
  value?: TScalar;
}

export interface TestModel {
  block?: TScalar;
  plc?: TScalar;
  cycle?: TScalar;
  stubs: TStub[];
  cases: TCase[];
  casesRange?: TRange;
  errors: { message: string; line: number; column: number }[];
}

export type Part = "set" | "expect";
export type RunKind = "cycle" | "advance";

export type TestOp =
  | { op: "setValue"; case: number; step: number; part: Part; key: string; value: string }
  | { op: "setKey"; case: number; step: number; part: Part; key: string; newKey: string }
  | { op: "addEntry"; case: number; step: number; part: Part; key: string; value: string }
  | { op: "removeEntry"; case: number; step: number; part: Part; key: string }
  | { op: "setRun"; case: number; step: number; kind: RunKind; value: string | null }
  | { op: "addStep"; case: number; after?: number; kind: Part | RunKind }
  | { op: "removeStep"; case: number; step: number }
  | { op: "moveStep"; case: number; step: number; by: -1 | 1 }
  | { op: "addCase"; name: string; after?: number }
  | { op: "renameCase"; case: number; name: string }
  | { op: "duplicateCase"; case: number; name: string }
  | { op: "removeCase"; case: number };

export interface TestSymbol {
  name: string;
  type: string;
  section: string;
}

export interface KeyProblem {
  case: number;
  step: number;
  part: Part;
  key: string;
  message: string;
}

/** What rung/testModel answers. */
export interface TestFileModel {
  uri: string;
  version: number;
  model: TestModel;
  symbols: TestSymbol[];
  problems: KeyProblem[];
  noBlock?: string;
}

/** The last run of a case, as the test explorer reported it. */
export interface CaseRun {
  index: number;
  passed: boolean;
  error?: string;
  errorStep?: number;
  /** step numbers from 1, as rung test prints them */
  failures: { step: number; name: string; expected: unknown; actual: unknown }[];
}

export type TestHostToView =
  | { v: 1; kind: "model"; file: TestFileModel; context: { file: string; dirty: boolean } }
  | { v: 1; kind: "state"; state: "loading" | "noServer" }
  | { v: 1; kind: "result"; req: number; ok: boolean; reason?: string }
  | { v: 1; kind: "runs"; running: number[]; runs: CaseRun[] };

export type TestViewToHost =
  | { v: 1; kind: "ready" }
  | { v: 1; kind: "edit"; req: number; uri: string; version: number; op: TestOp }
  /** pick a name of the block (or type one) and add it to a step's set/expect */
  | { v: 1; kind: "pick"; req: number; uri: string; version: number; case: number; step: number; part: Part }
  | { v: 1; kind: "run"; case?: number }
  | { v: 1; kind: "openText"; line?: number }
  | { v: 1; kind: "undo" }
  | { v: 1; kind: "redo" };

const str = (x: unknown) => typeof x === "string";
const num = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0;
const part = (x: unknown) => x === "set" || x === "expect";
const optNum = (x: unknown) => x === undefined || num(x);

function isTestOp(x: unknown): x is TestOp {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  const at = num(o.case) && num(o.step);
  switch (o.op) {
    case "setValue":
    case "addEntry":
      return at && part(o.part) && str(o.key) && str(o.value);
    case "setKey":
      return at && part(o.part) && str(o.key) && str(o.newKey);
    case "removeEntry":
      return at && part(o.part) && str(o.key);
    case "setRun":
      return at && (o.kind === "cycle" || o.kind === "advance") && (o.value === null || str(o.value));
    case "addStep":
      return num(o.case) && optNum(o.after) && (part(o.kind) || o.kind === "cycle" || o.kind === "advance");
    case "removeStep":
      return at;
    case "moveStep":
      return at && (o.by === -1 || o.by === 1);
    case "addCase":
      return str(o.name) && optNum(o.after);
    case "renameCase":
    case "duplicateCase":
      return num(o.case) && str(o.name);
    case "removeCase":
      return num(o.case);
    default:
      return false;
  }
}

/** A message from the test table, checked field by field: anything else is dropped. */
export function isTestViewToHost(x: unknown): x is TestViewToHost {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  if (m.v !== 1 || typeof m.kind !== "string") return false;
  switch (m.kind) {
    case "ready":
    case "undo":
    case "redo":
      return true;
    case "edit":
      return num(m.req) && str(m.uri) && num(m.version) && isTestOp(m.op);
    case "pick":
      return num(m.req) && str(m.uri) && num(m.version) && num(m.case) && num(m.step) && part(m.part);
    case "run":
      return optNum(m.case);
    case "openText":
      return optNum(m.line);
    default:
      return false;
  }
}
