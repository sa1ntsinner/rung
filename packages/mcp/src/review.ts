// SPDX-License-Identifier: BUSL-1.1
// Offline evidence for a person reviewing source changes. Nothing here opens TIA Portal or a PLC.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodeGraph } from "@rung/graph";
import { WorkspaceIndex, deviceOfUri, interfaceImpact, ladderOf, uriOf, workspaceTests, type BlockModel, type Doc, type InterfaceChange, type VarDecl } from "@rung/lsp";
import { diffIndices } from "node-diff3";

const run = promisify(execFile);
const source = /\.(scl|db|udt|awl|st|s7dcl|xml|protected\.yaml)$/i;
const slash = (s: string) => s.split(sep).join("/");
const normalized = (s: string) => s.replace(/\r\n/g, "\n");
const signature = (v: VarDecl): string => v.members?.length ? `${v.type}(${v.members.map((m) => `${m.name}:${signature(m)}`).join(";")})` : v.type;

export interface LogicChange {
  name: string;
  kind: "region" | "network" | "body" | "declarations";
  addedLines: number;
  removedLines: number;
  diff: string;
  truncated: boolean;
}
export interface BlockReview {
  path: string;
  name: string;
  kind: string;
  change: "added" | "deleted" | "modified";
  interfaceChanges: InterfaceChange[];
  logic: LogicChange[];
  affected: { callers: string[]; dataBlocks: string[]; tags: string[]; dependants: string[] };
  reinitializesData: boolean;
  protected: boolean;
  namesMatched: string[];
}
export interface ReviewReport {
  base: string;
  head: string;
  blocks: BlockReview[];
  compile: { status: "last sync" | "unavailable"; note: string; diagnostics: string[] };
  evidence: { tests: string; coverage: string; behaviour: string };
  limitations: string[];
}

