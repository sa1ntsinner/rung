// SPDX-License-Identifier: MIT
// Read-only view of .rung/state.json (shape: packages/core/src/state.ts) and the project tree built from it.
// No vscode import: unit-tested with vitest.
import type { BlockType } from "./headers";

export type ObjectStatus =
  | "synced"
  | "conflicted"
  | "pending"
  | "fileDirty"
  | "tiaDirty"
  | "bothDirty"
  | "importing"
  | "exporting"
  | "merging"
  | "pendingDelete"
  | "recoveryRequired";

export interface StateObject {
  address: string;
  /** Workspace-relative POSIX path of the primary file. */
  path: string;
  form: string;
  readOnly: boolean;
  warnings: string[];
  status: ObjectStatus;
}

export interface StateDoc {
  format: number;
  workspaceId?: string;
  binding?: { projectPath: string; tiaVersion: string; devices: string[] };
  objects: Record<string, StateObject>;
}

/** Parses state.json text; returns undefined for anything that is not a format-1 state document. */
export function parseState(text: string): StateDoc | undefined {
  try {
    const doc = JSON.parse(text) as StateDoc;
    if (!doc || typeof doc !== "object" || doc.format !== 1 || typeof doc.objects !== "object" || doc.objects === null) return undefined;
    return doc;
  } catch {
    return undefined;
  }
}

export type ObjectKind = "block" | "type" | "tagtable" | "techobject" | "watchtable" | "forcetable" | "hardware";

const DIR_KIND: Readonly<Record<string, ObjectKind>> = {
  blocks: "block",
  types: "type",
  tags: "tagtable",
  techobjects: "techobject",
  watch: "watchtable",
  force: "forcetable",
  hardware: "hardware",
};

export const KIND_ORDER: readonly ObjectKind[] = ["block", "type", "tagtable", "techobject", "watchtable", "forcetable", "hardware"];

export const KIND_LABEL: Readonly<Record<ObjectKind, string>> = {
  block: "Program blocks",
  type: "PLC data types",
  tagtable: "PLC tags",
  techobject: "Technology objects",
  watchtable: "Watch tables",
  forcetable: "Force tables",
  hardware: "Network settings",
};

export interface ParsedAddress {
  device: string;
  unit?: string;
  kind: ObjectKind;
  groups: string[];
  name: string;
  namespace?: string;
}

