// SPDX-License-Identifier: BUSL-1.1
// Two objects of one name: in one PLC an error; in a folder of several projects, each file sees its own.
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, diagnostics } from "../src/index.js";

const fc = (name: string, inputs: string) => `FUNCTION "${name}" : Void\nVAR_INPUT\n${inputs}\nEND_VAR\nBEGIN\nEND_FUNCTION\n`;
const caller = (call: string) => `FUNCTION "Caller" : Void\nBEGIN\n  ${call}\nEND_FUNCTION\n`;
const codes = (idx: WorkspaceIndex, uri: string) => diagnostics(idx, uri).map((d) => `${d.severity} ${d.code}`);

describe("objects of one name", () => {
  it("is an error twice in one PLC, not across PLCs", () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/PLC_1/blocks/A.scl", fc("Start", "  Nr : Int;"), 0);
    idx.set("file:///w/plc/PLC_1/blocks/sub/B.scl", fc("Start", "  Nr : Int;"), 0);
    idx.set("file:///w/plc/PLC_2/blocks/A.scl", fc("Start", "  Nr : Int;"), 0);
    expect(diagnostics(idx, "file:///w/plc/PLC_1/blocks/A.scl").find((d) => d.code === "DUPLICATE_BLOCK")).toMatchObject({ severity: "error", message: '"Start" is defined in sub/B.scl too: a PLC has one object of a name' });
    expect(codes(idx, "file:///w/plc/PLC_2/blocks/A.scl")).not.toContain("error DUPLICATE_BLOCK");
  });

  it("in a folder of projects warns, and a call means the block of its own project", () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/Timer/Timer.scl", fc("Start", "  Nr : Int;") + caller('"Start"(Nr := 1);'), 0);
    idx.set("file:///w/DoorLock/DoorLock.scl", fc("Start", "  Nr : Int;\n  Time : Int;"), 0);
    const timer = codes(idx, "file:///w/Timer/Timer.scl");
    expect(timer).toContain("warning DUPLICATE_BLOCK");
    expect(timer).not.toContain("error MISSING_PARAMETER");
  });
});
