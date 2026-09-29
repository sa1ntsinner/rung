// SPDX-License-Identifier: BUSL-1.1
// Three-way merge of workspace text against TIA text, relative to the last synced base.
import { diff3Merge } from "node-diff3";
import { normalizeText } from "@rung/core";

export type MergeResult = { kind: "clean"; text: string } | { kind: "conflict"; text: string; conflicts: number };

const lines = (s: string) => {
  const t = normalizeText(s);
  return t === "" ? [] : t.slice(0, -1).split("\n");
};
const join = (ls: string[]) => (ls.length ? ls.join("\n") + "\n" : "");

/**
 * Line-based diff3. Only BOM/line endings are normalized; everything else (keyword casing,
 * comments, spacing) is significant. `base = null` means the object is new on both sides.
 */
export function mergeText(base: string | null, file: string, tia: string): MergeResult {
  const f = normalizeText(file);
  const t = normalizeText(tia);
  if (f === t) return { kind: "clean", text: f };
  if (base === null) return { kind: "conflict", text: markers(lines(f), [], lines(t)), conflicts: 1 };
  const b = normalizeText(base);
  if (f === b) return { kind: "clean", text: t };
  if (t === b) return { kind: "clean", text: f };
  const regions = diff3Merge(lines(f), lines(b), lines(t), { excludeFalseConflicts: true });
  let conflicts = 0;
  const out: string[] = [];
  for (const r of regions) {
    if (r.ok) out.push(...r.ok);
    else if (r.conflict) {
      conflicts++;
      out.push(...markerLines(r.conflict.a, r.conflict.o, r.conflict.b));
    }
  }
  return conflicts ? { kind: "conflict", text: join(out), conflicts } : { kind: "clean", text: join(out) };
}

function markerLines(file: string[], base: string[], tia: string[]): string[] {
  return ["<<<<<<< file", ...file, "||||||| base", ...base, "=======", ...tia, ">>>>>>> tia"];
}
const markers = (a: string[], o: string[], b: string[]) => join(markerLines(a, o, b));

export const SOURCE_FORMS = new Set(["scl", "awl", "db", "udt"]);

export type BundleMerge = { kind: "clean"; files: Record<string, string> } | { kind: "conflict"; files: Record<string, string>; conflicts: number };

/**
 * Merge whole object bundles (suffix → text). Sources merge per file; SD/XML/resource bundles are
 * structural, so concurrent changes always conflict.
 */
export function mergeBundle(form: string, base: Record<string, string> | null, file: Record<string, string>, tia: Record<string, string>): BundleMerge {
  const same = (a: Record<string, string> | null, b: Record<string, string>) =>
    !!a && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => normalizeText(b[k] ?? "\u0000") === normalizeText(v));
  if (same(file, tia)) return { kind: "clean", files: tia };
  if (same(base, file)) return { kind: "clean", files: tia };
  if (same(base, tia)) return { kind: "clean", files: file };
  if (!SOURCE_FORMS.has(form)) return { kind: "conflict", files: file, conflicts: 1 };
  const keys = [...new Set([...Object.keys(file), ...Object.keys(tia)])].sort();
  const out: Record<string, string> = {};
  let conflicts = 0;
  for (const k of keys) {
    const r = mergeText(base?.[k] ?? null, file[k] ?? "", tia[k] ?? "");
    out[k] = r.text;
    if (r.kind === "conflict") conflicts += r.conflicts;
  }
  return conflicts ? { kind: "conflict", files: out, conflicts } : { kind: "clean", files: out };
}
