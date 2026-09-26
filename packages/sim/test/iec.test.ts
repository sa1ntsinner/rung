// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile, Simulator } from "../src/index.js";

const BLINK = `FUNCTION_BLOCK FB_Blink
VAR_INPUT
  bEnable : BOOL;
END_VAR
VAR_OUTPUT
  bOut : BOOL;
END_VAR
VAR
  tonOn : TON;
  nCount : INT;
END_VAR
tonOn(IN := bEnable AND NOT tonOn.Q, PT := T#100MS);
IF tonOn.Q THEN
  bOut := NOT bOut;
  nCount := nCount + 1;
  GVL_Io.nToggles := GVL_Io.nToggles + 1;
  nLast := nCount;
END_IF
END_FUNCTION_BLOCK
`;
const GVL = `VAR_GLOBAL
  nToggles : INT;
  nLast : INT;
END_VAR
`;
const MAIN = `PROGRAM MAIN
VAR
  fbBlink : FB_Blink;
  nScans : DINT;
END_VAR
nScans := nScans + 1;
fbBlink(bEnable := TRUE);
END_PROGRAM
`;
const TCPOU = `<?xml version="1.0" encoding="utf-8"?>
<TcPlcObject Version="1.1.0.1">
  <POU Name="FC_Scale" Id="{00000000-0000-4000-8000-000000000001}" SpecialFunc="None">
    <Declaration><![CDATA[FUNCTION FC_Scale : REAL
VAR_INPUT
  fIn : REAL;
END_VAR]]></Declaration>
    <Implementation>
      <ST><![CDATA[FC_Scale := fIn * 2.5;]]></ST>
    </Implementation>
  </POU>
</TcPlcObject>
`;

function index() {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/FB_Blink.st", BLINK, 0);
  idx.set("file:///w/GVL_Io.st", GVL, 0);
  idx.set("file:///w/MAIN.st", MAIN, 0);
  idx.set("file:///w/FC_Scale.TcPOU", TCPOU, 0);
  return idx;
}

describe("IEC 61131-3 / TwinCAT simulation", () => {
  it("runs FBs with bare identifiers, standard FB instances and GVL variables", async () => {
    const r = await runTestFile(index(), "blink.test.yaml", `
block: FB_Blink
cycle: 10ms
cases:
  - name: toggles every 100 ms
    steps:
      - set: { bEnable: true }
      - advance: 110ms # TON starts on the first cycle (t=10) and elapses at t=110
      - expect: { bOut: true, nCount: 1, GVL_Io.nToggles: 1, nLast: 1 }
      - advance: 120ms # reset on the next scan, restarted at t=130
      - expect: { bOut: false, nCount: 2, GVL_Io.nToggles: 2 }
`);
    expect(r.error).toBeUndefined();
    expect(r.cases.map((c) => [c.passed, c.error, c.failures])).toEqual([[true, undefined, []]]);
  });

  it("keeps PROGRAM memory between cycles", async () => {
    const r = await runTestFile(index(), "main.test.yaml", `
block: MAIN
cases:
  - steps:
      - cycle: 3
      - expect: { nScans: 3, fbBlink.bEnable: true }
`);
    expect(r.cases.map((c) => [c.passed, c.error, c.failures])).toEqual([[true, undefined, []]]);
  });

  it("calls functions from TwinCAT .TcPOU files", () => {
    const sim = new Simulator(index());
    expect(sim.callBlock("FC_Scale", { fIn: 4 }).returnValue).toBe(10);
  });
});
