// SPDX-License-Identifier: MIT
// rung.nvim's headless checks (editors/neovim/tests), where Neovim is installed and the CLI is built.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../../editors/neovim", import.meta.url));
const cli = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
const nvim = spawnSync("nvim", ["--version"], { encoding: "utf8" });
const ready = nvim.status === 0 && existsSync(cli);

describe.skipIf(!ready)("rung.nvim", () => {
  it("passes its smoke test: commands, tests, coverage, recorded expectations", () => {
    const r = spawnSync("nvim", ["--headless", "--clean", "-l", "tests/smoke.lua"], { cwd: plugin, encoding: "utf8", timeout: 240_000 });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("all passed");
    expect(r.status).toBe(0);
  }, 300_000);
});
