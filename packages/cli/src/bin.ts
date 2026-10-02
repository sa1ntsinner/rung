// SPDX-License-Identifier: BUSL-1.1
// Entry for the bundled CLI (CommonJS, no top-level await) used by rung.cjs and the rung.exe single executable.
import { main } from "./main.js";
import { quietBrokenPipe } from "./output.js";

quietBrokenPipe(process.stdout);
quietBrokenPipe(process.stderr);

// started by the VS Code extension's `rung` command with VS Code's own Node.js: what rung starts (VS Code's
// CLI, the bridge) must not run as Node.js too
delete process.env.ELECTRON_RUN_AS_NODE;

void main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`rung: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
