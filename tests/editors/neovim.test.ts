// SPDX-License-Identifier: MIT
// rung.nvim's headless checks (editors/neovim/tests), where Neovim is installed and the CLI is built. CI sets
// RUNG_REQUIRE_NVIM=1, NVIM_DAP and NEOTEST_DEPS: there a missing Neovim or plugin fails instead of skipping.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../../editors/neovim", import.meta.url));
const cli = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
const nvim = spawnSync("nvim", ["--version"], { encoding: "utf8" });
// rung.nvim needs Neovim 0.11+ (`nvim -l` came in 0.9): an older one, as Ubuntu 22.04 ships 0.6, would hang the run
const [major = 0, minor = 0] = (/NVIM v(\d+)\.(\d+)/.exec(nvim.stdout ?? "") ?? []).slice(1).map(Number);
const required = process.env.RUNG_REQUIRE_NVIM === "1";
const ready = required || (nvim.status === 0 && (major > 0 || minor >= 11) && existsSync(cli));

const run = (script: string) => {
  const r = spawnSync("nvim", ["--headless", "--clean", "-l", script], { cwd: plugin, encoding: "utf8", timeout: 240_000 });
  return { out: `${r.stdout}${r.stderr}${r.error ? String(r.error) : ""}`, status: r.status };
};

describe.skipIf(!ready)("rung.nvim", () => {
  it("passes its smoke test: commands, tests, coverage, recorded expectations", () => {
    const r = run("tests/smoke.lua");
    expect(r.out).toContain("all passed");
    expect(r.status).toBe(0);
  }, 300_000);

  it("streams a watch table", () => {
    const r = run("tests/watch-table.lua");
    expect(r.out).not.toMatch(/FAIL|Error/);
    expect(r.status).toBe(0);
  }, 60_000);

  // these need plugins next to rung.nvim: CI clones them at pinned versions
  for (const [script, env] of [["tests/dap.lua", "NVIM_DAP"], ["tests/neotest.lua", "NEOTEST_DEPS"]] as const) {
    it.skipIf(!process.env[env] && !required)(`passes ${script}`, () => {
      const r = run(script);
      expect(r.out).toContain("all passed");
      expect(r.status).toBe(0);
    }, 300_000);
  }
});