function unescape(seg: string): string {
  return seg.replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Decodes "plc:<device>[/units/<unit>]/<kind dir>/<group>…/<leaf>" (docs/format/README.md). */
export function parseAddress(address: string): ParsedAddress | undefined {
  if (!address.startsWith("plc:")) return undefined;
  const parts = address.slice(4).split("/");
  let i = 1;
  let unit: string | undefined;
  if (parts[1] === "units") {
    if (!parts[2]) return undefined;
    unit = unescape(parts[2]);
    i = 3;
  }
  const kind = DIR_KIND[parts[i] ?? ""];
  if (!kind || parts.length < i + 2 || !parts[0]) return undefined;
  const leaf = parts[parts.length - 1]!;
  const tilde = leaf.indexOf("~");
  const out: ParsedAddress = {
    device: unescape(parts[0]),
    kind,
    groups: parts.slice(i + 1, -1).map(unescape),
    name: unescape(tilde < 0 ? leaf : leaf.slice(tilde + 1)),
  };
  if (unit !== undefined) out.unit = unit;
  if (tilde >= 0) out.namespace = unescape(leaf.slice(0, tilde));
  return out;
}

export type SyncFlag = "conflict" | "fileDirty" | "tiaDirty" | "bothDirty" | "busy" | "pendingDelete" | "recovery";

export function syncFlag(status: ObjectStatus): SyncFlag | undefined {
  switch (status) {
    case "conflicted":
      return "conflict";
    case "fileDirty":
    case "pending":
      return "fileDirty";
    case "tiaDirty":
      return "tiaDirty";
    case "bothDirty":
      return "bothDirty";
    case "merging":
    case "importing":
    case "exporting":
      return "busy";
    case "pendingDelete":
      return "pendingDelete";
    case "recoveryRequired":
      return "recovery";
    default:
      return undefined;
  }
}

export const FLAG_TEXT: Readonly<Record<SyncFlag, string>> = {
  conflict: "conflict",
  fileDirty: "changed here",
  tiaDirty: "changed in TIA",
  bothDirty: "changed on both sides",
  busy: "syncing",
  pendingDelete: "delete pending",
  recovery: "needs recovery",
};

export interface ObjectInfo extends ParsedAddress {
  address: string;
  path: string;
  form: string;
  readOnly: boolean;
  status: ObjectStatus;
  flag?: SyncFlag;
  warnings: string[];
  blockType?: BlockType;
}

export type TreeNode =
  | { type: "device"; id: string; label: string; device: string; children: TreeNode[]; conflicts: number; count: number }
  | { type: "unit"; id: string; label: string; device: string; children: TreeNode[]; conflicts: number; count: number }
  | { type: "section"; id: string; label: string; kind: ObjectKind; children: TreeNode[]; conflicts: number; count: number }
  | { type: "folder"; id: string; label: string; children: TreeNode[]; conflicts: number; count: number }
  | { type: "object"; id: string; label: string; object: ObjectInfo; description: string };

export type ContainerNode = Exclude<TreeNode, { type: "object" }>;

export interface TreeOptions {
  /** "folder": TIA folders under each section. "kind": blocks split by OB/FB/FC/DB, folders shown as description. */
  grouping: "folder" | "kind";
  showReadOnly: boolean;
  /** Block type of an object's primary file when known (sniffed from its header). */
  blockType?: (o: StateObject) => BlockType | undefined;
}

const BLOCK_GROUPS: readonly { type: BlockType | undefined; label: string }[] = [
  { type: "OB", label: "Organization blocks (OB)" },
  { type: "FB", label: "Function blocks (FB)" },
  { type: "FC", label: "Functions (FC)" },
  { type: "DB", label: "Data blocks (DB)" },
  { type: undefined, label: "Other blocks" },
];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function objectsOf(doc: StateDoc | undefined, opts: Pick<TreeOptions, "blockType"> = {}): ObjectInfo[] {
  if (!doc) return [];
  const out: ObjectInfo[] = [];
  for (const o of Object.values(doc.objects)) {
    const a = parseAddress(o.address);
    if (!a) continue;
    const info: ObjectInfo = { ...a, address: o.address, path: o.path, form: o.form, readOnly: !!o.readOnly, status: o.status, warnings: o.warnings ?? [] };
    const flag = syncFlag(o.status);
    if (flag) info.flag = flag;
    const bt = opts.blockType?.(o);
    if (bt) info.blockType = bt;
    else if (o.form === "udt" || a.kind === "type") info.blockType = "UDT";
    else if (o.form === "db") info.blockType = "DB";
    out.push(info);
  }
  return out;
}

export function describeObject(o: ObjectInfo, withFolder: boolean): string {
  const parts: string[] = [];
  if (o.flag) parts.push(FLAG_TEXT[o.flag]);
  if (o.readOnly) parts.push("read-only");
  if (withFolder && o.groups.length) parts.push(o.groups.join("/"));
  return parts.join(" · ");
}

function objectNode(o: ObjectInfo, withFolder: boolean): TreeNode {
  return { type: "object", id: `obj:${o.address}`, label: o.namespace ? `${o.namespace}.${o.name}` : o.name, object: o, description: describeObject(o, withFolder) };
}

function tally(children: TreeNode[]): { conflicts: number; count: number } {
  let conflicts = 0;
  let count = 0;
  for (const c of children) {
    if (c.type === "object") {
      count++;
      if (c.object.flag === "conflict") conflicts++;
    } else {
      count += c.count;
      conflicts += c.conflicts;
    }
  }
  return { conflicts, count };
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    const fa = a.type === "object" ? 1 : 0;
    const fb = b.type === "object" ? 1 : 0;
    return fa - fb || collator.compare(a.label, b.label);
  });
}

