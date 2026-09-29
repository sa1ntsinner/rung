// SPDX-License-Identifier: BUSL-1.1
// Download, compare and online against S7-PLCSIM V20 with the runnable fixture.
//   node tools/fixtures/plcsim.mjs start
//   powershell -File tools\fixtures\New-FixtureProject.ps1 -Name RungPlcsim -Runnable   (once)
//   powershell -File tools\fixtures\Start-FixtureHost.ps1 -Name RungPlcsim            (after PLCSIM runs)
//   RUNG_E2E_PLCSIM=1 pnpm vitest run tests/e2e/plcsim.e2e.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { main } from "../../packages/cli/src/main.js";

const enabled = process.env.RUNG_E2E_PLCSIM === "1";
const project = process.env.RUNG_PLCSIM_PROJECT ?? join(homedir(), "rung-fixtures", "RungPlcsim", "RungPlcsim.ap20");

describe.runIf(enabled)("e2e: download to S7-PLCSIM", () => {
  const dir = enabled ? mkdtempSync(join(tmpdir(), "rung-e2e-plcsim-")) : "";
  const out: string[] = [];
  const io = { cwd: dir, stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), env: process.env };
  const counter = join(dir, "plc", "PLC_1", "blocks", "10_Drives", "Fx_Counter.scl");
  const run = async (args: string[]) => {
    out.length = 0;
    const code = await main(args, io);
    return { code, text: out.join("") };
  };

  it("finds PLCSIM, downloads hardware and software, and the PLC then runs the project", async () => {
    expect((await run(["init", "--project", project])).code).toBe(0);
    expect([0, 2]).toContain((await run(["pull"])).code);
    // a download never finds its PLC by itself: rung connect finds PLCSIM and saves the connection
    const noTarget = await run(["download", "--yes"]);
    expect(noTarget.text).toMatch(/rung never picks a PLC to download to by itself/);
    const connect = await run(["connect"]);
    expect(connect.code).toBe(0);
    expect(connect.text).toMatch(/S7-PLCSIM \(PLCSIM → 1 X1\); saved/);
    // a fresh instance asks to be reset; a second run of this test does not, and the allow is simply unused
    const dl = await run(["download", "--yes", "--hw", "--allow", "reset-module"]);
    expect(dl.text).toMatch(/via PLCSIM/);
    expect(dl.code).toBe(0);
    expect(dl.text).toMatch(/Hardware configuration was loaded successfully|download: Success/);
    const cmp = await run(["compare"]);
    expect(cmp.text).toMatch(/the PLC runs what the project has/);
    expect(cmp.code).toBe(0);
    expect((await run(["online"])).text).toMatch(/PLC_1: Online/);
  }, 900_000);

  it("an edited block shows up in compare, and downloading the change makes them equal again", async () => {
    const before = readFileSync(counter, "utf8");
    const [from, to] = before.includes("PT := T#30ms") ? ["PT := T#30ms", "PT := T#20ms"] : ["PT := T#20ms", "PT := T#30ms"];
    writeFileSync(counter, before.replace(from, to));
    expect((await run(["sync"])).text).toMatch(/imported 1/);
    const cmp = await run(["compare"]);
    expect(cmp.code).toBe(2);
    expect(cmp.text).toMatch(/differs\s+plc\/PLC_1\/blocks\/10_Drives\/Fx_Counter\.scl/);
    const dl = await run(["download", "--yes"]);
    expect(dl.code).toBe(0);
    expect(dl.text).toMatch(/'Fx_Counter' was loaded successfully/);
    expect((await run(["compare"])).code).toBe(0);
  }, 900_000);

  it("an interface change is not downloaded until reinitialising the data blocks is allowed", async () => {
    const before = readFileSync(counter, "utf8");
    writeFileSync(counter, before.replace("      LastPulse : Bool;", "      LastPulse : Bool;\n      E2eEdges : DInt;"));
    expect((await run(["sync"])).text).toMatch(/imported 1/);
    const refused = await run(["download", "--yes"]);
    expect(refused.code).toBe(3);
    expect(refused.text).toMatch(/--allow reinit-db/);
    expect(refused.text).not.toMatch(/was unhandled/);
    expect((await run(["compare"])).code).toBe(2); // nothing was downloaded
    const allowed = await run(["download", "--yes", "--allow", "reinit-db"]);
    expect(allowed.code).toBe(0);
    expect((await run(["compare"])).code).toBe(0);

    // leave the fixture as it was
    writeFileSync(counter, readFileSync(counter, "utf8").replace(/\r?\n\s*E2eEdges : DInt;/, ""));
    await run(["sync"]);
    expect((await run(["download", "--yes", "--allow", "reinit-db"])).code).toBe(0);
  }, 900_000);
});
