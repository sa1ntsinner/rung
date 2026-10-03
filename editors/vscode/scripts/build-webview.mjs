// SPDX-License-Identifier: MIT
// Builds rung's webviews into out/webview: one browser bundle per view, the shared styles and VS Code's codicons
// (copied, never loaded from the network). Prints the sizes so the budget stays visible.
import { build } from "esbuild";
import { cpSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "out", "webview");
const minify = process.argv.includes("--minify");
mkdirSync(out, { recursive: true });

const views = ["declarations"];
await build({
  entryPoints: views.map((v) => join(root, "src", "webview", `${v}.ts`)),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outdir: out,
  minify,
  sourcemap: !minify,
  logLevel: "warning",
});
for (const css of ["tokens.css", "rung.css"]) cpSync(join(root, "src", "webview", css), join(out, css));
const codicons = join(root, "node_modules", "@vscode", "codicons", "dist");
for (const f of ["codicon.css", "codicon.ttf"]) cpSync(join(codicons, f), join(out, f));

const kb = (f) => `${(statSync(join(out, f)).size / 1024).toFixed(1)} KB`;
console.log(`webview: ${views.map((v) => `${v}.js ${kb(`${v}.js`)}`).join(", ")}, rung.css ${kb("rung.css")}, codicon.ttf ${kb("codicon.ttf")}`);
