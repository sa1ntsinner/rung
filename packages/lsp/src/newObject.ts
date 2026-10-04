// SPDX-License-Identifier: BUSL-1.1
// A new object's file (rung/newObject): the path the workspace keeps it at (docs/format/README.md) and the text TIA
// Portal V20 exports for a new object of that kind, so the first sync changes nothing back. Checked by import,
// compile and export in TIA Portal V20: an FB or FC without declarations has no sections; a DB and a UDT need one
// member (a structure without components does not compile).
import { addressToPath, findCaseCollisions, type ObjectKind, type TextForm } from "@rung/core";

export type NewKind = "FB" | "FC" | "DB" | "UDT" | "TAGS";

export interface NewObjectRequest {
  kind: NewKind;
  name: string;
  plc: string;
  unit?: string;
  /** folders below blocks/, types/ or tags/ */
  groups?: string[];
  /** an FC's return type (Void when not given) */
  returnType?: string;
}

/** What the PLC already has: block names (FB, FC, DB, OB share one list), data types, tag tables (lowercase); files. */
export interface Existing {
  names: Set<string>;
  types: Set<string>;
  tables: Set<string>;
  paths: string[];
}

const KIND: Record<NewKind, { kind: ObjectKind; form: TextForm }> = {
  FB: { kind: "block", form: "scl" },
  FC: { kind: "block", form: "scl" },
  DB: { kind: "block", form: "db" },
  UDT: { kind: "type", form: "udt" },
  TAGS: { kind: "tagtable", form: "tags.st" },
};

function template(kind: NewKind, name: string, returnType?: string): string {
  const q = `"${name}"`;
  switch (kind) {
    case "FB":
      return `FUNCTION_BLOCK ${q}\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\n\nBEGIN\nEND_FUNCTION_BLOCK\n\n`;
    case "FC":
      return `FUNCTION ${q} : ${returnType?.trim() || "Void"}\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\n\nBEGIN\nEND_FUNCTION\n\n`;
    case "DB":
      return `DATA_BLOCK ${q}\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\nNON_RETAIN\n   VAR \n      Tag_1 : Bool;\n   END_VAR\n\n\nBEGIN\n\nEND_DATA_BLOCK\n\n`;
    case "UDT":
      return `TYPE ${q}\nVERSION : 0.1\n   STRUCT\n      Tag_1 : Bool;\n   END_STRUCT;\n\nEND_TYPE\n\n`;
    case "TAGS":
      // the header the bridge writes on every tag table it exports (bridge/src/Rung.Bridge.Core/TagTableText.cs)
      return (
        `// PLC tag table ${name} in TIA Portal; rung sync writes changes to TIA Portal.\n` +
        "// A tag: Name AT %address : Type;  // comment        A constant: Name : Type := value;\n" +
        "// {ExternalAccessible := 'false'} hides a tag from HMI and OPC UA; ExternalVisible and ExternalWritable likewise.\n" +
        "VAR_GLOBAL\nEND_VAR\n"
      );
  }
}

export function newObject(req: NewObjectRequest, existing: Existing): { path: string; text: string } | { reason: string } {
  const name = req.name;
  if (!name.trim()) return { reason: "A new object needs a name." };
  if (name !== name.trim()) return { reason: "A name cannot start or end with a space." };
  if (name.includes('"')) return { reason: 'A name cannot contain ".' };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { reason: "A name cannot contain control characters." };
  if (name.length > 125) return { reason: "TIA Portal names are at most 125 characters." };
  const key = name.toLowerCase();
  if ((req.kind === "FB" || req.kind === "FC" || req.kind === "DB") && existing.names.has(key)) return { reason: `${req.plc} already has a block ${name}.` };
  if (req.kind === "UDT" && existing.types.has(key)) return { reason: `${req.plc} already has a data type ${name}.` };
  if (req.kind === "TAGS" && existing.tables.has(key)) return { reason: `${req.plc} already has a tag table ${name}.` };
  if (req.kind === "FC" && req.returnType && !/^("[^"]+"|[A-Za-z_]\w*(\s*\[[^\]]+\])?)$/.test(req.returnType.trim())) return { reason: `"${req.returnType}" is not a data type.` };
  const k = KIND[req.kind];
  let path: string;
  try {
    path = addressToPath({ device: req.plc, ...(req.unit ? { unit: req.unit } : {}), kind: k.kind, groups: req.groups ?? [], name }, k.form);
  } catch (e) {
    return { reason: (e as Error).message };
  }
  // a file there, or one whose name differs only in letter case (Windows keeps one of them)
  const clash = findCaseCollisions([...existing.paths, path]).find(([a, b]) => a === path || b === path);
  if (clash || existing.paths.includes(path)) return { reason: `${clash ? (clash[0] === path ? clash[1] : clash[0]) : path} is already there.` };
  return { path, text: template(req.kind, name, req.returnType) };
}
