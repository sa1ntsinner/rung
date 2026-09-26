// SPDX-License-Identifier: BUSL-1.1
// End-to-end: real rung-bridge-v20 + TIA Portal with the generated fixture open.
//   RUNG_E2E=1 pnpm vitest run tests/e2e
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { main } from "../../packages/cli/src/main.js";

const enabled = process.env.RUNG_E2E === "1";
const project = process.env.RUNG_PROJECT ?? join(homedir(), "rung-fixtures", "RungFixture", "RungFixture.ap20");

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".rung") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(root, p).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

describe.runIf(enabled)("e2e: pull against the fixture project", () => {
  const dir = enabled ? mkdtempSync(join(tmpdir(), "rung-e2e-")) : "";

  const out: string[] = [];
  const io = { cwd: dir, stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), env: process.env };
  const manifest = (enabled ? JSON.parse(readFileSync(join(project, "..", "fixture-manifest.json"), "utf8").replace(/^﻿/, "")) /* written by Windows PowerShell 5.1 with a BOM */ : { addresses: [] }) as { addresses: string[] };

  it("init binds the fixture", async () => {
    expect(await main(["init", "--project", project], io)).toBe(0);
  }, 180_000);

  it("pull writes every manifest object in its expected form", async () => {
    const code = await main(["pull"], io);
    expect([0, 2]).toContain(code);
    const files = tree(dir);
    const expect1 = (p: string) => expect(files, out.join("")).toContain(p);
    expect1("plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl");
    expect1("plc/PLC_1/blocks/10_Drives/Fx_Counter.scl");
    expect1("plc/PLC_1/blocks/20_Valves/Fx_Valve.scl");
    expect1("plc/PLC_1/blocks/Fx_Global.db");
    expect1("plc/PLC_1/blocks/Fx_Stl.awl");
    expect1("plc/PLC_1/types/Fx_Types.udt");
    expect1("plc/PLC_1/tags/Fx_Inputs.tags.xml");
    if (manifest.addresses.includes("plc:PLC_1/blocks/Fx_Secret")) expect1("plc/PLC_1/blocks/Fx_Secret.protected.yaml");
    if (manifest.addresses.includes("plc:PLC_1/blocks/20_Valves/Fx_LadInterlock"))
      expect(files.some((f) => f.startsWith("plc/PLC_1/blocks/20_Valves/Fx_LadInterlock."))).toBe(true);
    expect(readFileSync(join(dir, "plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl"), "utf8")).toContain("Überwachung");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  }, 600_000);

  it("second pull is incremental and fast", async () => {
    out.length = 0;
    const t0 = Date.now();
    const code = await main(["pull"], io);
    const ms = Date.now() - t0;
    expect([0, 2]).toContain(code);
    expect(out.join("")).toMatch(/exported\s+0/);
    console.log(`second pull: ${ms} ms`);
    expect(ms).toBeLessThan(10_000);
  }, 120_000);

  it("doctor reports convergence for source forms", async () => {
    out.length = 0;
    const code = await main(["doctor", "--fixture"], io);
    console.log(out.join(""));
    const report = JSON.parse(readFileSync(join(dir, ".rung", "doctor-report.json"), "utf8")) as { form: string; pass2Equal: boolean; error?: string; skipped?: string; address: string }[];
    const sources = report.filter((r) => ["scl", "db", "udt", "awl"].includes(r.form) && !r.address.endsWith("/Fx_Broken"));
    expect(sources.length).toBeGreaterThan(0);
    for (const r of sources) expect(r.pass2Equal, `${r.address} ${r.error ?? ""}`).toBe(true);
    expect([0, 2]).toContain(code);
  }, 900_000);
});
