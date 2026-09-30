// SPDX-License-Identifier: MIT
// Builds what the site runs from rung's own code: the playground (the simulator and test runner) as one
// browser module.  node tools/site/build.mjs  -> site/assets/play.js
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// the workspace loader and the test-folder walk read files; the playground gives the index its one file itself
const nodeStub = join(root, "tools", "site", "node-stub.mjs");

await build({
  entryPoints: [join(root, "tools", "site", "play.ts")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "none",
  outfile: join(root, "site", "assets", "play.js"),
  alias: {
    "@rung/lsp": join(root, "tools", "site", "lsp-lite.ts"),
    "@rung/sim": join(root, "packages", "sim", "src", "index.ts"),
    "node:fs/promises": nodeStub,
    "node:fs": nodeStub,
    "node:path": nodeStub,
    "node:url": nodeStub,
  },
  logLevel: "warning",
  banner: { js: "// rung's simulator and test runner, built for the browser from https://github.com/sa1ntsinner/rung (BUSL-1.1; yaml: ISC)" },
});
