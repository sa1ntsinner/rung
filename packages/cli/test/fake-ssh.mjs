// SPDX-License-Identifier: BUSL-1.1
// Stands in for ssh in CLI tests: logs what it was asked, then runs the remote command line (`rung bridge …`, as
// cmd.exe on the Windows PC would split it) here, with the fake bridge.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const line = argv[argv.length - 1];
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + "\n");
const words = [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2]));
if (words[0] !== "rung" || words[1] !== "bridge") {
  process.stderr.write(`fake ssh: unexpected command ${line}\n`);
  process.exit(127);
}
let rest = words.slice(2);
if (rest[0] === "--tia") rest = rest.slice(2);
const bridge = fileURLToPath(new URL("./fake-bridge.mjs", import.meta.url));
const child = spawn(process.execPath, [bridge, ...rest], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
