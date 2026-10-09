// SPDX-License-Identifier: BUSL-1.1
// Three-way merge of workspace text against TIA text, relative to the last synced base.
import { diff3Merge } from "node-diff3";
import { blankIds, networkKey, normalizeText, renumberIds, splitNetworks, type NetworkForm, type NetworkSplit } from "@rung/core";

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
      // declarations both sides added at the end of a section (a variable here, another in TIA Portal) both stay
      const c = r.conflict;
      if (!c.o.length && inDeclarations(out) && c.a.every(isDeclaration) && c.b.every(isDeclaration)) {
        out.push(...c.a, ...c.b);
        continue;
      }
      conflicts++;
      out.push(...markerLines(c.a, c.o, c.b));
    }
  }
  return conflicts ? { kind: "conflict", text: join(out), conflicts } : { kind: "clean", text: join(out) };
}

function markerLines(file: string[], base: string[], tia: string[]): string[] {
  return ["<<<<<<< file", ...file, "||||||| base", ...base, "=======", ...tia, ">>>>>>> tia"];
}
const markers = (a: string[], o: string[], b: string[]) => join(markerLines(a, o, b));

const DECLARATION = /^\s*("[^"]+"|[A-Za-z_]\w*)\s*(\{[^}]*\}\s*)?(AT\s+%\S+\s*)?:\s*[^;]+;\s*(\/\/.*)?$/i;
const isDeclaration = (l: string) => !l.trim() || /^\s*\/\//.test(l) || DECLARATION.test(l);
/** Whether the merged lines so far end inside a VAR section (or a STRUCT in one): where declarations stand. */
function inDeclarations(out: string[]): boolean {
  for (let i = out.length - 1; i >= 0; i--) {
    const l = out[i]!.trim().toUpperCase();
    if (/^END_VAR\b/.test(l) || /^BEGIN\b/.test(l)) return false;
    if (/^VAR(_\w+)?\b/.test(l)) return true;
  }
  return false;
}
/** Lines that are whole items of a YAML list at one indentation (test cases, steps), with their own deeper lines. */
function yamlItems(ls: string[], indent: string | undefined): string | undefined {
  const first = /^(\s*)- /.exec(ls[0] ?? "");
  if (!first || (indent !== undefined && first[1] !== indent)) return undefined;
  return ls.every((l) => !l.trim() || l.startsWith(`${first[1]}- `) || (/^\s*/.exec(l)![0].length > first[1]!.length)) ? first[1] : undefined;
}

/**
 * A three-way merge of a source for git (rung merge-driver): by line, as git merges, except where both sides only
 * added lines at the same place and those are declarations in a VAR section, or whole items of a YAML list (test
 * cases, steps): both additions stay, ours first. Two people who each declared a variable, or each wrote a test case,
 * get no conflict; anything else they both changed still is one.
 */
export function mergeSource(base: string, ours: string, theirs: string, path = ""): MergeResult {
  const a = normalizeText(ours);
  const b = normalizeText(theirs);
  const o = normalizeText(base);
  if (a === b || b === o) return { kind: "clean", text: a };
  if (a === o) return { kind: "clean", text: b };
  const yaml = /\.ya?ml$/i.test(path);
  const out: string[] = [];
  let conflicts = 0;
  for (const r of diff3Merge(lines(a), lines(o), lines(b), { excludeFalseConflicts: true })) {
    if (r.ok) {
      out.push(...r.ok);
      continue;
    }
    const c = r.conflict!;
    const both = !c.o.length && (yaml ? yamlItems(c.b, yamlItems(c.a, undefined)) !== undefined : inDeclarations(out) && c.a.every(isDeclaration) && c.b.every(isDeclaration));
    if (both) out.push(...c.a, ...c.b);
    else {
      conflicts++;
      out.push("<<<<<<< ours", ...c.a, "||||||| base", ...c.o, "=======", ...c.b, ">>>>>>> theirs");
    }
  }
  return conflicts ? { kind: "conflict", text: join(out), conflicts } : { kind: "clean", text: join(out) };
}

