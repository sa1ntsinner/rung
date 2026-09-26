// SPDX-License-Identifier: BUSL-1.1
import { AddressError, escapeSegment, unescapeSegment, leafSegment, splitLeaf } from "./escape.js";

export type ObjectKind = "block" | "type" | "tagtable" | "techobject" | "watchtable" | "forcetable";

export interface Address {
  device: string;
  unit?: string;
  kind: ObjectKind;
  groups: string[];
  name: string;
  namespace?: string;
}

export type TextForm = "scl" | "awl" | "db" | "udt" | "s7dcl" | "xml" | "tags.xml" | "protected.yaml";

export const KIND_DIR: Readonly<Record<ObjectKind, string>> = {
  block: "blocks",
  type: "types",
  tagtable: "tags",
  techobject: "techobjects",
  watchtable: "watch",
  forcetable: "force",
};
const DIR_KIND = new Map(Object.entries(KIND_DIR).map(([k, v]) => [v, k as ObjectKind]));

/** Longest suffix first so "tags.xml" and "protected.yaml" win over "xml". */
const FORMS: readonly TextForm[] = ["protected.yaml", "tags.xml", "s7dcl", "scl", "awl", "db", "udt", "xml"];

export const FORMS_BY_KIND: Readonly<Record<ObjectKind, readonly TextForm[]>> = {
  block: ["scl", "awl", "db", "s7dcl", "xml", "protected.yaml"],
  type: ["udt", "s7dcl", "xml", "protected.yaml"],
  tagtable: ["tags.xml"],
  techobject: ["xml"],
  watchtable: ["xml"],
  forcetable: ["xml"],
};

function segments(a: Address): string[] {
  if (!DIR_KIND.has(KIND_DIR[a.kind]) || a.unit === "") throw new AddressError("invalid address");
  return [
    escapeSegment(a.device),
    ...(a.unit !== undefined ? ["units", escapeSegment(a.unit)] : []),
    KIND_DIR[a.kind],
    ...a.groups.map(escapeSegment),
    leafSegment(a),
  ];
}

export function formatAddress(a: Address): string {
  return "plc:" + segments(a).join("/");
}

function decode(parts: string[]): { address: Address; leaf: string } {
  let i = 1;
  let unit: string | undefined;
  if (parts[1] === "units") {
    unit = unescapeSegment(parts[2] ?? "");
    i = 3;
  }
  const kind = DIR_KIND.get(parts[i] ?? "");
  if (!kind || parts.length < i + 2) throw new AddressError("invalid address");
  const leaf = parts[parts.length - 1]!;
  const { name, namespace } = splitLeaf(leaf);
  const address: Address = { device: unescapeSegment(parts[0]!), kind, groups: parts.slice(i + 1, -1).map(unescapeSegment), name };
  if (unit !== undefined) address.unit = unit;
  if (namespace !== undefined) address.namespace = namespace;
  return { address, leaf };
}

export function parseAddress(s: string): Address {
  try {
    if (!s.startsWith("plc:")) throw new AddressError("missing plc: prefix");
    const { address } = decode(s.slice(4).split("/"));
    if (formatAddress(address) !== s) throw new AddressError("noncanonical");
    return address;
  } catch {
    throw new AddressError(`invalid address: ${s}`);
  }
}

/** Workspace-relative POSIX path of an object's primary file. */
export function addressToPath(a: Address, form: TextForm): string {
  if (!FORMS_BY_KIND[a.kind]?.includes(form)) throw new AddressError(`form ${form} not allowed for ${a.kind}`);
  return "plc/" + segments(a).join("/") + "." + form;
}

/** Primary path without the form extension; companions append their own suffix to it. */
export function addressToStem(a: Address): string {
  return "plc/" + segments(a).join("/");
}

export function pathToAddress(p: string): { address: Address; form: TextForm } | null {
  if (p.includes("\\") || !p.startsWith("plc/")) return null;
  const parts = p.slice(4).split("/");
  const file = parts[parts.length - 1]!;
  // A leaf may itself end in something that looks like a form (block "Valve.tags" as xml): try every suffix.
  for (const form of FORMS) {
    if (!file.endsWith("." + form)) continue;
    try {
      const candidate = [...parts.slice(0, -1), file.slice(0, -(form.length + 1))];
      const { address } = decode(candidate);
      if (addressToPath(address, form) === p) return { address, form };
    } catch {
      /* try the next form */
    }
  }
  return null;
}

/** Pairs of paths that would land on the same file on case-insensitive or normalizing filesystems. */
export function findCaseCollisions(paths: readonly string[]): [string, string][] {
  const seen = new Map<string, string>();
  const out: [string, string][] = [];
  for (const p of paths) {
    const key = p.normalize("NFC").toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined) out.push([prev, p]);
    else seen.set(key, p);
  }
  return out;
}
