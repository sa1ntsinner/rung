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

describe("rung test --case", () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    const code = await main(["test", ...args], { cwd: conveyor, stdout: (s) => out.push(s), stderr: (s) => out.push(s), env: {} });
    return { code, out: out.join("") };
  };
  it("runs one case by its file and place, and says it in --json with the case's index", async () => {
    const { code, out } = await run(["--case", "tests/conveyor.test.yaml#2", "--json"]);
    expect(code).toBe(0);
    const r = JSON.parse(out) as { files: { cases: { name: string; index: number }[] }[] };
    expect(r.files[0]!.cases.map((c) => [c.index, c.name])).toEqual([[2, "a contactor that does not answer within 2 s is a fault until reset"]]);
  });
  it("refuses a selector that names no case, and --case with --filter", async () => {
    expect((await run(["--case", "tests/conveyor.test.yaml#9"])).out).toMatch(/has 5 cases/);
    expect((await run(["--case", "tests/conveyor.test.yaml"])).code).toBe(1);
    expect((await run(["--case", "tests/conveyor.test.yaml#1", "--filter", "x"])).out).toMatch(/--case or --filter/);
  });
});

describe("rung test --coverage", () => {
  it("writes which SCL lines the cases ran as lcov and says how much ran", async () => {
    const out: string[] = [];
    const lcov = join(mkdtempSync(join(tmpdir(), "rung-cov-")), "lcov.info");
    const code = await main(["test", "--coverage", lcov], { cwd: conveyor, stdout: (s) => out.push(s), stderr: (s) => out.push(s), env: {} });
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/coverage: \d+% of SCL lines \(\d+\/\d+ in \d+ files\)/);
    const text = readFileSync(lcov, "utf8");
    expect(text).toMatch(/^SF:blocks\/FB_Conveyor\.scl\nDA:\d+,[1-9]/m);
    expect(text.trimEnd().endsWith("end_of_record")).toBe(true);
  });
});
