// SPDX-License-Identifier: BUSL-1.1
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument, stringify } from "yaml";
import { WorkspaceIndex, deviceOfUri, scopedTo, type Member, type VarDecl } from "@rung/lsp";
import { discover, DiscoveryBudgetError, findingKey, refText, runTestFile, toMs, validateDiscovery, type DiscoveryOptions, type DiscoveryResult, type DiscoveryStep, type DiscoveryScalar, type DiscoveryWitness, type Simulator, type Frame, type Stmt } from "@rung/sim";
import { indexAt } from "./behaviour.js";
import { findWorkspace, readBoundedText, type Io } from "./common.js";
import { discoveryHtml } from "./discoveryReport.js";

/** A statement the write ran inside (an IF, a CASE) or the write itself, with the values it read in that scan. */
export interface CauseStep { line: number; reads: { name: string; value: DiscoveryScalar }[] }
export interface CauseWrite {
  scan: number; line: number; value: DiscoveryScalar;
  /** Outermost first: the statements around the write and the write, as they ran in that scan. */
  because?: CauseStep[];
}
export type DiscoveryFinding = DiscoveryWitness & { cause: { before?: CauseWrite; after?: CauseWrite } };
export interface DiscoveryConfig extends DiscoveryOptions {
  block: string; plc?: string; cycle: string;
  /** Inputs that are not driven: they keep their start values in every scenario. */
  fixed?: string[];
}
export interface DiscoveryEvidence extends Omit<DiscoveryResult, "corpus" | "findings"> {
  version: 1;
  findings?: DiscoveryFinding[];
  config: DiscoveryConfig;
  reference: { commit: string; sourceHash: string };
  current: { sourceHash: string };
  scope: string;
  assumptions: string[];
  referenceTest?: string;
  /** 1-based lines that differ between the two source snapshots. */
  changedLines?: { before: number[]; after: number[] };
  sources?: { before: { file: string; text: string }; after: { file: string; text: string } };
  /** Other sources that differ between the revisions (blocks it calls, types): a finding may come from them. */
  alsoChanged?: string[];
}
const run = promisify(execFile);
const defaults = { maxCycles: 32, maxEvents: 12, maxRuns: 1000, holds: [1, 2, 5, 10, 20], seed: 1, timeoutMs: 15000 };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseDiscoveryConfig(text: string): DiscoveryConfig {
  if (text.length > 65536) throw new Error("Discovery configuration exceeds 64 KiB");
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(doc.errors[0]!.message);
  const raw: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!object(raw)) throw new Error("Discovery configuration must be a mapping");
  for (const k of Object.keys(raw)) if (!["block", "plc", "cycle", "inputs", "outputs", "search", "fixed"].includes(k)) throw new Error(`Unknown discovery field: ${k}`);
  if (typeof raw.block !== "string" || !raw.block || raw.block.length > 128 || raw.plc !== undefined && (typeof raw.plc !== "string" || !raw.plc || raw.plc.length > 128)) throw new Error("Choose a block name and optional PLC");
  if (raw.search !== undefined && !object(raw.search)) throw new Error("search must be a mapping");
  const search = (raw.search ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(search)) if (!Object.hasOwn(defaults, k)) throw new Error(`Unknown search bound: ${k}`);
  const cycle = raw.cycle ?? "10ms";
  if (typeof cycle !== "string" || !Number.isFinite(toMs(cycle)) || toMs(cycle) <= 0 || toMs(cycle) > 10000) throw new Error("cycle: choose a virtual scan time from >0 to 10s");
  if (raw.fixed !== undefined && (!Array.isArray(raw.fixed) || raw.fixed.length > 64 || raw.fixed.some(n => typeof n !== "string" || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){0,3}$/.test(n)))) throw new Error("fixed: list input names");
  const config = { ...defaults, ...search, block: raw.block, ...(raw.fixed ? { fixed: raw.fixed as string[] } : {}), ...(raw.plc ? { plc: raw.plc as string } : {}), cycle, inputs: raw.inputs, outputs: raw.outputs } as DiscoveryConfig;
  if (!Object.hasOwn(search, "holds")) config.holds = defaults.holds.filter(n => n <= config.maxCycles);
  validateDiscovery(config);
  return config;
}

const INTEGER_RANGE: Record<string, [number, number]> = { SINT: [-128, 127], INT: [-32768, 32767], DINT: [-2147483648, 2147483647], USINT: [0, 255], UINT: [0, 65535], UDINT: [0, 4294967295], BYTE: [0, 255], WORD: [0, 65535], DWORD: [0, 4294967295] };
const REAL = new Set(["REAL", "LREAL"]);