export const SOURCE_FORMS = new Set(["scl", "awl", "db", "udt", "st", "tags.st", "yaml"]);

export type BundleMerge = { kind: "clean"; files: Record<string, string> } | { kind: "conflict"; files: Record<string, string>; conflicts: number };

/**
 * A LAD/FBD block merged network by network: two people who changed different networks both keep their change.
 * Head and tail (interface, block texts) merge by line, the networks as whole units; a network changed on both
 * sides is a conflict. XML object IDs are compared without their numbers and numbered afresh. Undefined when the
 * text cannot be taken apart into networks.
 */
export function mergeNetworks(form: NetworkForm, base: string, file: string, tia: string): MergeResult | undefined {
  const parts = [base, file, tia].map((t) => splitNetworks(normalizeText(t), form));
  if (parts.some((p) => !p)) return undefined;
  const [b, f, t] = parts as NetworkSplit[];
  const blank = (s: string) => (form === "xml" ? blankIds(s) : s);
  const head = mergeText(blank(b!.head), blank(f!.head), blank(t!.head));
  const tail = mergeText(blank(b!.tail), blank(f!.tail), blank(t!.tail));
  const key = (u: string) => networkKey(u, form);
  const text = new Map<string, string>();
  for (const u of [...t!.networks, ...b!.networks, ...f!.networks]) text.set(key(u), blank(u)); // the file's own wins
  // networks are independent units: an unchanged separator between each two keeps changes to neighbouring networks
  // apart (a line merge, like git's, would join them into one conflict)
  const SEP = "\u0000network\u0000";
  const seq = (s: NetworkSplit) => [SEP, ...s.networks.flatMap((u) => [key(u), SEP])];
  const regions = diff3Merge(seq(f!), seq(b!), seq(t!), { excludeFalseConflicts: true });
  const conflicts = regions.filter((r) => r.conflict).length + (head.kind === "conflict" ? 1 : 0) + (tail.kind === "conflict" ? 1 : 0);
  if (conflicts) return { kind: "conflict", text: normalizeText(file), conflicts };
  const units = regions.flatMap((r) => r.ok ?? []).filter((k) => k !== SEP);
  const merged = head.text + units.map((k) => text.get(k)!).join("") + tail.text;
  return { kind: "clean", text: form === "xml" ? renumberIds(merged) : merged };
}

/**
 * Merge whole object bundles (suffix → text). Sources merge per file; LAD/FBD blocks (SimaticML, SD) network by
 * network, their other files (.s7res) only when one side left them as they were; other structural bundles
 * (watch tables, technology objects) conflict on concurrent changes.
 */
export function mergeBundle(form: string, base: Record<string, string> | null, file: Record<string, string>, tia: Record<string, string>): BundleMerge {
  const same = (a: Record<string, string> | null, b: Record<string, string>) =>
    !!a && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => normalizeText(b[k] ?? "\u0000") === normalizeText(v));
  if (same(file, tia)) return { kind: "clean", files: tia };
  if (same(base, file)) return { kind: "clean", files: tia };
  if (same(base, tia)) return { kind: "clean", files: file };
  if ((form === "xml" || form === "s7dcl") && base) {
    const primary = "." + form;
    const out: Record<string, string> = {};
    for (const k of [...new Set([...Object.keys(file), ...Object.keys(tia)])].sort()) {
      const [o, f, t] = [base[k], file[k], tia[k]].map((x) => (x === undefined ? undefined : normalizeText(x)));
      if (k === primary && o !== undefined && f !== undefined && t !== undefined) {
        const r = mergeNetworks(form, o, f, t);
        if (!r || r.kind === "conflict") return { kind: "conflict", files: file, conflicts: 1 };
        out[k] = r.text;
      } else if (o === f && o === t) {
        if (f !== undefined) out[k] = f;
      } else return { kind: "conflict", files: file, conflicts: 1 }; // the texts (.s7res) may refer to networks: not mixed
    }
    return { kind: "clean", files: out };
  }
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
