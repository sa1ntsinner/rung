// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex } from "@rung/lsp";
import { Simulator, SimError, type Instance } from "../src/runtime.js";

const fx = (f: string) => readFileSync(fileURLToPath(new URL(`../../../tools/fixtures/scl/${f}`, import.meta.url)), "utf8");

function sim(extra: Record<string, string> = {}) {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/plc/P/blocks/Fx_Motor.scl", fx("Fx_Motor.scl"), 0);
  idx.set("file:///w/plc/P/blocks/Fx_Valve.scl", fx("Fx_Valve.scl"), 0);
  idx.set("file:///w/plc/P/blocks/Fx_Counter.scl", fx("Fx_Counter.scl"), 0);
  idx.set("file:///w/plc/P/types/Fx_Types.udt", fx("Fx_Types.udt"), 0);
  idx.set("file:///w/plc/P/blocks/Fx_Global.db", fx("Fx_Global.db"), 0);
  for (const [k, v] of Object.entries(extra)) idx.set(`file:///w/plc/P/blocks/${k}.scl`, v, 0);
  return new Simulator(idx);
}

describe("Simulator", () => {
  it("runs the Fx_Motor latch and speed limit", () => {
    const s = sim();
    const m = s.newInstance("Fx_Motor");
    s.callBlock(m, { Start: true, SpeedSetpoint: 5000 });
    expect(m.mem.RUNNING).toBe(true);
    expect(m.mem.SPEEDOUT).toBe(3000); // LIMIT(0, 5000, 3000)
    s.callBlock(m, { Start: false });
    expect(m.mem.RUNNING).toBe(true); // latched
    s.callBlock(m, { Stop: true });
    expect([m.mem.RUNNING, m.mem.SPEEDOUT]).toEqual([false, 0]);
  });

  it("runs an FC with CASE and returns outputs", () => {
    const s = sim();
    expect(s.callBlock("Fx_Valve", { Enable: true, Mode: 1 }).outputs.OPEN).toBe(true);
    expect(s.callBlock("Fx_Valve", { Enable: true, Mode: 0 }).outputs.OPEN).toBe(false);
    expect(s.callBlock("Fx_Valve", { Enable: true, Mode: 7 }).outputs.OPEN).toBe(false);
  });

  it("drives a TON multi-instance with virtual time (Fx_Counter debounce)", () => {
    const s = sim();
    const c = s.newInstance("Fx_Counter");
    for (let t = 0; t <= 30; t += 10) {
      s.time = t;
      s.callBlock(c, { Pulse: true });
    }
    expect(c.mem.COUNT).toBe(1);
    expect(c.mem.ELAPSED).toBe(20); // ET clamps at PT
    s.time = 40;
    s.callBlock(c, { Pulse: false });
    s.time = 50;
    s.callBlock(c, { Reset: true });
    expect(c.mem.COUNT).toBe(0);
  });

  it("initializes UDT-typed DB members and start values", () => {
    const s = sim({ Fx_Use: 'FUNCTION "Fx_Use" : DInt\nBEGIN\n  "Fx_Global".Counter := "Fx_Global".Counter + 5;\n  "Fx_Global".Station.Mode := 2;\n  #Fx_Use := "Fx_Global".Counter;\nEND_FUNCTION\n' });
    expect(s.callBlock("Fx_Use").returnValue).toBe(5);
    expect(s.callBlock("Fx_Use").returnValue).toBe(10);
    expect(((s.globals.FX_GLOBAL as { STATION: { MODE: number } }).STATION.MODE)).toBe(2);
  });

  it("does integer division for integers and real division otherwise, loops with EXIT", () => {
    const src = 'FUNCTION "F" : Real\nVAR_TEMP\n  i : Int;\n  a : Array[0..4] of Int;\n  sum : Int;\n  q : Int;\nEND_VAR\nBEGIN\n  #q := 7 / 2;\n  FOR #i := 0 TO 4 DO\n    #a[#i] := #i * #i;\n    IF #i = 3 THEN EXIT; END_IF;\n  END_FOR;\n  #sum := #a[0] + #a[1] + #a[2] + #a[3] + #a[4];\n  #F := #sum + #q + 7.0 / 2;\nEND_FUNCTION\n';
    expect(sim({ F: src }).callBlock("F").returnValue).toBe(14 + 3 + 3.5);
  });

  it("reports runtime errors with the block and a useful message", () => {
    const s = sim({ Bad: 'FUNCTION "Bad" : Void\nVAR_TEMP\n  a : Array[0..2] of Int;\n  i : Int;\nEND_VAR\nBEGIN\n  #i := 5;\n  #a[#i] := 1;\nEND_FUNCTION\n' });
    expect(() => s.callBlock("Bad")).toThrow(/array index 5 out of range 0..2/);
    const loop = sim({ Loop: 'FUNCTION "Loop" : Void\nBEGIN\n  WHILE TRUE DO ; END_WHILE;\nEND_FUNCTION\n' });
    expect(() => loop.callBlock("Loop")).toThrow(SimError);
  });

  it("simulates standard counters and edges", () => {
    const s = sim({
      Cnt: 'FUNCTION_BLOCK "Cnt"\nVAR_INPUT\n  x : Bool;\nEND_VAR\nVAR_OUTPUT\n  n : Int;\n  edge : Bool;\nEND_VAR\nVAR\n  c : CTU;\n  r : R_TRIG;\nEND_VAR\nBEGIN\n  #c(CU := #x, R := FALSE, PV := 3);\n  #r(CLK := #x, Q => #edge);\n  #n := #c.CV;\nEND_FUNCTION_BLOCK\n',
    });
    const i = s.newInstance("Cnt") as Instance;
    const seq = [true, true, false, true, false, true];
    const edges = seq.map((x) => (s.callBlock(i, { x }), i.mem.EDGE));
    expect(edges).toEqual([true, false, false, true, false, true]);
    expect(i.mem.N).toBe(3);
  });
});
