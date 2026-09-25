#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
import { main } from "./main.js";

const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
});
process.exitCode = code;
