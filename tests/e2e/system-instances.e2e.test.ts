// SPDX-License-Identifier: BUSL-1.1
// Read-only acceptance against an explicitly supplied disposable pumping-station project.
import { expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "@rung/core";
import { WorkspaceIndex } from "@rung/lsp";
import { Simulator } from "@rung/sim";
import { main } from "../../packages/cli/src/main.js";

const project = process.env.RUNG_SYSTEM_INSTANCE_PROJECT;
it.runIf(!!project)("mirrors native IEC system instance DBs read-only and runs the original LAD without stubs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rung-system-instances-"));
  const output: string[] = [];
  const io = { cwd, env: process.env, stdout: (s: string) => output.push(s), stderr: (s: string) => output.push(s) };
  try {
    expect(await main(["init", "--project", project!, "--tia", "V20"], io), output.join("")).toBe(0);
    expect(await main(["pull"], io), output.join("")).toBe(0);
    const state = await StateStore.open(cwd, { projectPath: project!, tiaVersion: "V20", devices: [] });
    try {
      const objects = JSON.parse(readFileSync(join(cwd, ".rung", "state.json"), "utf8")).objects as Record<string, { path: string }>;
      for (const name of ["R_TRIG_HighLevel", "R_TRIG_clock1hz", "TON_ResetDelay"]) {
        const address = Object.keys(objects).find(a => a.endsWith(`/${name}`));
        expect(address, `${name}: ${output.join("")}`).toBeDefined();
        expect(state.get(address!)!.readOnly).toBe(true);
      }
    } finally { await state.close(); }
    const index = new WorkspaceIndex();
    await index.load(cwd);
    const simulator = new Simulator(index);
    expect(() => simulator.callBlock("Main")).not.toThrow();
    expect(() => simulator.callBlock("Main")).not.toThrow();
  } finally {
    expect(await main(["session", "--release"], io), output.join("")).toBe(0);
  }
}, 300_000);
