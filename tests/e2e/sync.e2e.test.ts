// SPDX-License-Identifier: BUSL-1.1
// End-to-end two-way sync against TIA Portal with the generated fixture open.
//   RUNG_E2E=1 pnpm vitest run tests/e2e/sync.e2e.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { main } from "../../packages/cli/src/main.js";

const enabled = process.env.RUNG_E2E === "1";
const project = process.env.RUNG_PROJECT ?? join(homedir(), "rung-fixtures", "RungFixture", "RungFixture.ap20");

describe.runIf(enabled)("e2e: two-way sync against the fixture project", () => {
  const dir = enabled ? mkdtempSync(join(tmpdir(), "rung-e2e-sync-")) : "";
  const out: string[] = [];
  const io = { cwd: dir, stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), env: process.env };
  const valve = join(dir, "plc", "PLC_1", "blocks", "20_Valves", "Fx_Valve.scl");
  const created = join(dir, "plc", "PLC_1", "blocks", "30_E2E", "Fx_E2E.scl");

  it("init + pull", async () => {
    expect(await main(["init", "--project", project, "--writes"], io)).toBe(0);
    expect([0, 2]).toContain(await main(["pull"], io));
    expect(existsSync(valve)).toBe(true);
  }, 600_000);

  it("a file edit is imported, compiled and written back canonically; then quiet", async () => {
    const before = readFileSync(valve, "utf8");
    // toggles, so a fixture left edited by an earlier run still sees a real change
    const [from, to] = before.includes("#Enable AND #Enable;") ? ["#Enable AND #Enable;", "#Enable;"] : ["#Open := #Enable;", "#Open := #Enable AND #Enable;"];
    expect(before).toContain(from);
    writeFileSync(valve, before.replace(from, to));
    out.length = 0;
    const t0 = Date.now();
    expect([0, 2]).toContain(await main(["sync"], io));
    console.log(`import+compile+export: ${Date.now() - t0} ms\n${out.join("")}`);
    expect(out.join("")).toMatch(/imported 1/);
    expect(readFileSync(valve, "utf8")).toContain(to);
    out.length = 0;
    await main(["sync"], io);
    expect(out.join("")).toMatch(/imported 0 .*/);
    expect(out.join("")).toMatch(/exported 0 /);
  }, 600_000);

  it("a new file creates a block in a new folder", async () => {
    mkdirSync(join(created, ".."), { recursive: true });
    writeFileSync(created, 'FUNCTION "Fx_E2E" : Void\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\n   VAR_INPUT\n      A : Bool;\n   END_VAR\n\nBEGIN\n\t;\nEND_FUNCTION\n');
    out.length = 0;
    await main(["sync"], io);
    expect(out.join("")).toMatch(/created 1/);
  }, 600_000);

  it("a syntax error comes back as a compile diagnostic", async () => {
    writeFileSync(created, readFileSync(created, "utf8").replace("\t;", "\t#Nope := 1;"));
    out.length = 0;
    await main(["sync"], io);
    console.log(out.join(""));
    expect(out.join("")).toMatch(/error|IMPORT_FAILED|COMPILE/);
    // the diagnostic points at the #Nope line of the canonical file TIA wrote back
    const nopeLine = readFileSync(created, "utf8").split(/\r?\n/).findIndex((l) => l.includes("#Nope")) + 1;
    expect(out.join("")).toContain(`Fx_E2E.scl:${nopeLine} `);
  }, 600_000);

  it("deleting the file asks for confirmation; confirm-delete removes the block", async () => {
    unlinkSync(created);
    out.length = 0;
    await main(["sync"], io);
    expect(out.join("")).toMatch(/DELETE_PENDING/);
    expect(await main(["confirm-delete", "plc:PLC_1/blocks/30_E2E/Fx_E2E", "--dir", dir], io)).toBe(0);
  }, 600_000);

  it("a sync stopped right after TIA Portal committed its import: the next one sends the newer edit, no conflict", async () => {
    const file = join(dir, "plc", "PLC_1", "blocks", "30_E2E", "Fx_E2E_Stop.scl");
    const src = (n: number) => `FUNCTION "Fx_E2E_Stop" : Void\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\n   VAR_TEMP \n      l1 : Int;\n   END_VAR\n\n\nBEGIN\n\t#l1 := ${n};\nEND_FUNCTION\n`;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, src(1));
    await main(["sync"], io);
    writeFileSync(file, src(2));
    process.env.RUNG_BRIDGE_TEST_STOP = "after-commit";
    try {
      await main(["sync"], io); // the bridge stops after TIA Portal took #l1 := 2: rung never hears the answer
    } finally {
      delete process.env.RUNG_BRIDGE_TEST_STOP;
    }
    writeFileSync(file, readFileSync(file, "utf8").replace(/#l1 := \d+;/, "#l1 := 3;"));
    out.length = 0;
    expect([0, 2]).toContain(await main(["sync"], io));
    expect(out.join("")).not.toMatch(/CONFLICT/);
    // sent as an import, or merged with TIA Portal's layout of what the stopped sync sent
    expect(out.join("")).toMatch(/imported 1|merged 1/);
    out.length = 0;
    await main(["sync"], io);
    expect(out.join("")).toMatch(/exported 0 +imported 0 /);
    expect(readFileSync(file, "utf8")).toContain("#l1 := 3;");
    unlinkSync(file);
    await main(["sync"], io);
    expect(await main(["confirm-delete", "plc:PLC_1/blocks/30_E2E/Fx_E2E_Stop", "--dir", dir], io)).toBe(0);
  }, 600_000);

  it("a software unit is a folder: a new file there creates the block in the unit, an edit goes there, a delete too", async () => {
    const inUnit = join(dir, "plc", "PLC_1", "units", "Fx_Unit", "blocks", "30_E2E", "Fx_E2E_Unit.scl");
    // a run that stopped half way left the block in TIA Portal (the pull brought it here): take it out first
    if (existsSync(inUnit)) {
      unlinkSync(inUnit);
      await main(["sync"], io);
      await main(["confirm-delete", "plc:PLC_1/units/Fx_Unit/blocks/30_E2E/Fx_E2E_Unit", "--force", "--dir", dir], io);
    }
    mkdirSync(join(inUnit, ".."), { recursive: true });
    writeFileSync(inUnit, 'FUNCTION "Fx_E2E_Unit" : Void\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\n   VAR_INPUT\n      A : Bool;\n   END_VAR\n\nBEGIN\n\t;\nEND_FUNCTION\n');
    out.length = 0;
    await main(["sync"], io);
    expect(out.join("")).toMatch(/created 1/);
    expect(out.join("")).not.toMatch(/UNSUPPORTED_UNIT|BAD_ADDRESS/);
    writeFileSync(inUnit, readFileSync(inUnit, "utf8").replace("\t;", "\t; // in the unit"));
    out.length = 0;
    await main(["sync"], io);
    expect(out.join("")).toMatch(/imported 1/);
    expect(readFileSync(inUnit, "utf8")).toContain("// in the unit");
    unlinkSync(inUnit);
    out.length = 0;
    await main(["sync"], io);
    expect(out.join("")).toMatch(/DELETE_PENDING/);
    expect(await main(["confirm-delete", "plc:PLC_1/units/Fx_Unit/blocks/30_E2E/Fx_E2E_Unit", "--dir", dir], io)).toBe(0);
  }, 600_000);
});
