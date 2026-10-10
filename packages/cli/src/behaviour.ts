// SPDX-License-Identifier: BUSL-1.1
// rung test --against <git revision>: the same scenarios (today's test files) run on the code as it was at that
// revision and as it is now; where the block's values differ after a step is the change in behaviour, the thing a
// reviewer needs that a text diff does not show.
import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { WorkspaceIndex } from "@rung/lsp";
import { runTests, type FileResult } from "@rung/sim";

const run = promisify(execFile);

export interface Divergence {
  file: string;
  case: string;
  index: number;
  /** the values that differ, step by step (from 1) */
  differences: { step: number; name: string; before: unknown; after: unknown }[];
  /** passed / failed / error at the revision and now, when that changed */
  verdict?: { before: string; after: string };
}

/** The workspace's code as it was at a git revision: the same files, their content at that revision. */
export async function indexAt(ws: string, current: WorkspaceIndex, rev: string): Promise<WorkspaceIndex> {
  const top = (
    await run("git", ["-C", ws, "rev-parse", "--show-toplevel"], { windowsHide: true }).catch(() => {
      throw new Error(`${ws} is not in a git repository: --against compares with a git revision`);
    })
  ).stdout.trim();
  await run("git", ["-C", ws, "rev-parse", "--verify", `${rev}^{commit}`], { windowsHide: true }).catch(() => {
    throw new Error(`${rev} is not a revision of this repository`);
  });
  const base = new WorkspaceIndex();
  base.layout = current.layout;
  // git names the top folder by its long name; the workspace may be spelled by its 8.3 short one (a temp folder of a
  // long user name): compare real paths, and give files the workspace's own spelling, as the index has them
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };
  const realTop = real(top);
  const realWs = real(ws);
  for (const uri of current.docs.keys()) {
    if (!uri.startsWith("file:")) continue;
    const rel = relative(realTop, real(fileURLToPath(uri))).split("\\").join("/");
    if (rel.startsWith("..")) continue;
    // a file that did not exist then is not part of the code then
    const text = await run("git", ["-C", top, "show", `${rev}:${rel}`], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).then(
      (r) => r.stdout,
      () => undefined,
    );
    if (text !== undefined) base.set(uri, text, 0);
  }
  // code that was there then and is gone or moved now (deleted, renamed): part of the code then too
  const prefix = relative(realTop, realWs).split("\\").join("/");
  const listed = await run("git", ["-C", top, "ls-tree", "-r", "--name-only", rev, "--", prefix || "."], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.split(/\r?\n/).filter(Boolean), () => [] as string[]);
  for (const rel of listed) {
    if (!/\.(scl|db|udt|awl|xml|s7dcl|st)$/i.test(rel) || /(^|\/)tests\//.test(rel)) continue;
    const uri = pathToFileURL(join(ws, relative(realWs, join(realTop, rel)))).href;
    if (base.docs.has(uri) || current.docs.has(uri)) continue;
    const text = await run("git", ["-C", top, "show", `${rev}:${rel}`], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout, () => undefined);
    if (text !== undefined) base.set(uri, text, 0);
  }
  return base;
}

const verdict = (c: { passed: boolean; error?: string } | undefined) => (!c ? "missing" : c.error ? "error" : c.passed ? "passed" : "failed");

/** Every case whose values or verdict differ between the code then and now. */
export function divergences(before: FileResult[], after: FileResult[]): Divergence[] {
  const out: Divergence[] = [];
  for (const f of after) {
    const old = before.find((b) => b.file === f.file);
    for (const c of f.cases) {
      const o = old?.cases.find((x) => x.index === c.index);
      const differences: Divergence["differences"] = [];
      for (const now of c.observed ?? []) {
        const then = o?.observed?.find((x) => x.step === now.step);
        for (const name of new Set([...Object.keys(now.values), ...Object.keys(then?.values ?? {})])) {
          const a = then?.values[name];
          const b = now.values[name];
          if (JSON.stringify(a) !== JSON.stringify(b)) differences.push({ step: now.step, name, before: a, after: b });
        }
      }
      const vb = verdict(o);
      const va = verdict(c);
      if (differences.length || vb !== va) out.push({ file: f.file, case: c.name, index: c.index ?? 0, differences, ...(vb !== va ? { verdict: { before: vb, after: va } } : {}) });
    }
  }
  return out;
}

const shown = (v: unknown) => (v === undefined ? "—" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "string" ? v : JSON.stringify(v));

/** Runs the scenarios on both and says what behaves differently. */
export async function behaviourAgainst(ws: string, current: WorkspaceIndex, rev: string, filter?: string): Promise<{ divergences: Divergence[]; cases: number; text: string; worse: boolean }> {
  const base = await indexAt(ws, current, rev);
  const [then, now] = [await runTests(ws, base, filter, undefined, { observe: true }), await runTests(ws, current, filter, undefined, { observe: true })];
  const d = divergences(then, now);
  const cases = now.reduce((n, f) => n + f.cases.length, 0);
  const lines = [`behaviour against ${rev} (${cases} case${cases === 1 ? "" : "s"}):`];
  for (const x of d) {
    lines.push(`  ${x.file}: ${x.case}${x.verdict ? ` (${x.verdict.before} then, ${x.verdict.after} now)` : ""}`);
    const first = x.differences[0];
    if (first) lines.push(`     step ${first.step}: ${first.name} ${shown(first.before)} → ${shown(first.after)}${x.differences.length > 1 ? ` (first of ${x.differences.length} differences)` : ""}`);
  }
  lines.push(d.length ? `${d.length} case${d.length === 1 ? " behaves" : "s behave"} differently, ${cases - d.length} the same` : "every case behaves as it did");
  // a case that passed then and does not now: a CI step can stop on it
  const worse = d.some((x) => x.verdict?.before === "passed" && x.verdict.after !== "passed");
  if (!cases) lines.splice(1, 0, "  no test case ran now (a filter that matches nothing, or the tested blocks are gone)");
  return { divergences: d, cases, worse, text: lines.join("\n") + "\n" };
}