function folderTree(objects: ObjectInfo[], idPrefix: string): TreeNode[] {
  interface Dir {
    dirs: Map<string, Dir>;
    items: ObjectInfo[];
  }
  const root: Dir = { dirs: new Map(), items: [] };
  for (const o of objects) {
    let d = root;
    for (const g of o.groups) {
      let next = d.dirs.get(g);
      if (!next) d.dirs.set(g, (next = { dirs: new Map(), items: [] }));
      d = next;
    }
    d.items.push(o);
  }
  const build = (d: Dir, path: string): TreeNode[] =>
    sortNodes([
      ...[...d.dirs].map(([name, sub]): TreeNode => {
        const id = `${path}/${name}`;
        const children = build(sub, id);
        return { type: "folder", id, label: name, children, ...tally(children) };
      }),
      ...d.items.map((o) => objectNode(o, false)),
    ]);
  return build(root, idPrefix);
}

function sectionChildren(kind: ObjectKind, objects: ObjectInfo[], opts: TreeOptions, idPrefix: string): TreeNode[] {
  if (opts.grouping === "folder") return folderTree(objects, idPrefix);
  if (kind !== "block") return sortNodes(objects.map((o) => objectNode(o, true)));
  const groups: TreeNode[] = [];
  for (const g of BLOCK_GROUPS) {
    const items = objects.filter((o) => (g.type ? o.blockType === g.type : !o.blockType || !["OB", "FB", "FC", "DB"].includes(o.blockType)));
    if (!items.length) continue;
    const children = sortNodes(items.map((o) => objectNode(o, true)));
    groups.push({ type: "folder", id: `${idPrefix}/#${g.type ?? "other"}`, label: g.label, children, ...tally(children) });
  }
  return groups;
}

function sections(objects: ObjectInfo[], opts: TreeOptions, idPrefix: string): TreeNode[] {
  const out: TreeNode[] = [];
  for (const kind of KIND_ORDER) {
    const items = objects.filter((o) => o.kind === kind);
    if (!items.length) continue;
    const id = `${idPrefix}/${kind}`;
    const children = sectionChildren(kind, items, opts, id);
    out.push({ type: "section", id, label: KIND_LABEL[kind], kind, children, ...tally(children) });
  }
  return out;
}

/** device → (software unit →) section → folders/block types → objects. */
export function buildTree(objects: readonly ObjectInfo[], opts: TreeOptions): TreeNode[] {
  const visible = objects.filter((o) => opts.showReadOnly || !o.readOnly);
  const devices = [...new Set(visible.map((o) => o.device))].sort(collator.compare);
  return devices.map((device) => {
    const mine = visible.filter((o) => o.device === device);
    const id = `dev:${device}`;
    const plain = mine.filter((o) => o.unit === undefined);
    const units = [...new Set(mine.filter((o) => o.unit !== undefined).map((o) => o.unit!))].sort(collator.compare);
    const children: TreeNode[] = [
      ...sections(plain, opts, id),
      ...units.map((unit): TreeNode => {
        const uid = `${id}/units/${unit}`;
        const c = sections(
          mine.filter((o) => o.unit === unit),
          opts,
          uid,
        );
        return { type: "unit", id: uid, label: `Software unit ${unit}`, device, children: c, ...tally(c) };
      }),
    ];
    return { type: "device", id, label: device, device, children, ...tally(children) };
  });
}

/** Summary used by the status bar and view badge. */
export function summarize(objects: readonly ObjectInfo[]): { total: number; conflicts: string[]; dirty: number; readOnly: number } {
  return {
    total: objects.length,
    conflicts: objects.filter((o) => o.flag === "conflict").map((o) => o.path),
    dirty: objects.filter((o) => o.flag === "fileDirty" || o.flag === "tiaDirty" || o.flag === "bothDirty" || o.flag === "busy").length,
    readOnly: objects.filter((o) => o.readOnly).length,
  };
}

/** Devices named in state addresses, sorted. */
export function devicesInState(doc: StateDoc | undefined): string[] {
  const out = new Set<string>();
  for (const o of Object.values(doc?.objects ?? {})) {
    const a = parseAddress(o.address);
    if (a) out.add(a.device);
  }
  return [...out].sort(collator.compare);
}
