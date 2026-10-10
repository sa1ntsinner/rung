// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runningSimulator } from "../src/simulate.js";

it("finds the workspace's running rung simulate by its marker, and ignores one whose process is gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "rung-sim-"));
  expect(await runningSimulator(root)).toBeUndefined();
  mkdirSync(join(root, ".rung"));
  writeFileSync(join(root, ".rung", "simulate.json"), JSON.stringify({ url: "http://127.0.0.2:8080", pid: process.pid }));
  expect(await runningSimulator(root)).toEqual({ url: "http://127.0.0.2:8080" });
  writeFileSync(join(root, ".rung", "simulate.json"), JSON.stringify({ url: "http://127.0.0.2:8080", pid: 2 ** 30 }));
  expect(await runningSimulator(root)).toBeUndefined();
});
