// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex } from "@rung/lsp";
import { DebugSession, runTestFile } from "../src/index.js";

const scl = readFileSync(fileURLToPath(new URL("../../../examples/conveyor/blocks/FB_Conveyor.scl", import.meta.url)), "utf8");
const idx = () => {
  const i = new WorkspaceIndex();
  i.set("file:///w/blocks/FB_Conveyor.scl", scl, 0);
  return i;
};
const run = (steps: string) =>
  runTestFile(idx(), "t.yaml", `block: FB_Conveyor\ncycle: 10ms\ncases:\n  - name: c\n    steps:\n      - set: { Stop: true, EStopOk: true, Start: true }\n      - cycle: 1\n      - set: { Start: false }\n${steps}`);

describe("temporal expectations: within, always, never", () => {
  it("pass when the machine keeps its promises", async () => {
    const r = await run(["      - { never: 1900ms, expect: { Fault: true } }", "      - { within: 500ms, expect: { Fault: true } }", "      - { always: 1s, expect: { Motor: false } }", ""].join("\n"));
    expect(r.cases[0]).toMatchObject({ passed: true, failures: [] });
  });

  it("say when and how a promise broke", async () => {
    const r1 = await run("      - { within: 1s, expect: { Fault: true } }\n");
    expect(r1.cases[0]!.failures).toEqual([{ step: 4, name: "Fault", expected: true, actual: false, note: "within 1s: not reached", line: 9 }]);
    const r2 = await run("      - { always: 3s, expect: { Motor: true } }\n");
    expect(r2.cases[0]!.failures[0]).toMatchObject({ name: "Motor", expected: true, actual: false, note: "always for 3s: broken after 2.01 s" });
    const r3 = await run("      - { never: 3s, expect: { Fault: true } }\n");
    expect(r3.cases[0]!.failures[0]).toMatchObject({ name: "Fault", expected: "not true", actual: true, note: "never for 3s: it was, after 2.01 s" });
  });

  it("the debugger stops at the cycle a promise broke", async () => {
    const yaml = "block: FB_Conveyor\ncycle: 10ms\ncases:\n  - name: c\n    steps:\n      - set: { Stop: true, EStopOk: true, Start: true }\n      - cycle: 1\n      - set: { Start: false }\n      - { always: 3s, expect: { Motor: true } }\n";
    const d = new DebugSession(idx(), "t.yaml", yaml, 0);
    const s = await d.start(false);
    expect(s).toMatchObject({ kind: "stopped", reason: "exception", time: 2020, text: expect.stringContaining("always for 3s: broken after 2.01 s") });
    expect(d.evaluate("#Motor").value).toBe("FALSE");
  });

  it("refuses a temporal step without expect:, or with two of them", async () => {
    expect((await run("      - within: 1s\n")).cases[0]!.error).toMatch(/within: name what to check with expect:/);
    expect((await run("      - { within: 1s, always: 1s, expect: { Fault: true } }\n")).cases[0]!.error).toMatch(/one of within, always and never/);
    expect((await run("      - { within: 5, expect: { Fault: true } }\n")).cases[0]!.error).toMatch(/^within: write a unit/);
    // 0 ms: the state as it is now, no cycle run
    expect((await run("      - { always: 0ms, expect: { Fault: false } }\n")).cases[0]!.passed).toBe(true);
    expect((await run("      - { within: 0ms, expect: { Fault: true } }\n")).cases[0]!.failures[0]!.note).toBe("within 0ms: not reached");
  });
});
