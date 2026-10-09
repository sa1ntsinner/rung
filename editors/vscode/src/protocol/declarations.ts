// SPDX-License-Identifier: MIT
// The declaration model the language server sends (rung/declarations) and the messages between the extension and its
// declarations view. The model types mirror packages/lsp/src/declarations.ts; a type test keeps them identical.

/** An attribute's value, and whether the source says so or TIA Portal's default applies. */
export interface AttrState {
  value: boolean;
  explicit: boolean;
}

/** UTF-16 offsets into the document text. */
export interface DRange {
  start: number;
  end: number;
}

export interface DeclRow {
  /** names from the section down, each with % and / escaped */
  id: string;
  depth: number;
  name: string;
  type: string;
  typeRef?: string;
  kind: "plain" | "struct" | "array" | "instance";
  start?: string;
  comment?: string;
  /** a PLC tag's address (a tag table) */
  address?: string;
  attrs: { accessible: AttrState; visible: AttrState; writable: AttrState; setpoint: AttrState };
  /** whether TIA's HMI/OPC UA attributes apply (not to temporaries and constants) */
  hmi: boolean;
  other: { key: string; value: string }[];
  ranges: { whole: DRange; name: DRange; type: DRange; start?: DRange; comment?: DRange; attrs?: DRange; address?: DRange };
  /** the language server's errors and warnings about this declaration's name, type or value */
  problems?: DeclProblem[];
  children?: DeclRow[];
}

export interface DeclProblem {
  column: "name" | "type" | "start";
  severity: "error" | "warning";
  message: string;
}

export interface DeclSection {
  id: string;
  title: string;
  keyword: string;
  modifiers: string[];
  rows: DeclRow[];
  range: DRange;
  /** after the header .. the start of END_VAR: where new declarations go */
  body: DRange;
}

export interface DeclModel {
  uri: string;
  version: number;
  /** an FC's return type as written (Void, Int, …) */
  block?: { name: string; kind: string; range: DRange; returnType?: string };
  sections: DeclSection[];
  editable: boolean;
  reason?: string;
  unavailable: DRange[];
  /** a tag table: the bit memory a new tag gets */
  nextAddress?: string;
}

/** A declaration a table adds (mirrors packages/lsp/src/declarationEdit.ts). */
export interface NewRow {
  name: string;
  type: string;
  start?: string;
  comment?: string;
  address?: string;
}

/** One edit of the table; the language server plans its text (rung/declarationEdit). */
export type DeclOp =
  | { op: "setStart"; row: string; value: string | null }
  | { op: "setComment"; row: string; value: string | null }
  | { op: "setAttr"; row: string; key: string; state: "on" | "off" | "default" }
  | { op: "setType"; row: string; type: string }
  | { op: "insertRows"; after?: string; into?: string; section?: string; rows: NewRow[] }
  | { op: "deleteRow"; row: string }
  | { op: "setAddress"; row: string; value: string | null };

/** Rows read from pasted text (rung/declarationPaste). */
export interface PasteResult {
  rows: NewRow[];
  errors: { line: number; message: string }[];
}

/** What the view shows around the model: where the block lives and the document's state. */
export interface ViewContext {
  plc?: string;
  file: string;
  dirty: boolean;
  pinned: boolean;
  /** the view is the file's own editor (a UDT table): it follows nothing and has no pin */
  fixed?: boolean;
}

export type HostToView =
  | { v: 1; kind: "model"; model: DeclModel; context: ViewContext }
  | { v: 1; kind: "state"; state: "loading" | "noServer" | "noBlock"; context?: ViewContext }
  | { v: 1; kind: "reveal"; rowId: string }
  /** the answer to an edit: ok (the document changed) or why not; `edit` names a row to edit next (a new row's name) */
  | { v: 1; kind: "result"; req: number; ok: boolean; reason?: string; edit?: { rowId: string; column: "name" } }
  | { v: 1; kind: "pastePreview"; req: number; result: PasteResult }
  | { v: 1; kind: "types"; elementary: string[]; types: { name: string; kind: string }[] }
  /** monitoring this block (a DB, an FB through its instance): each row's value as TIA Portal's Monitor value column */
  | { v: 1; kind: "values"; on: boolean; values: Record<string, string>; instance?: string; target?: string; state?: "live" | "stale" | "disconnected" };

