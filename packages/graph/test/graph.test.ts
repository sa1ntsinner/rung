// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { CodeGraph } from "../src/index.js";

function build() {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/plc/P/types/Fx_Types.udt", 'TYPE "Fx_Types"\nSTRUCT\n  Enabled : Bool;\n  Setpoint : Real;\nEND_STRUCT;\nEND_TYPE\n', 0);
  idx.set("file:///w/plc/P/blocks/Fx_Global.db", 'DATA_BLOCK "Fx_Global"\nVAR\n  Station : "Fx_Types";\n  Counter : DInt;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n', 0);
  idx.set("file:///w/plc/P/blocks/Fx_Motor.scl", 'FUNCTION_BLOCK "Fx_Motor"\nVAR_INPUT\n  Start : Bool;\nEND_VAR\nVAR\n  t : TON;\nEND_VAR\nBEGIN\n  #t(IN := #Start, PT := T#1s);\n  "Fx_Global".Counter := "Fx_Global".Counter + 1;\n  "Fx_Limit"(x := "Fx_Global".Station.Setpoint);\nEND_FUNCTION_BLOCK\n', 0);
  idx.set("file:///w/plc/P/blocks/Fx_Limit.scl", 'FUNCTION "Fx_Limit" : Void\nVAR_INPUT\n  x : Real;\nEND_VAR\nBEGIN\n  #x := LIMIT(MN := 0.0, IN := #x, MX := 1.0);\nEND_FUNCTION\n', 0);
  idx.set("file:///w/plc/P/blocks/Fx_Motor_DB.db", 'DATA_BLOCK "Fx_Motor_DB"\n"Fx_Motor"\nBEGIN\nEND_DATA_BLOCK\n', 0);
  idx.set("file:///w/plc/P/blocks/Main.scl", 'ORGANIZATION_BLOCK "Main"\nBEGIN\n  "Fx_Motor_DB"(Start := "Start_Button");\n  "Fx_Global".Station.Enabled := TRUE;\nEND_ORGANIZATION_BLOCK\n', 0);
  idx.set(
    "file:///w/plc/P/tags/T.tags.xml",
    '<SW.Tags.PlcTagTable><AttributeList><Name>T</Name></AttributeList><SW.Tags.PlcTag ID="1"><AttributeList><DataTypeName>Bool</DataTypeName><Name>Start_Button</Name></AttributeList></SW.Tags.PlcTag></SW.Tags.PlcTagTable>',
    0,
  );
  return CodeGraph.fromIndex(idx);
}

describe("CodeGraph", () => {
  const g = build();

  it("derives calls through instance DBs, local instances and functions", () => {
    expect(g.callers("Fx_Motor").map((n) => n.name)).toEqual(["Main"]);
    expect(g.callees("Fx_Motor").map((n) => n.name).sort()).toEqual(["Fx_Limit", "TON"]);
    expect(g.callees("Fx_Limit").map((n) => [n.name, n.kind])).toEqual([["LIMIT", "STANDARD"]]);
  });

  it("records instance and type relations", () => {
    expect(g.outgoing("Fx_Motor_DB").map((e) => [e.kind, e.to])).toEqual([["instanceOf", "FX_MOTOR"]]);
    expect(g.outgoing("Fx_Global").map((e) => [e.kind, e.to])).toEqual([["usesType", "FX_TYPES"]]);
    expect(g.outgoing("Fx_Motor", ["instantiates"]).map((e) => e.to)).toEqual(["TON"]);
  });

  it("tracks reads and writes with the members touched", () => {
    const u = g.usages("Fx_Global");
    expect(u.find((x) => x.node.name === "Fx_Motor" && x.kind === "writes")).toMatchObject({ members: ["Counter"] });
    expect(u.find((x) => x.node.name === "Fx_Motor" && x.kind === "reads")).toMatchObject({ members: ["Counter", "Station.Setpoint"] });
    expect(u.find((x) => x.node.name === "Main" && x.kind === "writes")).toMatchObject({ members: ["Station.Enabled"] });
    expect(g.usages("Start_Button").map((x) => [x.node.name, x.kind])).toEqual([["Main", "reads"]]);
  });

  it("computes transitive impact", () => {
    const impact = g.impact("Fx_Types").map((i) => [i.node.name, i.distance]);
    expect(impact).toEqual([["Fx_Global", 1], ["Fx_Motor", 2], ["Main", 2], ["Fx_Motor_DB", 3]]);
    expect(g.impact("Fx_Limit").map((i) => i.node.name)).toEqual(["Fx_Motor", "Fx_Motor_DB", "Main"]);
  });

  it("finds dependency paths", () => {
    expect(g.path("Main", "Fx_Types")!.map((n) => n.name)).toEqual(["Main", "Fx_Global", "Fx_Types"]);
    expect(g.path("Fx_Types", "Main")).toBeNull();
  });

  it("serializes deterministically", () => {
    expect(JSON.stringify(build().toJSON())).toBe(JSON.stringify(build().toJSON()));
  });
});

describe("CodeGraph with two PLCs", () => {
  const idx = new WorkspaceIndex();
  for (const plc of ["PLC_A", "PLC_B"]) {
    idx.set(`file:///w/plc/${plc}/blocks/Motor.scl`, `FUNCTION_BLOCK "Motor"
VAR_INPUT
 On : Bool;
END_VAR
BEGIN
END_FUNCTION_BLOCK
`, 0);
    idx.set(`file:///w/plc/${plc}/blocks/Motor_DB.db`, `DATA_BLOCK "Motor_DB"
"Motor"
BEGIN
END_DATA_BLOCK
`, 0);
  }
  idx.set("file:///w/plc/PLC_A/blocks/Main.scl", `ORGANIZATION_BLOCK "Main"
BEGIN
  "Motor_DB"(On := TRUE);
END_ORGANIZATION_BLOCK
`, 0);
  const g = CodeGraph.fromIndex(idx);

  it("keeps same-named objects of two PLCs apart, and a block's names mean its own PLC's objects", () => {
    expect(g.find("Motor").map((n) => [n.id, n.device])).toEqual([["PLC_A/MOTOR", "PLC_A"], ["PLC_B/MOTOR", "PLC_B"]]);
    expect(g.callers("PLC_A/Motor").map((n) => n.id)).toEqual(["PLC_A/MAIN"]);
    expect(g.callers("PLC_B/Motor")).toEqual([]);
    expect(g.outgoing("PLC_B/Motor_DB").map((e) => e.to)).toEqual(["PLC_B/MOTOR"]);
    expect(g.impact(g.key("Motor", "PLC_B")).map((i) => i.node.id)).toEqual(["PLC_B/MOTOR_DB"]);
  });
});
