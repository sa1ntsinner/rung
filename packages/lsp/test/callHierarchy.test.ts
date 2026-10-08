// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, incomingCalls, outgoingCalls, prepareCallHierarchy } from "../src/index.js";

const MAIN = `ORGANIZATION_BLOCK "Main"
BEGIN
  "Pump_DB"(start := TRUE);
  "Fc_Log"();
END_ORGANIZATION_BLOCK
`;
const PUMP = `FUNCTION_BLOCK "Fb_Pump"
VAR_INPUT
  start : Bool;
END_VAR
VAR
  valve : "Fb_Valve";
END_VAR
BEGIN
  #valve(open := #start);
  "Fc_Log"();
  "Fc_Log"();
END_FUNCTION_BLOCK
`;
const VALVE = `FUNCTION_BLOCK "Fb_Valve"
VAR_INPUT
  open : Bool;
END_VAR
BEGIN
  ;
END_FUNCTION_BLOCK
`;

function idx() {
  const i = new WorkspaceIndex();
  i.set("file:///w/plc/P/blocks/Main.scl", MAIN, 0);
  i.set("file:///w/plc/P/blocks/Fb_Pump.scl", PUMP, 0);
  i.set("file:///w/plc/P/blocks/Fb_Valve.scl", VALVE, 0);
  i.set("file:///w/plc/P/blocks/Fc_Log.scl", 'FUNCTION "Fc_Log" : Void\nBEGIN\nEND_FUNCTION\n', 0);
  i.set("file:///w/plc/P/blocks/Pump_DB.db", 'DATA_BLOCK "Pump_DB"\n"Fb_Pump"\nBEGIN\nEND_DATA_BLOCK\n', 0);
  return i;
}

describe("call hierarchy", () => {
  it("lists callers through instance DBs and multi-instances, and callees by block", () => {
    const i = idx();
    const pump = prepareCallHierarchy(i, "file:///w/plc/P/blocks/Fb_Pump.scl", PUMP.indexOf("Fb_Pump") + 2)!;
    expect(pump).toMatchObject({ name: "Fb_Pump", kind: "FB" });
    expect(incomingCalls(i, pump).map((c) => [c.from.name, c.ranges.length])).toEqual([["Main", 1]]);
    expect(outgoingCalls(i, pump).map((c) => [c.to.name, c.ranges.length]).sort()).toEqual([["Fb_Valve", 1], ["Fc_Log", 2]]);
    // from a call: the block it runs
    const valve = prepareCallHierarchy(i, "file:///w/plc/P/blocks/Fb_Pump.scl", PUMP.indexOf("#valve(") + 2)!;
    expect(valve.name).toBe("Fb_Valve");
    expect(incomingCalls(i, valve).map((c) => c.from.name)).toEqual(["Fb_Pump"]);
    const log = prepareCallHierarchy(i, "file:///w/plc/P/blocks/Main.scl", MAIN.indexOf('"Fc_Log"') + 2)!;
    expect(incomingCalls(i, log).map((c) => c.from.name).sort()).toEqual(["Fb_Pump", "Main"]);
  });
});