export type OpenTarget = "name" | "type" | "start" | "comment";

export type ViewToHost =
  | { v: 1; kind: "ready" }
  | { v: 1; kind: "open"; rowId: string; target: OpenTarget }
  | { v: 1; kind: "usages"; rowId: string }
  | { v: 1; kind: "openType"; rowId: string }
  | { v: 1; kind: "openText" }
  | { v: 1; kind: "pin"; pinned: boolean }
  /** `uri` and `version` are the model's the view edited: another file or a newer text refuses the edit */
  | { v: 1; kind: "edit"; req: number; uri: string; version: number; op: DeclOp }
  | { v: 1; kind: "rename"; req: number; uri: string; version: number; rowId: string; name: string }
  /** a new declaration (named as TIA names one, Bool) after a row, at the end of a struct or of a section */
  | { v: 1; kind: "add"; req: number; uri: string; version: number; after?: string; into?: string; section?: string }
  | { v: 1; kind: "delete"; req: number; uri: string; version: number; rowId: string }
  | { v: 1; kind: "paste"; req: number; uri: string; text: string }
  | { v: 1; kind: "undo" }
  | { v: 1; kind: "redo" }
  /** start or stop monitoring the block the table shows */
  | { v: 1; kind: "monitor" }
  | { v: 1; kind: "modify"; uri: string; version: number; rowId: string };

const TARGETS: ReadonlySet<string> = new Set<OpenTarget>(["name", "type", "start", "comment"]);
/** the attributes the table sets: a key from the view is never text written into the file */
const ATTR_KEYS: ReadonlySet<string> = new Set(["ExternalAccessible", "ExternalWritable", "ExternalVisible", "S7_SetPoint"]);
const str = (x: unknown) => typeof x === "string";
const optStr = (x: unknown) => x === undefined || typeof x === "string";
const nullStr = (x: unknown) => x === null || typeof x === "string";
const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);

function isNewRow(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return str(r.name) && str(r.type) && optStr(r.start) && optStr(r.comment) && optStr(r.address);
}

function isOp(x: unknown): x is DeclOp {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  switch (o.op) {
    case "setStart":
    case "setComment":
    case "setAddress":
      return str(o.row) && nullStr(o.value);
    case "setAttr":
      return str(o.row) && ATTR_KEYS.has(String(o.key)) && (o.state === "on" || o.state === "off" || o.state === "default");
    case "setType":
      return str(o.row) && str(o.type);
    case "insertRows":
      return optStr(o.after) && optStr(o.into) && optStr(o.section) && Array.isArray(o.rows) && o.rows.every(isNewRow);
    case "deleteRow":
      return str(o.row);
    default:
      return false;
  }
}

/** A message from the view, checked field by field: anything else is dropped. */
export function isViewToHost(x: unknown): x is ViewToHost {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  if (m.v !== 1 || typeof m.kind !== "string") return false;
  switch (m.kind) {
    case "ready":
    case "openText":
    case "undo":
    case "redo":
    case "monitor":
      return true;
    case "edit":
      return num(m.req) && str(m.uri) && num(m.version) && isOp(m.op);
    case "modify":
      return str(m.uri) && num(m.version) && str(m.rowId);
    case "rename":
      return num(m.req) && str(m.uri) && num(m.version) && str(m.rowId) && str(m.name);
    case "add":
      return num(m.req) && str(m.uri) && num(m.version) && optStr(m.after) && optStr(m.into) && optStr(m.section);
    case "delete":
      return num(m.req) && str(m.uri) && num(m.version) && str(m.rowId);
    case "paste":
      return num(m.req) && str(m.uri) && str(m.text);
    case "pin":
      return typeof m.pinned === "boolean";
    case "usages":
    case "openType":
      return typeof m.rowId === "string";
    case "open":
      return typeof m.rowId === "string" && TARGETS.has(String(m.target));
    default:
      return false;
  }
}
