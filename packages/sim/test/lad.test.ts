// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile } from "../src/index.js";

// the canonical LAD block TIA Portal V20 wrote back (see packages/lsp/test/sd)
const PUMP = readFileSync(fileURLToPath(new URL("../../lsp/test/sd/FB_Pump.s7dcl", import.meta.url)), "utf8");

function index() {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/plc/PLC_1/blocks/30_Lad/FB_Pump.s7dcl", PUMP, 0);
  return idx;
}

describe("rung test on LAD blocks", () => {
  it("runs the ladder: branch latch, TON delay, comparison and set/reset coils", async () => {
    const r = await runTestFile(index(), "pump.test.yaml", `
block: FB_Pump
cycle: 10ms
cases:
  - name: latches, delays ready, stops
    steps:
      - set: { Start: true }
      - cycle: 1
      - expect: { Run: true, Ready: false }
      - set: { Start: false }
      - cycle: 1
      - expect: { Run: true }
      - advance: 3010ms
      - expect: { Ready: true }
      - set: { Stop: true }
      - cycle: 1
      - expect: { Run: false, Ready: false }
  - name: high pressure and a fault alarm that stays until the next start
    steps:
      - set: { Pressure: 7.0, Fault: true, Start: true }
      - cycle: 1
      - expect: { HighPressure: true, Alarm: true, Run: false }
      - set: { Fault: false, Start: false }
      - cycle: 1
      - expect: { Alarm: true }
      - set: { Start: true, Pressure: 5.0 }
      - cycle: 1
      - expect: { Alarm: false, Run: true, HighPressure: false }
`);
    expect(r.error).toBeUndefined();
    expect(r.cases.map((c) => [c.name, c.passed, c.error, c.failures])).toEqual([
      ["latches, delays ready, stops", true, undefined, []],
      ["high pressure and a fault alarm that stays until the next start", true, undefined, []],
    ]);
  });

  it("refuses a LAD block with elements it cannot run, naming them", async () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/FB_Edge.s7dcl", '{\n    S7_Language := "LAD";\n}\nFUNCTION_BLOCK "FB_Edge"\n    VAR_INPUT\n        a : Bool;\n    END_VAR\n    VAR\n        m : Bool;\n        q : Bool;\n    END_VAR\n    {\n      S7_Language := "LAD"\n    }\n    NETWORK\n        RUNG wire#powerrail\n            P_Contact( #a, #m )\n            Coil( #q )\n        END_RUNG\n    END_NETWORK\nEND_FUNCTION_BLOCK\n', 0);
    const r = await runTestFile(idx, "edge.test.yaml", "block: FB_Edge\ncases:\n  - steps:\n      - cycle: 1\n");
    expect(JSON.stringify(r)).toMatch(/LAD elements the simulator does not run yet: P_Contact\( #a, #m \)/);
  });
});
