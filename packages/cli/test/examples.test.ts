// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.js";

const conveyor = fileURLToPath(new URL("../../../examples/conveyor", import.meta.url));

async function test(cwd: string): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await main(["test"], { cwd, stdout: (s) => out.push(s), stderr: (s) => out.push(s), env: {} });
  return { code, out: out.join("") };
}

describe("examples/conveyor", () => {
  it("passes as shipped", async () => {
    const { code, out } = await test(conveyor);
    expect(out).toContain("5/5 passed");
    expect(code).toBe(0);
  });

  it("fails as its README says once the fault no longer stops the motor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rung-example-"));
    cpSync(conveyor, dir, { recursive: true });
    const scl = join(dir, "blocks", "FB_Conveyor.scl");
    const text = readFileSync(scl, "utf8");
    expect(text).toContain("OR #Fault OR");
    writeFileSync(scl, text.replace("OR #Fault OR", "OR"));
    const { code, out } = await test(dir);
    expect(out).toContain("step 7: Motor expected false got true");
    expect(readFileSync(join(conveyor, "README.md"), "utf8")).toContain("step 7: Motor expected false got true");
    expect(code).not.toBe(0);
  });
});
