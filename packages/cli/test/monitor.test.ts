// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, diagnostics } from "@rung/lsp";
import { monitorPlan } from "../src/monitor.js";

const fb = (name: string, input: string) => `FUNCTION_BLOCK "${name}"\n   VAR_INPUT \n      ${input} : Bool;\n   END_VAR\n\nBEGIN\n\t;\nEND_FUNCTION_BLOCK\n`;
const db = (name: string, of: string) => `DATA_BLOCK "${name}"\n"${of}"\nBEGIN\nEND_DATA_BLOCK\n`;

describe("two PLCs with objects of the same names", () => {
  const setup = () => {
    const idx = new WorkspaceIndex();
    // PLC_B's Motor_DB is an instance of PLC_B's Motor; PLC_A's Motor_DB instantiates something else
    idx.set("file:///w/plc/PLC_B/blocks/Motor.scl", fb("Motor", "Run"), 0);
    idx.set("file:///w/plc/PLC_B/blocks/Motor_DB.db", db("Motor_DB", "Motor"), 0);
    idx.set("file:///w/plc/PLC_A/blocks/Motor.scl", fb("Motor", "Start"), 0);
    idx.set("file:///w/plc/PLC_A/blocks/Motor_DB.db", db("Motor_DB", "Other"), 0);
    // the same FC name with two interfaces
    idx.set("file:///w/plc/PLC_B/blocks/Valve.scl", 'FUNCTION "Valve" : Void\n   VAR_INPUT \n      Close : Bool;\n   END_VAR\n\nBEGIN\n\t;\nEND_FUNCTION\n', 0);
    idx.set("file:///w/plc/PLC_A/blocks/Valve.scl", 'FUNCTION "Valve" : Void\n   VAR_INPUT \n      Open : Bool;\n   END_VAR\n\nBEGIN\n\t;\nEND_FUNCTION\n', 0);
    idx.set("file:///w/plc/PLC_A/blocks/Line.scl", 'FUNCTION "Line" : Void\nBEGIN\n\t"Valve"(Open := TRUE);\nEND_FUNCTION\n', 0);
    return idx;
  };

  it("monitoring reads an FB only through an instance DB of its own PLC", () => {
    expect(() => monitorPlan(setup(), "file:///w/plc/PLC_A/blocks/Motor.scl")).toThrow(/Motor has no instance DB of its own/);
    expect(monitorPlan(setup(), "file:///w/plc/PLC_B/blocks/Motor.scl").instance).toBe('"Motor_DB"');
  });

  it("a call is checked against the block of its own PLC", () => {
    const d = diagnostics(setup(), "file:///w/plc/PLC_A/blocks/Line.scl").filter((x) => x.code === "UNKNOWN_PARAMETER" || x.code === "MISSING_PARAMETER");
    expect(d).toEqual([]);
  });
});
