// SPDX-License-Identifier: BUSL-1.1
import { AddressError, escapeSegment, unescapeSegment, leafSegment, splitLeaf } from "./escape.js";

/** hardware: the network settings of a PLC (plc/<PLC>/hardware/network.yaml). */
export type ObjectKind = "block" | "type" | "tagtable" | "techobject" | "watchtable" | "forcetable" | "hardware";

export interface Address {
  device: string;
  unit?: string;
  kind: ObjectKind;
  groups: string[];
  name: string;
  namespace?: string;
}

/** st: IEC structured text of a CODESYS POU, DUT or GVL. tags.st: a TIA tag table as a global variable list. yaml: network settings. */
export type TextForm = "scl" | "awl" | "db" | "udt" | "s7dcl" | "xml" | "tags.xml" | "tags.st" | "protected.yaml" | "st" | "yaml";

export const KIND_DIR: Readonly<Record<ObjectKind, string>> = {
  block: "blocks",
  type: "types",
  tagtable: "tags",
  techobject: "techobjects",
  watchtable: "watch",
  forcetable: "force",
  hardware: "hardware",
};
const DIR_KIND = new Map(Object.entries(KIND_DIR).map(([k, v]) => [v, k as ObjectKind]));

/** Longest suffix first so "tags.xml" and "protected.yaml" win over "xml". */
const FORMS: readonly TextForm[] = ["protected.yaml", "tags.xml", "tags.st", "s7dcl", "scl", "awl", "db", "udt", "xml", "st", "yaml"];

export const FORMS_BY_KIND: Readonly<Record<ObjectKind, readonly TextForm[]>> = {
  block: ["scl", "awl", "db", "s7dcl", "xml", "protected.yaml", "st"],
  type: ["udt", "s7dcl", "xml", "protected.yaml", "st"],
  tagtable: ["tags.st", "tags.xml", "st"],
  techobject: ["xml"],
  watchtable: ["xml"],
  forcetable: ["xml"],
  hardware: ["yaml"],
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

/**
 * Why a file under plc/ that ends like a source is not one rung reads (a spelling rung never writes, such as
 * %2f for %2F, or a folder rung does not mirror), or undefined for sources and for files that are no source at all.
 */
export function ignoredSourceReason(p: string): string | undefined {
  if (!p.startsWith("plc/") || pathToAddress(p)) return undefined;
  const parts = p.slice(4).split("/");
  const file = parts[parts.length - 1]!;
  const forms = FORMS.filter((f) => file.endsWith("." + f));
  if (!forms.length) return undefined;
  const stemOf = (form: TextForm) => [...parts.slice(0, -1), file.slice(0, -(form.length + 1))];
  for (const form of forms) {
    let canonical: string;
    try {
      canonical = "plc/" + stemOf(form).map(respell).join("/") + "." + form;
    } catch {
      continue;
    }
    if (canonical !== p && pathToAddress(canonical)) return `rung spells this file ${canonical}; rename it`;
  }
  for (const form of forms) {
    try {
      const { address } = decode(stemOf(form));
      return `.${form} files are not read in ${KIND_DIR[address.kind]}/ (${FORMS_BY_KIND[address.kind].map((f) => "." + f).join(", ")})`;
    } catch {
      /* next */
    }
  }
  return `not in a folder rung mirrors (plc/<PLC>/${Object.values(KIND_DIR).join("|")}/…)`;
}

/** The canonical spelling of a segment someone typed (%2f for %2F, a raw character rung escapes). */
function respell(segment: string): string {
  const loose = (s: string) => s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  const i = segment.indexOf("~");
  return i > 0 ? `${escapeSegment(loose(segment.slice(0, i)))}~${escapeSegment(loose(segment.slice(i + 1)))}` : escapeSegment(loose(segment));
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
