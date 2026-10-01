// SPDX-License-Identifier: MIT
// Checks downloaded release files against the release's SHA256SUMS.txt (the format sha256sum writes).
//   node tools/release/verify.mjs <dir> <file>...   exits 1 when a file is missing from the list or differs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, ...files] = process.argv.slice(2);
if (!dir || !files.length) {
  console.error("usage: node verify.mjs <dir> <file>...");
  process.exit(2);
}
const sums = new Map(
  readFileSync(join(dir, "SHA256SUMS.txt"), "utf8")
    .split(/\r?\n/)
    .map((l) => /^([0-9a-f]{64}) [ *](.+)$/i.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[2], m[1].toLowerCase()]),
);
let bad = 0;
for (const f of files) {
  const want = sums.get(f);
  const got = createHash("sha256").update(readFileSync(join(dir, f))).digest("hex");
  if (!want) console.error(`${f}: not in SHA256SUMS.txt`);
  else if (want !== got) console.error(`${f}: sha256 ${got}, SHA256SUMS.txt says ${want}`);
  else continue;
  bad++;
}
if (bad) process.exit(1);
console.log(`${files.join(", ")}: checksum ok`);