/**
 * A numeric input's values: zero, its start value and the thresholds the code compares it against, with their
 * neighbours. A threshold is a literal on a line that names the input, or the start value of a constant, static or
 * UDT member named there (`#Level >= #Recipe.LevelA`). Other literals only fill spare room.
 */
function numericDomain(name: string, type: string, texts: string[], init: string | undefined, valueOf: (path: string) => number | undefined): number[] | undefined {
  const range = INTEGER_RANGE[type] ?? (REAL.has(type) ? [-1e9, 1e9] : undefined);
  if (!range) return;
  // first what the input is compared with, then other numbers on its lines, then any number
  const pattern = name.replace(/\./g, "\\."), compared: number[] = [], near: number[] = [], far: number[] = [], own = new RegExp(`#${pattern}\\b`, "i");
  const operand = (text: string) => /^[+-]?\d/.test(text) ? Number(text) : text.startsWith("#") ? valueOf(text.slice(1)) : undefined;
  const ops = "<=|>=|<>|<|>|=";
  const after = new RegExp(`#${pattern}\\s*(?:${ops})\\s*([+-]?[\\w#.]+)`, "gi"), before = new RegExp(`([+-]?[\\w#.]+)\\s*(?:${ops})\\s*#${pattern}\\b`, "gi");
  for (const text of texts) for (const line of text.split("\n")) {
    // no numbers from the block's header (VERSION : 0.1), attributes ({ S7_Optimized_Access := 'TRUE' }) or comments
    const code = /^\s*VERSION\s*:/i.test(line) ? "" : line.replace(/\{[^}]*\}/g, "").replace(/\(\*.*?\*\)/g, "").replace(/\/\/.*$/, "").replace(/\b(?:L?T|L?TIME|DT|TOD|D)#\S+/gi, "").replace(/^\s*[\d\s,.]+:(?!=)/, "");
    const mine = own.test(code);
    if (mine) for (const m of [...code.matchAll(after), ...code.matchAll(before)]) { const v = operand(m[1]!); if (v !== undefined && Number.isFinite(v)) compared.push(v); }
    for (const m of code.matchAll(/(?<![\w#.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w#])/g)) (mine ? near : far).push(Number(m[0]));
    if (mine) for (const m of code.matchAll(/#(\w+(?:\.\w+)*)/g)) { const v = valueOf(m[1]!); if (v !== undefined) near.push(v); }
  }
  const step = REAL.has(type) ? 0.5 : 1, values: number[] = [];
  const add = (v: number) => { if (v >= range[0] && v <= range[1] && !values.includes(v) && values.length < 8) values.push(v); };
  if (init !== undefined && Number.isFinite(Number(init))) add(Number(init));
  add(0);
  for (const t of new Set(compared)) add(t);
  for (const t of new Set(compared)) { add(t - step); add(t + step); }
  for (const t of new Set(near)) add(t);
  for (const t of new Set(far)) add(t);
  // the first value is the input's rest in every scenario: its start value when it has one, else 0
  return [values[0]!, ...values.slice(1).sort((a, b) => a - b)];
}

/** The virtual scan time and holds that let the longest timer in the source run out within the horizon. */
function timing(texts: string[]): { cycle: string; maxCycles: number; holds: number[] } | undefined {
  const presets = texts.flatMap(t => [...t.matchAll(/\b(?:L?T|L?TIME)#[\w.]+/gi)].map(m => { try { return toMs(m[0]); } catch { return 0; } })).filter(ms => ms > 0);
  if (!presets.length || Math.max(...presets) <= 200) return;
  const longest = Math.max(...presets);
  const cycle = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find(ms => longest / ms <= 60) ?? 10000;
  const maxCycles = Math.min(256, Math.max(32, Math.ceil(longest * 1.5 / cycle) + 2));
  const holds = new Set([1, 2, 5]);
  for (const p of [...new Set(presets)].sort((a, b) => b - a)) {
    const n = Math.round(p / cycle);
    for (const h of [n - 1, n, n + 1]) if (h >= 1 && h <= maxCycles && holds.size < 16) holds.add(h);
  }
  return { cycle: `${cycle}ms`, maxCycles, holds: [...holds].sort((a, b) => a - b) };
}

/**
 * Infers the search for one block: Booleans both ways, numbers around their thresholds, the scan time from the
 * timers in it, its types and the blocks it calls. Inputs that are not Bool or a number (a TIME preset, a recipe
 * structure) are not driven: they keep their start values.
 */
export async function discoveryForFile(root: string, file: string, otherTexts: string[] = []): Promise<DiscoveryConfig> {
  const index = new WorkspaceIndex(); await index.load(root);
  const uri = pathToFileURL(resolve(file)).href, doc = index.docs.get(uri);
  const blocks = doc?.parsed?.blocks ?? [];
  if (blocks.length !== 1 || !["FB", "FC"].includes(blocks[0]!.kind)) throw new Error("Select one mirrored FB or FC source file");
  const block = blocks[0]!, scope = scopedTo(index, uri);
  // the texts of the types and blocks it uses, two levels deep: their start values and timers count too
  const used = new Set<string>([uri]);
  const collect = (vars: VarDecl[], depth: number) => {
    for (const v of vars) {
      const target = v.typeRef ? scope.global(v.typeRef) : undefined;
      if (!target || used.has(target.uri) || used.size >= 32) continue;
      used.add(target.uri);
      if (depth < 2 && target.block) collect(target.block.vars, depth + 1);
    }
  };
  collect(block.vars, 1);
  const texts = [doc!.text, ...otherTexts], related = [...used].slice(1).map(u => index.docs.get(u)?.text ?? "");
  const valueOf = (path: string) => {
    const [head, ...rest] = path.split(".");
    let m: Member | VarDecl | undefined = block.vars.find(v => v.name.toUpperCase() === head!.toUpperCase());
    for (const part of rest) m = m && scope.membersOf(m).find(x => x.name.toUpperCase() === part.toUpperCase());
    const n = m?.init === undefined ? NaN : Number(m.init.trim());
    return Number.isFinite(n) ? n : undefined;
  };
  const inputs: Record<string, DiscoveryScalar[]> = {}, fixed: string[] = [], observed: string[] = [];
  // an in/out the block writes (`#Tank.High :=`, `Out => #Tank.High`) is a result; one it only reads is driven like an input
  const written = new Set([...texts[0]!.matchAll(/#(\w+(?:\.\w+)*)\s*:=/g), ...texts[0]!.matchAll(/=>\s*#(\w+(?:\.\w+)*)/g)].map(m => m[1]!.toUpperCase()));
  const isWritten = (path: string) => [...written].some(w => w === path.toUpperCase() || path.toUpperCase().startsWith(w + ".") || w.startsWith(path.toUpperCase() + "."));
  const leaves = (v: Member | VarDecl, path: string, depth: number): { path: string; m: Member | VarDecl }[] => {
    const members = v.isArray ? [] : scope.membersOf(v);
    if (!members.length || depth >= 2) return [{ path, m: v }];
    return members.flatMap(m => leaves(m, `${path}.${m.name}`, depth + 1));
  };
  for (const v of block.vars.filter(v => v.section === "Input" || v.section === "InOut")) for (const { path, m } of leaves(v, v.name, 0)) {
    const type = m.type.toUpperCase(), plain = !m.isArray && !scope.membersOf(m).length;
    if (v.section === "InOut" && isWritten(path)) { if (plain && (type === "BOOL" || INTEGER_RANGE[type] || REAL.has(type))) observed.push(path); continue; }
    const domain = !plain ? undefined : type === "BOOL" ? [false, true] : numericDomain(path, type, texts, m.init, valueOf);
    if (domain) inputs[path] = domain; else fixed.push(path);
  }
  if (!Object.keys(inputs).length) throw new Error(`${block.name} has no Bool or numeric input or in/out member to vary; write a discovery YAML to choose domains`);
  if (Object.keys(inputs).length > 16) throw new Error(`${block.name} has ${Object.keys(inputs).length} Bool and numeric inputs; discovery varies up to 16. Write a discovery YAML that names them`);
  const outputs = block.vars.filter(v => v.section === "Output" && !v.isArray && !index.membersOf(v).length).map(v => v.name);
  if (block.kind === "FC" && block.returnType && !/^void$/i.test(block.returnType)) outputs.push(block.name);
  outputs.push(...observed);
  if (!outputs.length) throw new Error(`${block.name} has no scalar output or written in/out to observe; write a discovery YAML to choose observations`);
  const plc = deviceOfUri(uri), time = timing([...texts, ...related]);
  return parseDiscoveryConfig(JSON.stringify({ block: block.name, ...(plc ? { plc } : {}), inputs, outputs, ...(fixed.length ? { fixed } : {}), ...(time ? { cycle: time.cycle, search: { maxCycles: time.maxCycles, holds: time.holds } } : {}) }));
}

function hash(index: WorkspaceIndex, root: string): string {
  const h = createHash("sha256");
  for (const [uri, doc] of [...index.docs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    h.update(JSON.stringify([relative(root, fileURLToPath(uri)).replace(/\\/g, "/"), doc.text]));
  }
  return h.digest("hex");
}

/**
 * Source files the searched one depends on (the types, blocks, DBs and tags it names, and theirs) whose text differs
 * between the two revisions (at most 20).
 */
function alsoChanged(base: WorkspaceIndex, current: WorkspaceIndex, root: string, searched: string): string[] {
  const path = (uri: string) => relative(root, fileURLToPath(uri)).replace(/\\/g, "/");
  const texts = (index: WorkspaceIndex) => new Map([...index.docs.entries()].map(([uri, d]) => [path(uri), d.text]));
  const uses = (index: WorkspaceIndex) => {
    const start = [...index.docs.keys()].find(u => path(u) === searched), seen = new Set<string>(start ? [start] : []), queue = [...seen];
    while (queue.length && seen.size < 256) {
      const uri = queue.shift()!, doc = index.docs.get(uri)!;
      const names = [...(doc.parsed?.blocks ?? []).flatMap(b => b.vars.map(v => v.typeRef ?? "")), ...[...doc.text.matchAll(/"([^"\r\n]+)"/g)].map(m => m[1]!)];
      for (const n of names) { const target = n && index.global(n.replace(/^"|"$/g, ""), uri); if (target && !seen.has(target.uri)) { seen.add(target.uri); queue.push(target.uri); } }
    }
    return [...seen].map(path);
  };
  const a = texts(base), b = texts(current);
  return [...new Set([...uses(base), ...uses(current)])].filter(f => f !== searched && a.get(f) !== b.get(f)).sort().slice(0, 20);
}

type TestCase = { name: string; steps: DiscoveryStep[]; expected?: Record<string, DiscoveryScalar>[] };
function testYaml(config: DiscoveryConfig, steps: DiscoveryStep[] | TestCase[], expected?: Record<string, DiscoveryScalar>[]): string {
  const cases: TestCase[] = steps.length && "steps" in steps[0]! ? steps as TestCase[] : [{ name: "Discovered behaviour", steps: steps as DiscoveryStep[], ...(expected ? { expected } : {}) }];
  return stringify({ block: config.block, ...(config.plc ? { plc: config.plc } : {}), cycle: config.cycle, cases: cases.map(c => {
    let scan = 0;
    return { name: c.name, steps: c.steps.flatMap(s => Array.from({ length: s.cycles }, (_, i) => {
      const values = c.expected?.[scan++];
      return { ...(i === 0 ? { set: s.set } : {}), cycle: 1, ...(values ? { expect: Object.fromEntries(config.outputs.map(n => [n, values[n]!])) } : {}) };
    })) };
  }) });
}
const shown = (v: DiscoveryScalar) => typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
const caseName = (w: DiscoveryWitness, n: number) => `Finding ${n}: ${w.difference.signal} at scan ${w.difference.cycle}, ${shown(w.difference.before)} before the change, ${shown(w.difference.after)} after (expectations are the earlier behaviour: review them)`;

/**
 * Replays the witness on one revision and keeps the last write to the differing signal at or before the divergence
 * scan: its line, and the IFs and CASEs it ran inside with the values they read in that scan.
 */
async function lastWrite(index: WorkspaceIndex, uri: string, config: DiscoveryConfig, steps: DiscoveryStep[], difference: { cycle: number; signal: string }, side: "before" | "after"): Promise<{ before?: CauseWrite; after?: CauseWrite }> {
  const path = difference.signal.toUpperCase().split("."), leaf = path.at(-1)!, frames = new WeakSet<object>();
  const scalar = (v: unknown): v is DiscoveryScalar => typeof v === "boolean" || typeof v === "string" || typeof v === "number" && Number.isFinite(v);
  let scan = 0, tested: Frame | undefined, found: CauseWrite | undefined;
  const stack: { stmt: Stmt; reads: Map<string, DiscoveryScalar> }[] = [];
  await runTestFile(index, "discovery.test.yaml", testYaml(config, steps), undefined, { simulator: sim => {
    const mine = (s: Stmt, f: Frame) => f.block.name.toUpperCase() === config.block.toUpperCase() && sim.locationOf(f, s.at)?.uri === uri;
    sim.onStatement = (s, f) => {
      if (!mine(s, f)) return;
      // each scan calls the block afresh: a frame not seen before is the next scan
      if (!frames.has(f)) { frames.add(f); scan++; stack.length = 0; }
      tested = f;
      stack.push({ stmt: s, reads: new Map() });
    };
    sim.onStatementEnd = (s, f) => {
      if (f !== tested) return;
      const at = stack.findLastIndex(e => e.stmt === s);
      if (at >= 0) stack.length = at;
    };
    sim.onExpression = (e, f, value) => {
      if (f !== tested || !stack.length || e.k !== "ref" || !scalar(value)) return;
      stack.at(-1)!.reads.set(refText(e.ref), value);
    };
    sim.onWrite = (obj, key, value, frame) => {
      if (!tested || frame !== tested || String(key).toUpperCase() !== leaf || scan > difference.cycle || !stack.length || !scalar(value)) return;
      let container: unknown = frame.mem;
      for (const part of path.slice(0, -1)) container = container && typeof container === "object" ? (container as Record<string, unknown>)[part] : undefined;
      const statement = stack.at(-1)!.stmt;
      const target = statement.k === "assign" ? refText(statement.target).toUpperCase() : "";
      if (obj !== container && target !== `#${path.join(".")}`) return;
      const line = sim.locationOf(frame, statement.at)?.line;
      if (line === undefined) return;
      const because = stack.filter((e, n) => n === stack.length - 1 || ["if", "case", "while", "repeat", "for"].includes(e.stmt.k)).flatMap(e => {
        const at = sim.locationOf(frame, e.stmt.at)?.line;
        return at === undefined ? [] : [{ line: at, reads: [...e.reads].slice(0, 12).map(([name, v]) => ({ name, value: v })) }];
      });
      found = { scan, line, value, because };
    };
  } }).catch(() => undefined);
  return found ? { [side]: found } : {};
}

/** Lines that differ, by a longest common subsequence; none for files too large to compare cheaply. */
function changedLines(before: string, after: string): { before: number[]; after: number[] } {
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/);
  if (a.length * b.length > 4_000_000) return { before: [], after: [] };
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out = { before: [] as number[], after: [] as number[] };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.after.push(++j);
    else out.before.push(++i);
  }
  return out;
}

export async function discoverWorkspace(root: string, config: DiscoveryConfig, revision: string, seeds: DiscoveryStep[][] = []): Promise<DiscoveryEvidence & { corpus: DiscoveryStep[][] }> {
  validateDiscovery(config);
  const current = new WorkspaceIndex(); await current.load(root);
  const commit = (await run("git", ["-C", root, "rev-parse", "--verify", `${revision}^{commit}`], { windowsHide: true })).stdout.trim();
  const base = await indexAt(root, current, commit);
  const sources = {} as NonNullable<DiscoveryEvidence["sources"]>, uris = {} as Record<"before" | "after", string>;
  let referenceInterface: string | undefined;
  for (const [label, index] of [["Reference", base], ["Current", current]] as const) {
    const blocks = [...index.docs.entries()].flatMap(([uri, d]) => (d.parsed?.blocks ?? []).filter(b => b.name.toUpperCase() === config.block.toUpperCase() && (!config.plc || deviceOfUri(uri) === config.plc)).map(b => ({ b, uri })));
    if (!blocks.length && label === "Reference") throw new Error(`${config.block} is new since ${revision}: there is no earlier version to compare with`);
    if (blocks.length !== 1 || !["FB", "FC"].includes(blocks[0]!.b.kind)) throw new Error(`${label}: choose one unambiguous FB or FC (use plc: when names repeat)`);
    const block = blocks[0]!.b;
    const scope = scopedTo(index, blocks[0]!.uri);
    const shape = (v: Member, depth = 0): unknown => {
      if (depth > 32) throw new Error("Block interface is recursive or too deeply nested for discovery");
      const alias = v.typeRef ? scope.global(v.typeRef)?.block?.alias : undefined;
      return [v.name.toUpperCase(), v.section, v.type.toUpperCase(), v.isArray, alias ? shape({ name: v.typeRef!, ...alias }, depth + 1) : null, scope.membersOf(v).map(m => shape(m, depth + 1))];
    };
    const signature = JSON.stringify([block.kind, block.returnType?.toUpperCase(), block.returnType ? shape({ name: block.name, type: block.returnType, typeRef: block.returnType.replace(/^"|"$/g, ""), isArray: false }) : null, block.vars.filter(v => ["Input", "Output", "InOut"].includes(v.section)).map(v => shape(v))]);
    if (referenceInterface !== undefined && referenceInterface !== signature) throw new Error("Block interfaces differ between revisions; discovery requires a stable input/output schema");
    referenceInterface = signature;
    const uri = blocks[0]!.uri, text = index.docs.get(uri)!.text;
    uris[label === "Reference" ? "before" : "after"] = uri;
    if (text.length > 262144) throw new Error("Discovery source preview exceeds 256 KiB; select a smaller compilation unit");
    sources[label === "Reference" ? "before" : "after"] = { file: relative(root, fileURLToPath(uri)).replace(/\\/g, "/"), text };
    for (const name of Object.keys(config.inputs)) if (!block.vars.some(v => ["Input", "InOut"].includes(v.section) && v.name.toUpperCase() === name.split(".")[0]!.toUpperCase())) throw new Error(`${label}: ${name} is not a declared input or in/out; discovery never drives internal state or outputs`);
  }
  const deadline = performance.now() + config.timeoutMs;
  // an instruction rung only stubs (Program_Alarm) does not change the result when nothing reads its outputs
  const ignored = new Set<string>(), verdicts = new Map<string, boolean>();
  const unread = (type: string) => {
    if (!verdicts.has(type)) {
      const instances = [base, current].flatMap(index => [...index.docs.values()].flatMap(d => (d.parsed?.blocks ?? []).flatMap(b => b.vars
        .filter(v => (v.typeRef ?? v.type).replace(/^"|"$/g, "").toUpperCase() === type).map(v => ({ text: d.text, name: v.name })))));
      verdicts.set(type, instances.length > 0 && instances.every(i => !new RegExp(`#${i.name}\\s*\\.`, "i").test(i.text)));
    }
    return verdicts.get(type)!;
  };
  const executeOne = async (index: WorkspaceIndex, steps: DiscoveryStep[], reached?: Set<string>) => {
    let timedOut = false;
    let stubCalls: Map<string, number> | undefined;
    if (performance.now() >= deadline) throw new DiscoveryBudgetError("Discovery execution deadline exhausted");
    const result = await runTestFile(index, "discovery.test.yaml", testYaml(config, steps), undefined, { observe: true, simulator: sim => {
      stubCalls = sim.stubCalls;
      sim.onStatement = (s, f) => {
        if (performance.now() >= deadline) { timedOut = true; throw new DiscoveryBudgetError("Discovery scan deadline exhausted"); }
        reached?.add(`${f.block.name}@${s.at}`);
      };
    } });
    if (timedOut) throw new DiscoveryBudgetError("Discovery scan deadline exhausted");
    const c = result.cases[0];
    if (result.error || !c || c.error || !c.passed) throw new Error(result.error ?? c?.error ?? "Discovery execution failed");
    for (const [type, n] of stubCalls ?? []) if (n > 0) {
      if (!unread(type)) throw new Error(`Discovery refuses executions that call a stub whose outputs the program reads (${type}); supply executable dependencies`);
      ignored.add(type);
    }
    // a small whole value of an output or static (a step number, a flag) is a state the search tries to reach
    if (reached) for (const o of c.observed ?? []) for (const [n, v] of Object.entries(o.values)) {
      if (typeof v === "boolean" || typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 1e6) reached.add(`${n}=${v}`);
    }
    return (c.observed ?? []).map(o => Object.fromEntries(config.outputs.map(n => {
      if (!Object.hasOwn(o.values, n)) throw new Error(`Missing scalar observation ${n}; use its declared spelling`);
      return [n, o.values[n]!];
    })));
  };
  // Validate every configured value before searching, including values an early witness might never use.
  const initial = Object.fromEntries(Object.entries(config.inputs).map(([n, values]) => [n, values[0]!]));
  const preflight = Object.entries(config.inputs).flatMap(([name, values]) => values.map(v => ({ set: { ...initial, [name]: v }, cycles: 1 })));
  for (const step of preflight) { await executeOne(base, [step]); await executeOne(current, [step]); }
  const result = await discover({ ...config, seeds }, async steps => {
    const a = new Set<string>(), b = new Set<string>();
    const frames = { before: await executeOne(base, steps, a), after: await executeOne(current, steps, b) };
    return { ...frames, reached: [...[...a].map(k => "r:" + k), ...[...b].map(k => "c:" + k)] };
  });
  const witnesses = result.findings ?? [];
  const referenceTest = witnesses.length ? testYaml(config, witnesses.map((w, n) => ({ name: caseName(w, n + 1), steps: w.steps, expected: w.before }))) : undefined;
  if (referenceTest) {
    // A separate bounded replay validates export even when shrinking consumed the search deadline.
    const validationDeadline = performance.now() + config.timeoutMs;
    const hooks = { simulator: (sim: Simulator) => {
      sim.onStatement = () => { if (performance.now() >= validationDeadline) throw new DiscoveryBudgetError("Discovery export validation deadline exhausted"); };
    } };
    const before = await runTestFile(base, "discovery.test.yaml", referenceTest, undefined, hooks);
    const after = await runTestFile(current, "discovery.test.yaml", referenceTest, undefined, hooks);
    // every case passes on the reference and fails an assertion, not with an error, on the working tree
    if (before.error || after.error || before.cases.length !== witnesses.length || after.cases.length !== witnesses.length
      || before.cases.some(c => !c.passed) || after.cases.some(c => c.passed || c.error)) throw new Error("Discovery witness does not distinguish revisions under normal test assertions");
  }
  const { findings: _witnesses, ...searchResult } = result;
  const findings: DiscoveryFinding[] = [];
  for (const w of witnesses) findings.push({ ...w, cause: {
    ...await lastWrite(base, uris.before, config, w.steps, w.difference, "before"),
    ...await lastWrite(current, uris.after, config, w.steps, w.difference, "after"),
  } });
  return {
    version: 1, ...searchResult, ...(() => { const other = alsoChanged(base, current, root, sources.after.file); return other.length ? { alsoChanged: other } : {}; })(), ...(findings.length ? { witness: findings[0], findings, changedLines: changedLines(sources.before.text, sources.after.text) } : {}), config, sources, reference: { commit, sourceHash: hash(base, root) }, current: { sourceHash: hash(current, root) },
    scope: "offline-simulator",
    assumptions: ["A difference is not automatically a bug. No witness found does not establish equivalence.", "Finite declared domains, event/scan/run/time budgets; unsupported execution is refused.", "Each version starts with its own declaration initializers; state persists between scans and resets between scenarios.", "Virtual scan time, no hardware/interrupt scheduling or field timing validation. Observations use the test runner's scalar representation and relative numeric tolerance 1e-6 (scaled by at least 1).", "Domain preflight and final exported-test validation are additional to the search replay-pair count.", "Shrinking preserves a replayed witness; global shortest sequence is not claimed.", "Each finding is a different signal, or a Boolean's other direction; one finding may have more than one cause in the code.", "The line shown for each revision is the last write to the signal the simulator executed, inside the IFs and CASEs that led to it with the values they read in that scan: what ran, not a full data-flow proof.", ...(config.fixed?.length ? [`Not driven, at their start values: ${config.fixed.join(", ")}.`] : []), ...(ignored.size ? [`Not simulated, and nothing reads their outputs: ${[...ignored].join(", ")}.`] : [])],
    ...(referenceTest ? { referenceTest } : {}),
  };
}

/** The file at the reference revision, so its thresholds and timers count too; none when it is new there. */
async function referenceText(root: string, file: string, revision: string): Promise<string[]> {
  try { return [(await run("git", ["-C", root, "show", `${revision}:${relative(root, file).replace(/\\/g, "/")}`], { windowsHide: true, maxBuffer: 1 << 20 })).stdout]; }
  catch { return []; }
}

async function writeEvidence(destination: string, found: DiscoveryEvidence & { corpus?: DiscoveryStep[][] }): Promise<void> {
  const { corpus: _corpus, ...result } = found;
  // Reserve exclusively before writing; an existing directory is never treated as disposable output.
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination);
  await writeFile(join(destination, "evidence.json"), JSON.stringify(result, null, 2), { flag: "wx" });
  if (result.referenceTest) await writeFile(join(destination, "reference.test.yaml"), result.referenceTest, { flag: "wx" });
  await writeFile(join(destination, "report.html"), discoveryHtml(result), { flag: "wx" });
}

const plc = (v: DiscoveryScalar) => typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
const summary = (r: DiscoveryEvidence) => r.witness
  ? `${r.witness.difference.signal} differs at scan ${r.witness.difference.cycle}: ${plc(r.witness.difference.before)} before, ${plc(r.witness.difference.after)} now`
  : `no difference within ${r.runs} replayed scenarios`;
const more = (r: DiscoveryEvidence) => (r.findings?.length ?? 0) > 1 ? ` (and ${r.findings!.length - 1} more finding${r.findings!.length > 2 ? "s" : ""})` : "";

/**
 * Scenarios that reached new states in earlier searches of a block, so the next search starts where they got to.
 * Kept per PLC and block under .rung/discover/corpus; a file that is too large or not ours is ignored.
 */
const corpusFile = (root: string, config: DiscoveryConfig) => join(root, ".rung", "discover", "corpus", (config.plc ?? "_").replace(/[^\w.-]/g, "_"), `${config.block.replace(/[^\w.-]/g, "_")}.json`);
async function loadCorpus(file: string): Promise<DiscoveryStep[][]> {
  try {
    if ((await stat(file)).size > 1 << 20) return [];
    const data = JSON.parse(await readFile(file, "utf8")) as { version?: unknown; scenarios?: unknown };
    return data.version === 1 && Array.isArray(data.scenarios) ? data.scenarios.slice(-64) as DiscoveryStep[][] : [];
  } catch { return []; }
}
async function saveCorpus(file: string, earlier: DiscoveryStep[][], found: DiscoveryStep[][]): Promise<void> {
  const seen = new Set<string>(), scenarios: DiscoveryStep[][] = [];
  // newest last: the found ones after the earlier ones that are not among them
  for (const steps of [...found].reverse().concat([...earlier].reverse())) {
    const key = JSON.stringify(steps);
    if (!seen.has(key) && scenarios.length < 64) { seen.add(key); scenarios.unshift(steps); }
  }
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, scenarios }), { flag: "wx" });
  await rename(temporary, file);
}

/** One block: the corpus in, the search, the corpus out. */
async function discoverBlock(root: string, config: DiscoveryConfig, against: string, fresh: boolean) {
  const file = corpusFile(root, config), earlier = fresh ? [] : await loadCorpus(file);
  const result = await discoverWorkspace(root, config, against, earlier);
  await saveCorpus(file, earlier, result.corpus).catch(() => undefined);
  return result;
}

/** The FB/FC source files changed since the revision, in the working tree (untracked ones too). */
async function changedBlocks(root: string, revision: string): Promise<string[]> {
  const git = async (...args: string[]) => (await run("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 8 << 20 })).stdout.split("\n").map(l => l.trim()).filter(Boolean);
  const names = [...await git("diff", "--name-only", "--relative", revision, "--"), ...await git("ls-files", "--others", "--exclude-standard")];
  const index = new WorkspaceIndex(); await index.load(root);
  return [...new Set(names)].map(n => resolve(root, n)).filter(file => {
    const blocks = index.docs.get(pathToFileURL(file).href)?.parsed?.blocks ?? [];
    return blocks.length === 1 && ["FB", "FC"].includes(blocks[0]!.kind) && blocks[0]!.lad === undefined;
  }).sort();
}

/** HEAD when the file has changes; when it has none, the version before the last commit that changed it. */
async function previousVersion(root: string, file: string): Promise<string> {
  const git = (...args: string[]) => run("git", ["-C", root, ...args], { windowsHide: true });
  const changed = await git("diff", "--quiet", "HEAD", "--", file).then(() => false, () => true);
  if (changed) return "HEAD";
  const last = (await git("log", "-1", "--format=%H", "--", file).catch(() => ({ stdout: "" }))).stdout.trim();
  return last && await git("rev-parse", "--verify", "--quiet", `${last}^`).then(() => true, () => false) ? `${last}^` : "HEAD";
}

type BlockOutcome = { block: string; file: string; status: "found" | "not-found" | "unavailable"; summary: string; directory?: string };

export async function cmdDiscover(file: string | undefined, options: { against?: string; out?: string; json?: boolean; file?: string; fresh?: boolean }, io: Io): Promise<number> {
  if (file && options.file) throw new Error("Use rung discover [config.yaml | --file <block.scl>] [--against <git revision>] [--out <new directory>] [--json]");
  const root = await findWorkspace(io.cwd);
  let against = options.against ?? "HEAD";
  const base = options.out ? resolve(io.cwd, options.out) : join(root, ".rung", "discover", randomUUID());
  if (!file && !options.file) {
    const files = await changedBlocks(root, against);
    if (!files.length) throw new Error(`No changed FB or FC since ${against}; change a block or name one with --file`);
    const results: BlockOutcome[] = [];
    // ponytail: serial, 16 blocks at most; a wider change set names its blocks one by one
    for (const f of files.slice(0, 16)) {
      const rel = relative(root, f).replace(/\\/g, "/");
      try {
        const config = await discoveryForFile(root, f, await referenceText(root, f, against));
        const result = await discoverBlock(root, config, against, !!options.fresh), directory = join(base, config.block);
        await writeEvidence(directory, result);
        results.push({ block: config.block, file: rel, status: result.status, summary: summary(result) + more(result), directory });
      } catch (error) {
        results.push({ block: rel.replace(/^.*\//, "").replace(/\.[^.]+$/, ""), file: rel, status: "unavailable", summary: error instanceof Error ? error.message : String(error) });
      }
    }
    const skipped = files.length - results.length, mark = { found: "≠", "not-found": "=", unavailable: "?" };
    io.stdout(options.json ? JSON.stringify({ version: 1, against, results, ...(skipped ? { skipped } : {}) }) + "\n"
      : results.map(r => `${mark[r.status]} ${r.block}  ${r.summary}${r.status === "found" ? `\n  ${join(r.directory!, "report.html")}` : ""}`).join("\n")
        + `${skipped ? `\n${skipped} more changed blocks not searched; name one with --file` : ""}\n`
        + "Not finding a difference does not prove the versions equal. Review a found difference before keeping its test.\n");
    return results.some(r => r.status === "found") ? 2 : 0;
  }
  const path = options.file ? resolve(io.cwd, options.file) : undefined;
  if (path && !options.against) against = await previousVersion(root, path);
  const config = path ? await discoveryForFile(root, path, await referenceText(root, path, against)) : parseDiscoveryConfig(await readBoundedText(resolve(io.cwd, file!), "Discovery configuration"));
  const result = await discoverBlock(root, config, against, !!options.fresh);
  await writeEvidence(base, result);
  const { corpus: _corpus, ...evidence } = result;
  io.stdout(options.json ? JSON.stringify({ ...evidence, directory: base }) + "\n"
    : `${result.status === "found" ? "Found a behavioural difference" : "No difference found within the search budget"}: ${summary(result)}${more(result)}.\nReport: ${join(base, "report.html")}\n${result.witness ? "Review the reference expectations before keeping the generated test.\n" : ""}`);
  return result.status === "found" ? 2 : 0;
}
