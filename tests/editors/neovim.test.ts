// SPDX-License-Identifier: MIT
// rung.nvim's headless checks (editors/neovim/tests), where Neovim is installed and the CLI is built.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../../editors/neovim", import.meta.url));
const cli = fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url));
const nvim = spawnSync("nvim", ["--version"], { encoding: "utf8" });
// rung.nvim needs Neovim 0.11+ (`nvim -l` came in 0.9): an older one, as Ubuntu 22.04 ships 0.6, would hang the run
const [major = 0, minor = 0] = (/NVIM v(\d+)\.(\d+)/.exec(nvim.stdout ?? "") ?? []).slice(1).map(Number);
const ready = nvim.status === 0 && (major > 0 || minor >= 11) && existsSync(cli);

describe.skipIf(!ready)("rung.nvim", () => {
  it("passes its smoke test: commands, tests, coverage, recorded expectations", () => {
    const r = spawnSync("nvim", ["--headless", "--clean", "-l", "tests/smoke.lua"], { cwd: plugin, encoding: "utf8", timeout: 240_000 });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("all passed");
    expect(r.status).toBe(0);
  }, 300_000);
});
