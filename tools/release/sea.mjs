// SPDX-License-Identifier: MIT
// Builds rung.exe (Node single executable application) from dist/release/rung.cjs.
import { execFileSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = join(root, "dist", "release");
const exe = join(out, process.platform === "win32" ? "rung.exe" : "rung");
writeFileSync(join(out, "sea-config.json"), JSON.stringify({ main: join(out, "rung.cjs"), output: join(out, "sea-prep.blob"), disableExperimentalSEAWarning: true, useCodeCache: false }));
execFileSync(process.execPath, ["--experimental-sea-config", join(out, "sea-config.json")], { stdio: "inherit" });
copyFileSync(process.execPath, exe);
const postject = join(root, "node_modules", "postject", "dist", "cli.js");
execFileSync(process.execPath, [postject, exe, "NODE_SEA_BLOB", join(out, "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", "--overwrite"], { stdio: "inherit" });
console.log(`built ${exe} (unsigned; sign before distribution)`);
