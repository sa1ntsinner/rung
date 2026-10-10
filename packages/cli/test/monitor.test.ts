// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, diagnostics } from "@rung/lsp";
import { monitorPlan } from "../src/monitor.js";

const fb = (name: string, input: string) => `FUNCTION_BLOCK "${name}"\n   VAR_INPUT \n      ${input} : Bool;\n   END_VAR\n\nBEGIN\n\t;\nEND_FUNCTION_BLOCK\n`;
const db = (name: string, of: string) => `DATA_BLOCK "${name}"\n"${of}"\nBEGIN\nEND_DATA_BLOCK\n`;

describe("monitoring a DB", () => {
  it("reports instance choices as structured error details", () => {
    const idx = new WorkspaceIndex(), uri = "file:///w/plc/P/blocks/Motor.scl";
    idx.set(uri, fb("Motor", "Run"), 0);
    idx.set("file:///w/plc/P/blocks/A.db", db("A", "Motor"), 0);
    idx.set("file:///w/plc/P/blocks/B.db", db("B", "Motor"), 0);
    let error: unknown;
    try { monitorPlan(idx, uri); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: "NO_INSTANCE", details: { instances: ["A", "B"] } });
  });
  it("reads a multi-instance through its DB and member path, written with or without quotes", () => {
    const idx = new WorkspaceIndex(), uri = "file:///w/plc/P/blocks/Motor.scl";
    idx.set(uri, fb("Motor", "Run"), 0);
    expect(monitorPlan(idx, uri, "Line_DB.motor").vars.Run).toBe('"Line_DB".motor.Run');
    expect(monitorPlan(idx, uri, '"Line_DB".motor').vars.Run).toBe('"Line_DB".motor.Run');
    expect(monitorPlan(idx, uri, "Motor_DB").vars.Run).toBe('"Motor_DB".Run');
  });
  it("reads the members of its STRUCTs too, each on its own line, labelled with its path", () => {
    const idx = new WorkspaceIndex();
    const text = 'DATA_BLOCK "Line_DB"\n   VAR \n      Ready : Bool;\n      Motor : Struct\n         Speed : Int;\n         "Set point" : Real;\n      END_STRUCT;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n';
    idx.set("file:///w/plc/P/blocks/Line_DB.db", text, 0);
    const plan = monitorPlan(idx, "file:///w/plc/P/blocks/Line_DB.db");
    expect(plan.vars).toEqual({ Ready: '"Line_DB".Ready', "Motor.Speed": '"Line_DB".Motor.Speed', "Motor.Set point": '"Line_DB".Motor."Set point"' });
    expect(plan.lines).toEqual({ 2: ["Ready"], 4: ["Motor.Speed"], 5: ["Motor.Set point"] });
  });

  it("reads the first elements of an array of an elementary type (a page of 16)", () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/P/blocks/Buf_DB.db", 'DATA_BLOCK "Buf_DB"\n   VAR \n      Small : Array[1..3] of Int;\n      Big : Array[0..99] of Bool;\n      Parts : Array[0..1] of "Part";\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n', 0);
    const plan = monitorPlan(idx, "file:///w/plc/P/blocks/Buf_DB.db");
    expect(plan.lines[2]).toEqual(["Small[1]", "Small[2]", "Small[3]"]);
    expect(plan.vars["Small[2]"]).toBe('"Buf_DB".Small[2]');
    expect(plan.lines[3]).toHaveLength(16);
    expect(plan.lines[3]!.at(-1)).toBe("Big[15]");
    expect(plan.lines[4]).toBeUndefined(); // an array of a data type: not elementary
  });
});

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
