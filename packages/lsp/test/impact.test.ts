// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, interfaceImpact } from "../src/index.js";

const B = "file:///w/plc/P/blocks/";
const valve = (inputs: string) => `FUNCTION_BLOCK "Fb_Valve"
VAR_INPUT
${inputs}
END_VAR
VAR
  count : Int;
END_VAR
BEGIN
  ;
END_FUNCTION_BLOCK
`;
const BEFORE = valve("  open : Bool;\n  speed : Int;");
const PUMP = `FUNCTION_BLOCK "Fb_Pump"
VAR
  valve : "Fb_Valve";
END_VAR
BEGIN
  #valve(open := TRUE, speed := 3);
END_FUNCTION_BLOCK
`;
const MAIN = `ORGANIZATION_BLOCK "Main"
BEGIN
  "Valve_DB"(open := FALSE);
  "Scale"(raw := 1, factor := 2.0);
END_ORGANIZATION_BLOCK
`;
const SCALE = (params: string) => `FUNCTION "Scale" : Real
VAR_INPUT
${params}
END_VAR
BEGIN
  #Scale := 0.0;
END_FUNCTION
`;

function idx(valveNow: string, scaleNow = SCALE("  raw : Int;\n  factor : Real;")) {
  const i = new WorkspaceIndex();
  i.set(B + "Fb_Valve.scl", valveNow, 0);
  i.set(B + "Fb_Pump.scl", PUMP, 0);
  i.set(B + "Main.scl", MAIN, 0);
  i.set(B + "Scale.scl", scaleNow, 0);
  i.set(B + "Valve_DB.db", 'DATA_BLOCK "Valve_DB"\n"Fb_Valve"\nBEGIN\nEND_DATA_BLOCK\n', 0);
  i.set(B + "Pump_DB.db", 'DATA_BLOCK "Pump_DB"\n"Fb_Pump"\nBEGIN\nEND_DATA_BLOCK\n', 0);
  return i;
}

describe("interface impact", () => {
  it("a removed input: the calls that pass it, the instance DBs down the multi-instance chain, the tests naming it", () => {
    const i = idx(valve("  open : Bool;"));
    const tests = [
      { uri: "file:///w/tests/valve.test.yaml", text: "block: Fb_Valve\ncases:\n  - name: a\n    steps:\n      - set: { open: true, speed: 4 }\n        expect: { '#count': 0 }\n" },
      { uri: "file:///w/tests/other.test.yaml", text: "block: Main\ncases:\n  - steps:\n      - expect: { x: 1 }\n" },
    ];
    const r = interfaceImpact(i, B + "Fb_Valve.scl", BEFORE, tests)!;
    expect(r.changes).toEqual([{ kind: "removed", section: "Input", name: "speed", before: "Int" }]);
    expect(r.reinit).toBe(true);
    expect(r.calls.map((c) => [c.block, c.line, c.problems])).toEqual(
      expect.arrayContaining([
        ["Fb_Pump", 6, ["passes speed, which Fb_Valve no longer has"]],
        ["Main", 3, []],
      ]),
    );
    expect(r.instances.map((x) => x.name).sort()).toEqual(["Fb_Pump.valve", "Pump_DB", "Valve_DB"]);
    expect(r.tests).toEqual([{ block: "Fb_Valve", uri: tests[0]!.uri, line: 1, problems: ["case 1 sets speed, which Fb_Valve no longer has"] }]);
  });

  it("a rename is told as one, and only a temp change affects nothing", () => {
    const r = interfaceImpact(idx(valve("  open : Bool;\n  rate : Int;")), B + "Fb_Valve.scl", BEFORE)!;
    expect(r.changes).toEqual([{ kind: "renamed", section: "Input", name: "speed", to: "rate", after: "Int" }]);
    expect(r.calls.find((c) => c.block === "Fb_Pump")!.problems).toEqual(["passes speed, now rate"]);
    const temp = BEFORE.replace("BEGIN", "VAR_TEMP\n  t : Int;\nEND_VAR\nBEGIN");
    const none = interfaceImpact(idx(temp), B + "Fb_Valve.scl", BEFORE)!;
    expect(none).toMatchObject({ changes: [], reinit: false, calls: [], instances: [] });
  });

  it("statics in another order change the instance layout", () => {
    const fb = (statics: string) => `FUNCTION_BLOCK "Fb_Order"\nVAR\n${statics}\nEND_VAR\nBEGIN\n  ;\nEND_FUNCTION_BLOCK\n`;
    const i = new WorkspaceIndex();
    i.set(B + "Fb_Order.scl", fb("  b : Bool;\n  a : Int;"), 0);
    const r = interfaceImpact(i, B + "Fb_Order.scl", fb("  a : Int;\n  b : Bool;"))!;
    expect(r.changes).toEqual([{ kind: "reordered", section: "Static", name: "b, a" }]);
    expect(r.reinit).toBe(true);
  });

  it("a data type held inside a STRUCT of an FB: that FB's instance DBs start over", () => {
    const udt = (members: string) => `TYPE "T_Pos"\nSTRUCT\n${members}\nEND_STRUCT;\nEND_TYPE\n`;
    const i = new WorkspaceIndex();
    i.set(B + "T_Pos.udt", udt("  x : Int;\n  y : Int;"), 0);
    i.set(B + "Fb_Axis.scl", 'FUNCTION_BLOCK "Fb_Axis"\nVAR\n  data : Struct\n    pos : "T_Pos";\n  END_STRUCT;\nEND_VAR\nBEGIN\n  ;\nEND_FUNCTION_BLOCK\n', 0);
    i.set(B + "Axis_DB.db", 'DATA_BLOCK "Axis_DB"\n"Fb_Axis"\nBEGIN\nEND_DATA_BLOCK\n', 0);
    const r = interfaceImpact(i, B + "T_Pos.udt", udt("  x : Int;"))!;
    expect(r.instances.map((x) => x.name).sort()).toEqual(["Axis_DB", "Fb_Axis.data.pos"]);
  });

  it("a test of another PLC's block of the same name is not this block's", () => {
    const i = idx(valve("  open : Bool;"));
    const tests = [
      { uri: "file:///w/tests/p2.test.yaml", text: "block: Fb_Valve\nplc: P2\ncases:\n  - steps:\n      - set: { speed: 4 }\n" },
      { uri: "file:///w/tests/p.test.yaml", text: "block: Fb_Valve\nplc: P\ncases:\n  - steps:\n      - set: { speed: 4 }\n" },
    ];
    const r = interfaceImpact(i, B + "Fb_Valve.scl", BEFORE, tests)!;
    expect(r.tests.map((t) => t.uri)).toEqual(["file:///w/tests/p.test.yaml"]);
  });

  it("an FC: a new input every call must pass, a new type, no instance data", () => {
    const now = SCALE("  raw : DInt;\n  factor : Real;\n  offset : Real;");
    const r = interfaceImpact(idx(BEFORE, now), B + "Scale.scl", SCALE("  raw : Int;\n  factor : Real;"))!;
    expect(r.changes).toEqual([
      { kind: "retyped", section: "Input", name: "raw", before: "Int", after: "DInt" },
      { kind: "added", section: "Input", name: "offset", after: "Real" },
    ]);
    expect(r.reinit).toBe(false);
    expect(r.calls).toEqual([{ block: "Main", uri: B + "Main.scl", line: 4, problems: ["passes raw, now DInt (was Int)", "does not pass offset (input), new"] }]);
  });
});
