// SPDX-License-Identifier: MIT
// Bundles the rung CLI into one CommonJS file and collects third-party licence notices.
//   node tools/release/bundle.mjs            -> dist/release/rung.cjs + THIRD_PARTY_NOTICES.txt
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = join(root, "dist", "release");
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: [join(root, "packages", "cli", "src", "bin.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: join(out, "rung.cjs"),
  define: { "import.meta.url": "undefined" },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  banner: { js: "// rung — https://github.com/sa1ntsinner/rung — see LICENSE and THIRD_PARTY_NOTICES.txt" },
});

// Third-party packages that ended up in the bundle, with their licence texts.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const norm = input.split(sep).join("/");
  const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(norm);
  if (!m) continue;
  const name = m[1];
  if (name.startsWith("@rung/")) continue;
  const marker = `node_modules/${name}/`;
  const pkgDir = join(root, norm.slice(0, norm.lastIndexOf(marker) + marker.length - 1));
  if (!packages.has(name) && existsSync(join(pkgDir, "package.json"))) packages.set(name, pkgDir);
}
const notices = [];
for (const [name, dir] of [...packages].sort()) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  notices.push(`${"=".repeat(72)}\n${name}@${pkg.version} — ${pkg.license ?? "see below"}\n${"=".repeat(72)}\n${licFile ? readFileSync(join(dir, licFile), "utf8").trim() : "(no licence file shipped; licence field: " + (pkg.license ?? "unknown") + ")"}\n`);
}
writeFileSync(join(out, "THIRD_PARTY_NOTICES.txt"), `Third-party software bundled in rung.cjs / rung.exe\n\n${notices.join("\n")}`);
const size = readFileSync(join(out, "rung.cjs")).length;
console.log(`bundled ${relative(root, join(out, "rung.cjs"))} (${(size / 1024).toFixed(0)} KiB), ${packages.size} third-party packages`);
