// SPDX-License-Identifier: BUSL-1.1
// rung test in GitHub Actions: every failure also as a workflow annotation on the line of its step, so it shows
// in the pull request next to the test file.
import { join, relative, sep } from "node:path";
import type { FileResult } from "@rung/sim";

const data = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const property = (s: string) => data(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** `::error file=…,line=…,title=…::…` lines; paths relative to the repository (`base`), results' to `ws`. */
export function githubAnnotations(results: readonly FileResult[], ws: string, base: string): string[] {
  const out: string[] = [];
  const at = (file: string, line: number | undefined, title: string, message: string) => {
    const path = relative(base, join(ws, file)).split(sep).join("/");
    out.push(`::error file=${property(path)}${line ? `,line=${line}` : ""},title=${property(title)}::${data(message)}`);
  };
  for (const f of results) {
    if (f.error) {
      at(f.file, undefined, `rung test: ${f.file}`, f.error);
      continue;
    }
    for (const c of f.cases) {
      if (c.passed) continue;
      const title = `rung test: ${f.block}: ${c.name}`;
      if (c.error) at(f.file, c.line, title, c.error);
      for (const x of c.failures) at(f.file, x.line ?? c.line, title, `step ${x.step}: ${x.name} expected ${JSON.stringify(x.expected)} got ${typeof x.actual === "string" && /^<.*>$/.test(x.actual) ? x.actual : JSON.stringify(x.actual)}`);
    }
  }
  return out;
}
