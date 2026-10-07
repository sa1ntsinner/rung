// SPDX-License-Identifier: BUSL-1.1
// What a change of a block's interface affects, before it goes to TIA Portal: the parameters and statics that went,
// came or changed type against the last synced version; the calls that pass a parameter the block no longer has (or
// leave out one an FC now wants); the instance DBs TIA Portal reinitialises on download (multi-instances included:
// the FB that holds one changes its own layout); the unit tests that name what went.
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BlobStore, type ObjectState } from "@rung/core";
import type { BlockModel, VarDecl } from "./parser.js";
import { callSites } from "./calls.js";
import { callsOf, scopeDecl } from "./features.js";
import { testModel } from "./testModel.js";
import { deviceOfUri, scopedTo, WorkspaceIndex } from "./workspace.js";

export interface InterfaceChange {
  kind: "removed" | "added" | "retyped" | "renamed" | "reordered";
  section: string;
  name: string;
  /** renamed: the new name */
  to?: string;
  before?: string;
  after?: string;
}

export interface ImpactSite {
  block: string;
  uri: string;
  line: number;
  /** what breaks or changes at this place; empty: it compiles again unchanged */
  problems: string[];
}

export interface Impact {
  block: string;
  kind: string;
  changes: InterfaceChange[];
  /** the data layout changed: instance DBs (FB) or DBs of the type (UDT) start over from start values */
  reinit: boolean;
  calls: ImpactSite[];
  /** instance DBs, multi-instances and (UDT) users whose data starts over */
  instances: { name: string; uri: string; via?: string }[];
  tests: ImpactSite[];
}

/** Sections other blocks see: what a call passes, what an instance DB holds, what a data type is made of. */
const OUTER: Record<string, string[]> = { FB: ["Input", "Output", "InOut", "Static"], FC: ["Input", "Output", "InOut"], UDT: ["Member"] };
const LAYOUT = new Set(["Input", "Output", "InOut", "Static", "Member"]);

const squeeze = (t: string) => t.replace(/\s+/g, "").toUpperCase();
const typeText = (v: VarDecl): string => (v.members?.length ? `Struct(${v.members.map((m) => `${m.name}:${typeText(m)}`).join(";")})` : v.type);

