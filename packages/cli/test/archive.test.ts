// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.js";

it.each(["Line.zap19", "Line.ZAP20", "Line.zap21"])("refuses archive %s before starting TIA", async (project) => {
  const cwd = mkdtempSync(join(tmpdir(), "rung-archive-"));
  let error = "";
  const result = await main(["init", "--project", project], { cwd, env: { RUNG_BRIDGE: "must-not-start.exe" }, stdout: () => {}, stderr: s => { error += s; } });
  expect(result).toBe(1);
  expect(error).toMatch(/archive.*retrieve.*TIA Portal/i);
  expect(error).not.toMatch(/BRIDGE_EXITED/);
  expect(existsSync(join(cwd, "rung.toml"))).toBe(false);
});
