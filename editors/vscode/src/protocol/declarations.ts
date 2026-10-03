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
  id: string;
  depth: number;
  name: string;
  type: string;
  typeRef?: string;
  kind: "plain" | "struct" | "array" | "instance";
  start?: string;
  comment?: string;
  attrs: { accessible: AttrState; visible: AttrState; writable: AttrState; setpoint: AttrState };
  /** whether TIA's HMI/OPC UA attributes apply (not to temporaries and constants) */
  hmi: boolean;
  other: { key: string; value: string }[];
  ranges: { whole: DRange; name: DRange; type: DRange; start?: DRange; comment?: DRange; attrs?: DRange };
  children?: DeclRow[];
}

export interface DeclSection {
  id: string;
  title: string;
  keyword: string;
  modifiers: string[];
  rows: DeclRow[];
  range: DRange;
}

export interface DeclModel {
  uri: string;
  version: number;
  block?: { name: string; kind: string; range: DRange };
  sections: DeclSection[];
  editable: boolean;
  reason?: string;
  unavailable: DRange[];
}

/** What the view shows around the model: where the block lives and the document's state. */
export interface ViewContext {
  plc?: string;
  file: string;
  dirty: boolean;
  pinned: boolean;
}

export type HostToView =
  | { v: 1; kind: "model"; model: DeclModel; context: ViewContext }
  | { v: 1; kind: "state"; state: "loading" | "noServer" | "noBlock"; context?: ViewContext }
  | { v: 1; kind: "reveal"; rowId: string };

export type OpenTarget = "name" | "type" | "start" | "comment";

export type ViewToHost =
  | { v: 1; kind: "ready" }
  | { v: 1; kind: "open"; rowId: string; target: OpenTarget }
  | { v: 1; kind: "usages"; rowId: string }
  | { v: 1; kind: "openType"; rowId: string }
  | { v: 1; kind: "openText" }
  | { v: 1; kind: "pin"; pinned: boolean };

const TARGETS: ReadonlySet<string> = new Set<OpenTarget>(["name", "type", "start", "comment"]);

/** A message from the view, checked field by field: anything else is dropped. */
export function isViewToHost(x: unknown): x is ViewToHost {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  if (m.v !== 1 || typeof m.kind !== "string") return false;
  switch (m.kind) {
    case "ready":
    case "openText":
      return true;
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
