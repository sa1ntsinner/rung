// SPDX-License-Identifier: MIT
// Use a fixed CLI next to the plugin, including when Claude caches a release plugin.
const { existsSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { spawn } = require("node:child_process");
const guardHook = process.argv.slice(2).includes("guard") && process.argv.some(arg => /^--(?:claude|cursor|copilot)-hook$/.test(arg));
const failureCode = guardHook ? 2 : 1;

const root = resolve(__dirname, "../../..");
const cli = [
  join(root, "rung.cjs"),
  join(__dirname, "runtime", "rung.cjs"),
  join(root, "packages", "cli", "dist", "bin.js"),
  join(root, "dist", "release", "rung.cjs"),
].find(existsSync);

if (!cli) {
  console.error("rung CLI is missing from this plugin installation. Install the plugin from a rung release; for a source checkout, run pnpm build first.");
  process.exitCode = failureCode;
} else {
  const env = { ...process.env };
  // The broker and companion hosts must use this CLI's installation, even after plugin caching.
  if (cli.endsWith("rung.cjs")) env.RUNG_HOME = dirname(cli);
  else delete env.RUNG_HOME;
  const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true, env });
  child.on("error", (error) => { console.error(`Cannot start rung: ${error.message}`); process.exitCode = failureCode; });
  child.on("exit", (code) => { process.exitCode = code === 0 ? 0 : guardHook ? 2 : code ?? 1; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
}
