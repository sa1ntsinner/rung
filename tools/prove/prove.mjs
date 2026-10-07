// SPDX-License-Identifier: MIT
// Differential validation of rung's simulator against a real S7-1500 runtime (PLCSIM Advanced): the same test cases
// run in `rung test --observe` and, cycle by cycle, on a PLCSIM Advanced instance that runs the block downloaded
// from TIA Portal; every output after every step is compared. A disposable fixture only (never a machine's PLC).
//
//   node tools/prove/prove.mjs --workspace <rung workspace> --test tests/x.test.yaml --instance <PLCSIM instance> --db <instance DB>
//
// The instance DB must be NON_RETAIN and called without arguments from OB1 ("X_DB"();): the steps write its inputs
// directly and read its outputs. Steps with within/always/never are not compared (their length depends on the code).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// the yaml package rung itself reads tests with
const { parse } = createRequire(join(here, "..", "..", "packages", "lsp", "package.json"))("yaml");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ws = resolve(arg("workspace") ?? ".");
const test = arg("test");
const instance = arg("instance");
const db = arg("db");
if (!test || !instance || !db) {
  console.error("usage: node tools/prove/prove.mjs --workspace <dir> --test tests/x.test.yaml --instance <PLCSIM instance> --db <instance DB>");
  process.exit(1);
}

/** A duration as rung's tests write it (2s, 500ms, T#1m30s) in milliseconds. */
export function ms(text) {
  const t = String(text).trim().replace(/^(T|TIME|LT|LTIME)#/i, "").replace(/_/g, "");
  let total = 0;
  const sign = t.startsWith("-") ? -1 : 1;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(ms|d|h|m|s)/gi)) total += Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
  return sign * total;
}
/** A DATE as the CPU keeps it (days since 1990-01-01), a TIME_OF_DAY (ms of the day); undefined for anything else. */
const DAY = 86_400_000;
export function dateRaw(text) {
  const d = /^(?:D|DATE)#(\d{4}-\d{2}-\d{2})$/i.exec(String(text).trim());
  if (d) return (Date.parse(`${d[1]}T00:00:00Z`) - Date.UTC(1990, 0, 1)) / DAY;
  const t = /^(?:TOD|TIME_OF_DAY)#(\d+):(\d+)(?::(\d+(?:\.\d+)?))?$/i.exec(String(text).trim());
  return t ? Math.round(((Number(t[1]) * 60 + Number(t[2])) * 60 + Number(t[3] ?? 0)) * 1000) : undefined;
}
/** A value from the YAML as the PLC takes it: TRUE/FALSE, numbers, a duration as milliseconds. */
const value = (v) => {
  if (typeof v === "boolean" || typeof v === "number") return v;
  const s = String(v).trim();
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
  if (dateRaw(s) !== undefined) return dateRaw(s);
  const based = /^(?:(?:WORD|DWORD|BYTE|INT|DINT)#)?(2|8|16)#([0-9A-F_]+)$/i.exec(s); // 16#00F3
  if (based) return parseInt(based[2].replace(/_/g, ""), Number(based[1]));
  if (/^(L?T|L?TIME)#/i.test(s) || /^\d+(\.\d+)?(ms|s|m|h|d)$/i.test(s)) return ms(s);
  return s !== "" && Number.isFinite(Number(s)) ? Number(s) : s; // a text stays a text
};

const rung = join(here, "..", "..", "packages", "cli", "dist", "index.js");
const doc = parse(readFileSync(join(ws, test), "utf8"));
const cycle = ms(doc.cycle ?? "10ms");
// a failing case is an answer too: rung test exits 1 then, with the same JSON
const run = (args) => {
  try {
    return execFileSync(process.execPath, [rung, ...args], { cwd: ws, encoding: "utf8", maxBuffer: 1 << 26 });
  } catch (e) {
    if (e.stdout) return e.stdout;
    throw e;
  }
};
const offline = JSON.parse(run(["test", "--filter", test, "--json", "--observe"]).replace(/^[^{]*/, ""));
const norm = (f) => f.replace(/\\/g, "/").toLowerCase();
const cases = (offline.files.find((f) => norm(f.file).endsWith(norm(test))) ?? offline.files[0]).cases;

// the plan: per case the steps that ran cycles, each with what it sets and how many cycles it runs
const plan = { instance, db, cycleNs: cycle * 1e6, cases: [] };
const skipped = [];
doc.cases.forEach((c, n) => {
  const steps = [];
  let temporal = false;
  c.steps.forEach((s, k) => {
    if (s.within !== undefined || s.always !== undefined || s.never !== undefined) temporal = true;
    const cycles = (s.cycle !== undefined ? Number(s.cycle) : 0) + (s.advance !== undefined ? Math.max(1, Math.ceil(ms(s.advance) / cycle)) : 0);
    const observed = cases[n]?.observed?.find((o) => o.step === k + 1);
    if (!cycles && !s.set) return;
    steps.push({ step: k + 1, set: Object.fromEntries(Object.entries(s.set ?? {}).map(([key, v]) => [key, value(v)])), cycles, read: observed ? Object.keys(observed.values) : [] });
  });
  if (temporal) skipped.push(c.name);
  else plan.cases.push({ name: c.name, steps });
});

const dir = mkdtempSync(join(tmpdir(), "rung-prove-"));
writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
const real = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "plcsim-run.ps1"), "-Plan", join(dir, "plan.json")], { encoding: "utf8", maxBuffer: 1 << 26 }).trim());

// compare: booleans and integers exactly, reals to 1e-5 relative, times to one cycle
let differ = 0;
let compared = 0;
// a time as rung prints it (T#990ms) against the CPU's milliseconds: the same to one cycle (virtual cycles are a
// few microseconds longer than the test's)
const same = (a, b) => {
  if (typeof a === "string" && /^T#/i.test(a) && typeof b === "number") return Math.abs(ms(a) - b) <= cycle;
  if (typeof a === "string" && dateRaw(a) !== undefined && typeof b === "number") return dateRaw(a) === b;
  // rung's JSON has no infinities either (null); the CPU's come as text
  if (a === null && typeof b === "string" && /^-?(Infinity|∞)$|^NaN$/i.test(b)) return true;
  return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-5 * Math.abs(a) : a === b;
};
console.log(`rung's simulator against PLCSIM Advanced (${instance}, ${db}), ${test}, cycle ${cycle} ms`);
for (const c of plan.cases) {
  const off = cases.find((x) => x.name === c.name);
  const on = (real.cases ?? []).find((x) => x.name === c.name);
  const diffs = [];
  for (const s of on?.steps ?? []) {
    const want = off?.observed?.find((o) => o.step === s.step)?.values ?? {};
    for (const [k, v] of Object.entries(s.values)) {
      if (!(k in want)) continue;
      compared++;
      if (!same(want[k], v)) diffs.push(`step ${s.step}: ${k} rung ${JSON.stringify(want[k])}, PLCSIM ${JSON.stringify(v)}`);
    }
  }
  differ += diffs.length ? 1 : 0;
  console.log(`${diffs.length ? "DIFF" : "same"}  ${c.name}`);
  for (const d of diffs) console.log(`        ${d}`);
}
for (const s of skipped) console.log(`skip  ${s} (within/always/never: not compared)`);
console.log(`\n${plan.cases.length - differ}/${plan.cases.length} cases behave the same (${compared} values compared)${skipped.length ? `, ${skipped.length} skipped` : ""}`);
process.exit(differ ? 2 : 0);
