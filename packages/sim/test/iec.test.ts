// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, diagnostics } from "@rung/lsp";
import { runTestFile, Simulator, type Instance } from "../src/index.js";

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

  it("runs S=/R= assignments, nested comments, AT %I* variables and GVL-constant array bounds", () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/GVL_C.st", "VAR_GLOBAL CONSTANT\n  MAX : INT := 3;\nEND_VAR\nVAR_GLOBAL\n  aItems : ARRAY[0..GVL_C.MAX - 1] OF INT;\nEND_VAR\n", 0);
    idx.set("file:///w/FB_Set.st", "FUNCTION_BLOCK FB_Set\nVAR_INPUT\n  bSet : BOOL;\n  bReset : BOOL;\nEND_VAR\nVAR\n  bLatch : BOOL;\n  bIn AT %I* : BOOL;\n  a : ARRAY[1..GVL_C.MAX] OF INT;\n  n : INT;\nEND_VAR\n(* outer (* nested *) still comment *)\nbLatch S= bSet;\nbLatch R= bReset;\na[GVL_C.MAX] := 5;\nGVL_C.aItems[2] := 1;\nn := a[3] + GVL_C.aItems[2];\nEND_FUNCTION_BLOCK\n", 0);
    const s = new Simulator(idx);
    const i = s.newInstance("FB_Set");
    s.callBlock(i, { bSet: true });
    expect([i.mem.BLATCH, i.mem.N]).toEqual([true, 6]);
    s.callBlock(i, { bSet: false });
    expect(i.mem.BLATCH).toBe(true);
    s.callBlock(i, { bReset: true });
    expect(i.mem.BLATCH).toBe(false);
  });

  it("runs a state machine on an enumeration: qualified, typed and bare values, defaults, CASE labels", () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/E_State.st", "TYPE E_State :\n(\n  Idle := 0,\n  Running := 10,\n  Stopping,\n  Fault := 16#FF\n) INT := Idle;\nEND_TYPE\n", 0);
    idx.set("file:///w/E_Mode.st", "TYPE E_Mode : (Auto, Manual) := Manual;\nEND_TYPE\n", 0);
    idx.set(
      "file:///w/FB_Seq.st",
      "FUNCTION_BLOCK FB_Seq\nVAR_INPUT\n  bStart : BOOL;\n  bStop : BOOL;\nEND_VAR\nVAR\n  eState : E_State;\n  eMode : E_Mode;\n  nState : INT;\nEND_VAR\nCASE eState OF\n  E_State.Idle: IF bStart THEN eState := E_State#Running; END_IF\n  E_State.Running: IF bStop THEN eState := Stopping; END_IF\n  E_State.Stopping: eState := E_State.Idle;\nEND_CASE\nnState := eState;\nEND_FUNCTION_BLOCK\n",
      0,
    );
    const s = new Simulator(idx);
    const i = s.newInstance("FB_Seq");
    expect([i.mem.ESTATE, i.mem.EMODE]).toEqual([0, 1]);
    s.callBlock(i, { bStart: true });
    expect(i.mem.NSTATE).toBe(10);
    s.callBlock(i, { bStart: false, bStop: true });
    expect(i.mem.NSTATE).toBe(11);
    s.callBlock(i, { bStop: false });
    expect(i.mem.NSTATE).toBe(0);
  });

  it("runs METHODs with THIS^, pointers and references", () => {
    const idx = new WorkspaceIndex();
    idx.set(
      "file:///w/FB_Axis.st",
      [
        "FUNCTION_BLOCK FB_Axis",
        "VAR_OUTPUT",
        "  nMoves : INT;",
        "  fPos : REAL;",
        "END_VAR",
        "VAR",
        "  nCount : INT;",
        "  pCount : POINTER TO INT;",
        "  rPos : REFERENCE TO REAL;",
        "  bBound : BOOL;",
        "END_VAR",
        "pCount := ADR(nCount);",
        "pCount^ := pCount^ + 1;",
        "rPos REF= fPos;",
        "bBound := __ISVALIDREF(rPos);",
        "END_FUNCTION_BLOCK",
        "METHOD MoveTo : BOOL",
        "VAR_INPUT",
        "  fTarget : REAL;",
        "END_VAR",
        "VAR",
        "  nCount : INT; // a local that hides the FB's nCount",
        "END_VAR",
        "nCount := 100;",
        "THIS^.nMoves := THIS^.nMoves + 1;",
        "rPos := fTarget;",
        "MoveTo := Home() OR fTarget > 0;",
        "END_METHOD",
        "METHOD Home : BOOL",
        "Home := nMoves > 1;",
        "END_METHOD",
        "",
      ].join("\n"),
      0,
    );
    idx.set("file:///w/PRG_Main.st", "PROGRAM PRG_Main\nVAR\n  fbAxis : FB_Axis;\n  bOk : BOOL;\nEND_VAR\nfbAxis();\nbOk := fbAxis.MoveTo(fTarget := 12.5);\nEND_PROGRAM\n", 0);
    const s = new Simulator(idx);
    const main = s.newInstance("PRG_Main");
    s.runInstance(main);
    const axis = (main.mem.FBAXIS as Instance).mem;
    expect([axis.NCOUNT, axis.NMOVES, axis.FPOS, axis.BBOUND, main.mem.BOK]).toEqual([1, 1, 12.5, true, true]);
    s.runInstance(main);
    expect([axis.NCOUNT, axis.NMOVES, axis.FPOS]).toEqual([2, 2, 12.5]);
    const text = idx.docs.get("file:///w/FB_Axis.st")!.text;
    expect(diagnostics(idx, "file:///w/FB_Axis.st").map((d) => `${d.code}: ${text.slice(d.start, d.end)}`)).toEqual([]);
  });

  it("calls functions from TwinCAT .TcPOU files", () => {
    const sim = new Simulator(index());
    expect(sim.callBlock("FC_Scale", { fIn: 4 }).returnValue).toBe(10);
  });
});