function diff(kind: string, before: BlockModel, after: BlockModel): InterfaceChange[] {
  const out: InterfaceChange[] = [];
  for (const section of OUTER[kind] ?? []) {
    const a = before.vars.filter((v) => v.section === section);
    const b = after.vars.filter((v) => v.section === section);
    const key = (v: VarDecl) => v.name.toUpperCase();
    const gone = a.filter((v) => !b.some((w) => key(w) === key(v)));
    const came = b.filter((v) => !a.some((w) => key(w) === key(v)));
    for (const v of a) {
      const w = b.find((x) => key(x) === key(v));
      if (w && squeeze(typeText(v)) !== squeeze(typeText(w))) out.push({ kind: "retyped", section, name: w.name, before: typeText(v), after: typeText(w) });
    }
    // one went and one of the same type came in the same section: most likely a rename
    if (gone.length === 1 && came.length === 1 && squeeze(typeText(gone[0]!)) === squeeze(typeText(came[0]!))) {
      out.push({ kind: "renamed", section, name: gone[0]!.name, to: came[0]!.name, after: came[0]!.type });
      continue;
    }
    for (const v of gone) out.push({ kind: "removed", section, name: v.name, before: v.type });
    for (const v of came) out.push({ kind: "added", section, name: v.name, after: v.type });
    // the same declarations in another order: a call names its parameters, but the instance data is laid out anew
    const kept = (list: VarDecl[]) => list.filter((v) => a.some((x) => key(x) === key(v)) && b.some((x) => key(x) === key(v))).map(key);
    if (kept(a).join() !== kept(b).join()) out.push({ kind: "reordered", section, name: b.filter((v) => a.some((x) => key(x) === key(v))).map((v) => v.name).join(", ") });
  }
  if (kind === "FC" && squeeze(before.returnType ?? "VOID") !== squeeze(after.returnType ?? "VOID"))
    out.push({ kind: "retyped", section: "Return", name: after.name, before: before.returnType ?? "Void", after: after.returnType ?? "Void" });
  return out;
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;
/** The names a change takes away from users: removed and renamed ones (their old names). */
const goneNames = (changes: InterfaceChange[]) => new Set(changes.filter((c) => c.kind === "removed" || c.kind === "renamed").map((c) => c.name.toUpperCase()));

/** The blocks that hold `fb` as a multi-instance, and their instance DBs, down the chain. */
function instancesOf(index: WorkspaceIndex, fb: string, from: string, seen = new Set<string>()): Impact["instances"] {
  const u = fb.toUpperCase();
  if (seen.has(u)) return [];
  seen.add(u);
  const scoped = scopedTo(index, from);
  const own = scoped.global(fb);
  const out: Impact["instances"] = [];
  for (const g of scoped.allGlobals()) {
    const b = g.block;
    if (!b || scoped.global(g.name) !== g) continue;
    if (b.kind === "DB" && b.dbOf?.toUpperCase() === u) out.push({ name: g.name, uri: g.uri });
    if (b.kind !== "FB" && b.kind !== "DB" && b.kind !== "UDT") continue;
    // declared directly or inside a STRUCT: Motor, or Data.Pos
    const holders: string[] = [];
    const walk = (vars: VarDecl[], prefix: string) => {
      for (const v of vars) {
        if (v.section === "Temp") continue;
        if (v.typeRef?.toUpperCase() === u) holders.push(prefix + v.name);
        else if (v.members?.length) walk(v.members, `${prefix}${v.name}.`);
      }
    };
    walk(b.vars, "");
    if (!holders.length || (own && scopedTo(index, g.uri).global(fb) !== own)) continue;
    for (const h of holders) out.push({ name: `${g.name}.${h}`, uri: g.uri, via: g.name });
    // the block that holds it changed its own layout: its instances (or users) start over too
    if (b.kind !== "DB") out.push(...instancesOf(index, g.name, g.uri, seen).map((i) => ({ ...i, via: i.via ?? g.name })));
  }
  return out;
}

/** The text TIA Portal has of a workspace file (its base, the last synced version); undefined when never synced. */
export async function baseText(root: string, uri: string): Promise<string | undefined> {
  const rel = relative(root, fileURLToPath(uri)).replace(/\\/g, "/");
  try {
    // read without the writer lock: safe while rung watch runs
    const doc = JSON.parse(await readFile(join(root, ".rung", "state.json"), "utf8")) as { objects: Record<string, ObjectState> };
    const o = Object.values(doc.objects).find((s) => s.path === rel);
    const primary = o?.files.find((f) => f.path === rel) ?? o?.files.find((f) => f.role === "primary");
    return primary ? (await new BlobStore(root).get(primary.hash)).toString("utf8").replace(/\r\n/g, "\n") : undefined;
  } catch {
    return undefined;
  }
}

/** The workspace's unit tests: every *.test.yaml under tests/. */
export async function workspaceTests(root: string): Promise<{ uri: string; text: string }[]> {
  const names = (await readdir(join(root, "tests"), { recursive: true }).catch(() => [] as string[])).map(String);
  return Promise.all(names.filter((n) => /\.test\.ya?ml$/i.test(n)).map(async (n) => ({ uri: pathToFileURL(join(root, "tests", n)).href, text: await readFile(join(root, "tests", n), "utf8") })));
}

/**
 * The impact of the interface in `index` at `uri` against `before` (the text TIA Portal has, the last synced
 * version). undefined when the file holds no FB, FC or data type.
 */
export function interfaceImpact(index: WorkspaceIndex, uri: string, before: string, tests: { uri: string; text: string }[] = []): Impact | undefined {
  const doc = index.docs.get(uri);
  const after = doc?.parsed?.blocks.find((b) => b.kind in OUTER);
  if (!doc || !after) return undefined;
  // the old text read as the index reads this kind of file
  const old = new WorkspaceIndex();
  old.set(uri, before, 0);
  const was = old.docs.get(uri)?.parsed?.blocks.find((b) => b.kind === after.kind && b.name.toUpperCase() === after.name.toUpperCase()) ?? old.docs.get(uri)?.parsed?.blocks.find((b) => b.kind === after.kind);
  const changes = was ? diff(after.kind, was, after) : [];
  const impact: Impact = { block: after.name, kind: after.kind, changes, reinit: changes.some((c) => LAYOUT.has(c.section)) && after.kind !== "FC", calls: [], instances: [], tests: [] };
  if (!changes.length) return impact;
  const gone = goneNames(changes);
  if (after.kind === "FB" || after.kind === "FC") {
    const added = changes.filter((c) => c.kind === "added" || c.kind === "renamed");
    const retyped = new Map(changes.filter((c) => c.kind === "retyped" && c.section !== "Return").map((c) => [c.name.toUpperCase(), c]));
    const sites = new Map<string, ReturnType<typeof callSites>>();
    for (const call of callsOf(index, after, uri)) {
      const text = index.docs.get(call.uri)?.text ?? "";
      const scoped = scopedTo(index, call.uri);
      const all = sites.get(call.uri) ?? (sites.set(call.uri, callSites(scoped, call.uri, (b, n) => scopeDecl(scoped, call.uri, b, n))), sites.get(call.uri)!);
      const site = all.find((s) => s.ref.start === call.start);
      const problems: string[] = [];
      for (const a of site?.args ?? []) {
        const n = a.name?.toUpperCase();
        if (!n) continue;
        const renamed = changes.find((c) => c.kind === "renamed" && c.name.toUpperCase() === n);
        if (renamed) problems.push(`passes ${a.name}, now ${renamed.to}`);
        else if (gone.has(n)) problems.push(`passes ${a.name}, which ${after.name} no longer has`);
        const r = retyped.get(n);
        if (r) problems.push(`passes ${a.name}, now ${r.after} (was ${r.before})`);
      }
      // an FC call names every parameter (TIA Portal wants them all); an FB's new input keeps its start value
      if (after.kind === "FC" && site && site.args.every((a) => a.name))
        for (const c of added) {
          const name = (c.to ?? c.name).toUpperCase();
          if (!site.args.some((a) => a.name?.toUpperCase() === name)) problems.push(`does not pass ${c.to ?? c.name} (${c.section === "InOut" ? "in/out" : c.section.toLowerCase()}), new`);
        }
      impact.calls.push({ block: call.block, uri: call.uri, line: lineOf(text, call.start), problems });
    }
  }
  if (impact.reinit) impact.instances = instancesOf(index, after.name, uri);
  // tests of the block, and stubs of it in other tests, naming what went
  const own = after.name.toUpperCase();
  const device = deviceOfUri(uri);
  for (const t of tests) {
    const m = testModel(t.text);
    // a test that names another PLC tests that PLC's block of this name
    if (m.plc && device && m.plc.value.toUpperCase() !== device.toUpperCase()) continue;
    const problems: string[] = [];
    const check = (key: string, where: string) => {
      const head = key.replace(/^#/, "").split(/[.[]/)[0]!.replace(/^"|"$/g, "").toUpperCase();
      if (!key.startsWith('"') && gone.has(head)) {
        const renamed = changes.find((c) => c.kind === "renamed" && c.name.toUpperCase() === head);
        problems.push(`${where} ${key}${renamed ? `, now ${renamed.to}` : `, which ${after.name} no longer has`}`);
      }
    };
    if (m.block?.value.toUpperCase() === own)
      for (const c of m.cases) for (const s of c.steps) {
        for (const e of s.set?.entries ?? []) check(e.key, `case ${c.index + 1} sets`);
        for (const e of s.expect?.entries ?? []) check(e.key, `case ${c.index + 1} expects`);
      }
    for (const s of m.stubs) if (s.name.replace(/^"|"$/g, "").toUpperCase() === own) for (const e of s.entries) check(e.key, "its stub sets");
    if (problems.length || m.block?.value.toUpperCase() === own) impact.tests.push({ block: m.block?.value ?? "", uri: t.uri, line: 1, problems: [...new Set(problems)] });
  }
  return impact;
}
