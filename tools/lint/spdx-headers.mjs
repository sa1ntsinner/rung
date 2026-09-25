// SPDX-License-Identifier: MIT
// Fails when a source file lacks the SPDX header required for its directory.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = [
  { prefix: "packages/bridge-client/", license: "MIT" },
  { prefix: "packages/", license: "BUSL-1.1" },
  { prefix: "bridge/", license: "BUSL-1.1" },
  { prefix: "grammars/", license: "MIT" },
  { prefix: "editors/", license: "MIT" },
  { prefix: "agents/", license: "MIT" },
  { prefix: "tools/", license: "MIT" },
];
const EXT = /\.(ts|mts|mjs|js|cs)$/;
const SKIP = /(^|\/)(node_modules|dist|bin|obj|\.rung|TestResults)(\/|$)/;

export function expectedLicense(rel) {
  return RULES.find((r) => rel.startsWith(r.prefix))?.license;
}

export function checkFiles(root, files) {
  const problems = [];
  for (const rel of files) {
    const want = expectedLicense(rel);
    if (!want || !EXT.test(rel) || SKIP.test(rel)) continue;
    const head = readFileSync(join(root, rel), "utf8").replace(/^﻿/, "").split("\n").slice(0, 3).join("\n");
    if (!head.includes(`SPDX-License-Identifier: ${want}`)) problems.push(`${rel}: expected SPDX-License-Identifier: ${want}`);
  }
  return problems;
}

export function listFiles(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join("/");
    if (SKIP.test(rel) || name.startsWith(".git")) continue;
    if (statSync(full).isDirectory()) listFiles(root, full, out); else out.push(rel);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2] ?? process.cwd();
  const problems = checkFiles(root, listFiles(root));
  for (const p of problems) console.error(p);
  if (problems.length) { console.error(`${problems.length} file(s) missing SPDX headers`); process.exit(1); }
  console.log("spdx-headers: ok");
}
