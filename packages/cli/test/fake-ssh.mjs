// SPDX-License-Identifier: BUSL-1.1
// Stands in for ssh in CLI tests: logs what it was asked, then runs the remote command line (`rung bridge --args …`)
// here, with the fake bridge. It splits the line like cmd.exe on the Windows PC would and refuses anything cmd.exe
// could read differently (quotes, %, &, |, ^, <, >): the arguments must arrive as one encoded word.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const line = argv[argv.length - 1];
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + "\n");
const words = line.split(" ");
if (/["%&|^<>]/.test(line) || words.length !== 4 || words[0] !== "rung" || words[1] !== "bridge" || words[2] !== "--args" || !/^[A-Za-z0-9_-]+$/.test(words[3])) {
  process.stderr.write(`fake ssh: unexpected command ${line}\n`);
  process.exit(127);
}
let rest = JSON.parse(Buffer.from(words[3], "base64url").toString("utf8"));
if (rest[0] === "--tia") rest = rest.slice(2);
const bridge = fileURLToPath(new URL("./fake-bridge.mjs", import.meta.url));
const child = spawn(process.execPath, [bridge, ...rest], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