async function git(root: string, args: string[]) {
  return (await run("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
}
async function revision(root: string, ref: string): Promise<string> {
  if (!ref || ref.startsWith("-")) throw new Error(`${ref} is not a git revision`);
  try { return (await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim(); }
  catch { throw new Error(`${ref} is not a git revision of this repository`); }
}

async function snapshot(root: string, top: string, sha: string): Promise<WorkspaceIndex> {
  const index = new WorkspaceIndex();
  const prefix = slash(relative(top, root));
  const paths = (await git(top, ["ls-tree", "-rz", "--name-only", sha, "--", prefix || "."])).split("\0").filter((p) => p && source.test(p));
  const rung = paths.some((p) => p.startsWith(prefix ? `${prefix}/plc/` : "plc/"));
  index.layout = rung ? "rung" : "iec";
  for (const path of paths) {
    const rel = slash(relative(root, join(top, path)));
    if (rel.startsWith("../") || /(^|\/)(tests|node_modules|\.rung|dist|views)\//.test(rel) || rung && !rel.startsWith("plc/")) continue;
    const text = await git(top, ["show", `${sha}:${path}`]);
    if (!text.includes("\0")) index.set(uriOf(join(top, path)), normalized(text), 0);
  }
  return index;
}

function parts(doc: Doc | undefined, block: BlockModel | undefined): Map<string, { kind: LogicChange["kind"]; text: string }> {
  const out = new Map<string, { kind: LogicChange["kind"]; text: string }>();
  if (!doc) return out;
  if (!block) return doc.parsed?.blocks.length ? out : new Map([["Source", { kind: "body", text: doc.text }]]);
  if (block.kind === "GVL") return new Map([["Declarations", { kind: "body", text: doc.text.slice(block.start, block.end) }]]);
  if (block.xml) {
    try {
      for (const n of ladderOf(doc.text).networks) out.set(`Network ${n.index}${n.title ? `: ${n.title}` : ""}`, { kind: "network", text: JSON.stringify({ language: n.language, rung: n.rung, text: n.text, comment: n.comment, note: n.note }, null, 2) });
      return out;
    } catch { /* non-logic XML such as a DB is described by its interface */ }
  }
  const text = doc.code ?? doc.text;
  out.set("Declarations", { kind: "declarations", text: text.slice(block.start, block.bodyStart ?? block.end).trim() });
  if (block.bodyStart === undefined) return out;
  const body = text.slice(block.bodyStart, block.end).replace(/END_(FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK|DATA_BLOCK|PROGRAM)\s*$/i, "");
  if (/\bNETWORK\b/i.test(body)) {
    const networks = body.split(/(?=^\s*NETWORK\b)/im);
    let n = 0;
    for (const t of networks) if (t.trim()) out.set(/^\s*NETWORK\b/i.test(t) ? `Network ${++n}` : "Before networks", { kind: "network", text: t.trim() });
    return out;
  }
  const outer = block.regions.filter((r) => !block.regions.some((p) => p !== r && p.start < r.start && p.end >= r.end)).sort((a, b) => a.start - b.start);
  let at = block.bodyStart;
  const rest: string[] = [];
  for (const r of outer) {
    rest.push(text.slice(at, r.start)); at = r.end;
    let key = r.name; let duplicate = 1;
    while (out.has(key)) key = `${r.name} (${++duplicate})`;
    out.set(key, { kind: "region", text: text.slice(r.start, r.end).trim() });
  }
  rest.push(text.slice(at, block.bodyStart + body.length));
  if (rest.join("").trim() || !outer.length) out.set(outer.length ? "Outside regions" : "Body", { kind: "body", text: rest.join("").trim() });
  return out;
}

function logicChanges(a: Map<string, { kind: LogicChange["kind"]; text: string }>, b: ReturnType<typeof parts>): LogicChange[] {
  const result: LogicChange[] = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(name)?.text ?? ""; const after = b.get(name)?.text ?? "";
    if (before === after) continue;
    const la = before.split("\n"); const lb = after.split("\n");
    let addedLines = 0; let removedLines = 0; const lines: string[] = [];
    for (const h of diffIndices(la, lb)) {
      const [startA, lenA] = h.buffer1; const [startB, lenB] = h.buffer2;
      addedLines += lenB; removedLines += lenA;
      lines.push(`@@ -${startA + 1},${lenA} +${startB + 1},${lenB} @@`, ...la.slice(startA, startA + lenA).map((l) => `-${l}`), ...lb.slice(startB, startB + lenB).map((l) => `+${l}`));
    }
    const diff = lines.join("\n");
    result.push({ name, kind: (b.get(name) ?? a.get(name))!.kind, addedLines, removedLines, diff: diff.slice(0, 4000), truncated: diff.length > 4000 });
  }
  return result;
}

/** Working tree against HEAD by default; base..head and explicit base/head compare immutable commits. */
export async function reviewChanges(root: string, options: { base?: string; head?: string } = {}): Promise<ReviewReport> {
  root = resolve(root);
  // the toplevel spelled like root: git's own --show-toplevel may expand an 8.3 short name (RUNNER~1), and the
  // snapshot paths and URIs would no longer line up with the working tree's
  const prefix = (await git(root, ["rev-parse", "--show-prefix"]).catch(() => { throw new Error("rung review needs a git repository"); })).trim();
  const top = resolve(root, prefix.split("/").filter(Boolean).map(() => "..").join("/") || ".");
  let base = options.base ?? "HEAD"; let head = options.head;
  if (base.includes("..")) {
    const range = /^(.+?)\.\.(.+)$/.exec(base);
    if (!range || base.includes("...") || head) throw new Error("Use a base..head revision range or --base and --head");
    base = range[1]!; head = range[2]!;
  }
  const baseSha = await revision(top, base); const headSha = head ? await revision(top, head) : undefined;
  const before = await snapshot(root, top, baseSha);
  const after = headSha ? await snapshot(root, top, headSha) : new WorkspaceIndex();
  if (!headSha) await after.load(root);
  const oldGraph = CodeGraph.fromIndex(before); const graph = CodeGraph.fromIndex(after);
  const where = (uri: string) => slash(relative(root, fileURLToPath(uri)));
  const tests = headSha ? [] : await workspaceTests(root);
  const blocks: BlockReview[] = [];
  for (const uri of [...new Set([...before.docs.keys(), ...after.docs.keys()])].sort()) {
    const a = before.docs.get(uri); const b = after.docs.get(uri);
    if (normalized(a?.text ?? "") === normalized(b?.text ?? "")) continue;
    const pairs = new Set([...(a?.parsed?.blocks ?? []).map((x) => x.name), ...(b?.parsed?.blocks ?? []).map((x) => x.name)]);
    if (!pairs.size) pairs.add((b ?? a)!.uri.split("/").pop()!);
    for (const name of pairs) {
      const old = a?.parsed?.blocks.find((x) => x.name === name); const now = b?.parsed?.blocks.find((x) => x.name === name);
      if (old && now && a!.text.slice(old.start, old.end) === b!.text.slice(now.start, now.end)) continue;
      const kind = (now ?? old)?.kind ?? (b?.tagTable || a?.tagTable ? "TAG_TABLE" : "OBJECT");
      const impact = now && old ? interfaceImpact(after, uri, a!.text, tests, name) : undefined;
      let interfaceChanges = impact?.changes ?? [];
      // Global DB layouts and file additions/deletions are outside interfaceImpact's FB/FC/UDT scope.
      if (kind === "DB" || !old || !now) {
        const av = old?.vars ?? []; const bv = now?.vars ?? [];
        interfaceChanges = [];
        for (const v of av) {
          const w = bv.find((x) => x.name.toUpperCase() === v.name.toUpperCase() && x.section === v.section);
          if (!w) interfaceChanges.push({ kind: "removed", section: v.section, name: v.name, before: v.type });
          else if (signature(v) !== signature(w)) interfaceChanges.push({ kind: "retyped", section: v.section, name: v.name, before: signature(v), after: signature(w) });
        }
        for (const v of bv) if (!av.some((x) => x.name.toUpperCase() === v.name.toUpperCase() && x.section === v.section)) interfaceChanges.push({ kind: "added", section: v.section, name: v.name, after: v.type });
        for (const section of new Set(av.map((v) => v.section))) {
          const kept = (vars: VarDecl[]) => vars.filter((v) => v.section === section && av.some((x) => x.name === v.name) && bv.some((x) => x.name === v.name)).map((v) => v.name);
          if (kept(av).join() !== kept(bv).join()) interfaceChanges.push({ kind: "reordered", section, name: kept(bv).join(", ") });
        }
        if (old?.dbOf !== now?.dbOf) interfaceChanges.push({ kind: "retyped", section: "Member", name: "DB type", before: old?.dbOf, after: now?.dbOf });
      }
      const affected: BlockReview["affected"] = { callers: [], dataBlocks: [], tags: [], dependants: [] };
      const names = (old || now) && kind !== "GVL" ? [name] : [...new Set([...before.allGlobals(), ...after.allGlobals()].filter((s) => s.uri === uri).map((s) => s.name))];
      for (const g of [oldGraph, graph]) for (const nodeName of names) {
        const id = g.key(nodeName, deviceOfUri(uri));
        if (g.get(id)?.kind === "TAG") affected.tags.push(deviceOfUri(uri) ? `${deviceOfUri(uri)}/${nodeName}` : nodeName);
        affected.callers.push(...g.callers(id).filter((n) => n.uri).map((n) => where(n.uri!)));
        affected.dependants.push(...g.impact(id).filter((i) => i.node.uri).map((i) => where(i.node.uri!)));
        const related = [...g.incoming(id).map((e) => e.from), ...g.outgoing(id).map((e) => e.to)];
        for (const ref of related) {
          const n = g.get(ref); if (!n) continue;
          if (n.kind === "DB" && n.uri) affected.dataBlocks.push(where(n.uri));
          if (n.kind === "TAG") affected.tags.push(n.device ? `${n.device}/${n.name}` : n.name);
        }
      }
      for (const i of impact?.instances ?? []) affected.dataBlocks.push(where(i.uri));
      for (const key of Object.keys(affected) as (keyof typeof affected)[]) affected[key] = [...new Set(affected[key])].sort();
      const changedText = `${old && a ? a.text.slice(old.start, old.end) : a?.text ?? ""}\n${now && b ? b.text.slice(now.start, now.end) : b?.text ?? ""}`;
      blocks.push({ path: where(uri), name, kind, change: !a || !old && now ? "added" : !b || old && !now ? "deleted" : "modified", interfaceChanges,
        logic: logicChanges(parts(a, old), parts(b, now)), affected,
        reinitializesData: !!impact?.reinit || (kind === "DB" && interfaceChanges.length > 0),
        protected: /\.protected\.yaml$/i.test(uri) || /^F_/i.test(name) || /KNOW_HOW_PROTECT|<ProgrammingLanguage>F_|<ProgrammingLanguage>GRAPH/i.test(changedText),
        namesMatched: [...new Set(changedText.match(/\b(?:E_Stop\w*|Guard\w*|Interlock\w*|Enable\w*|Brake\w*)\b/gi) ?? [])].sort() });
    }
  }
  const diagnostics = await readFile(join(root, ".rung", "diagnostics.json"), "utf8").then((t) => (JSON.parse(t) as { items?: { path?: string; address?: string; line?: number; severity: string; message: string }[] }).items, () => undefined).catch(() => undefined);
  return { base: baseSha, head: headSha ?? "working tree", blocks,
    compile: { status: diagnostics ? "last sync" : "unavailable", note: "Cached workspace diagnostics only; they do not prove these changes compiled.", diagnostics: (diagnostics ?? []).map((d) => `${d.path || d.address || "workspace"}${d.line ? `:${d.line}` : ""} ${d.severity} ${d.message}`) },
    evidence: { tests: "not run by review; use rung test", coverage: "not measured by review; use rung test --coverage", behaviour: "not run by review; use rung test --against <base>" },
    limitations: ["Text and static dependencies only; no claim about runtime behaviour or safety.", "Names matched are review hints, not a safety check.", "Renamed files are shown as a deletion and an addition; dependencies include both revisions.", "Logic excerpts are capped at 4000 characters per region or network; truncated is explicit."] };
}

const md = (s: string) => s.replace(/[\\`*_{}\[\]<>#|]/g, "\\$&").replace(/[\r\n]/g, " ");
export function reviewMarkdown(report: ReviewReport): string {
  const lines = ["# rung change review", "", `Base: ${md(report.base)}; target: ${md(report.head)}.`, "", `${report.blocks.length} changed object(s).`];
  for (const b of report.blocks) {
    lines.push("", `## ${md(b.name)} (${b.kind}, ${b.change})`, "", `File: ${md(b.path)}`);
    if (b.protected) lines.push("", "Protected or fail-safe object touched: review in TIA Portal.");
    for (const c of b.interfaceChanges) lines.push(`- Interface ${c.kind}: ${md(c.section)} ${md(c.name)}${c.to ? ` -> ${md(c.to)}` : ""}${c.before ? ` (was ${md(c.before)})` : ""}${c.after ? `: ${md(c.after)}` : ""}`);
    if (b.reinitializesData) lines.push("- Data layout changed: download may reinitialise data. Check memory reserve and retained values in TIA Portal.");
    for (const r of b.logic) lines.push("", `### ${md(r.name)} (${r.kind}, +${r.addedLines}/-${r.removedLines})`, "", "````diff", r.diff.replace(/`/g, "'"), "````", ...(r.truncated ? ["Excerpt truncated; inspect the full source diff."] : []));
    for (const [key, names] of Object.entries(b.affected)) if (names.length) lines.push("", `${key}: ${names.map(md).join(", ")}`);
    if (b.namesMatched.length) lines.push("", `Names matched (not a safety check): ${b.namesMatched.map(md).join(", ")}`);
  }
  lines.push("", `Compile: ${report.compile.status}. ${report.compile.note}`, ...report.compile.diagnostics.map((d) => `- ${md(d)}`), "", `Tests: ${report.evidence.tests}.`, `Coverage: ${report.evidence.coverage}.`, `Behaviour: ${report.evidence.behaviour}.`, "", ...report.limitations.map((l) => `- ${l}`));
  return lines.join("\n") + "\n";
}
