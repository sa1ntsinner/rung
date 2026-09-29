// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, assignmentList, diagnostics, hover } from "../src/index.js";

const TABLE = "file:///w/plc/P/tags/Fx%20Inputs.tags.st";
const text = [
  "// PLC tag table Fx Inputs in TIA Portal; rung sync writes changes to TIA Portal.",
  "VAR_GLOBAL",
  "    Start AT %I0.0 : Bool;  // start button",
  "    Level {ExternalWritable := 'false'} AT %IB1005 : Byte;",
  '    "Speed set" AT %MD10 : Real;',
  "END_VAR",
  "",
  "VAR_GLOBAL CONSTANT",
  "    MaxSpeed : Int := 1500;",
  "END_VAR",
  "",
].join("\n");

describe("tag tables as text (.tags.st)", () => {
  const setup = (table = text) => {
    const idx = new WorkspaceIndex();
    idx.set(TABLE, table, 0);
    const src = 'FUNCTION "Fx_A" : Void\nBEGIN\n\tIF "Start" AND "Level" > "MaxSpeed" THEN\n\t\t"Speed set" := 1.0;\n\tEND_IF;\nEND_FUNCTION\n';
    idx.set("file:///w/plc/P/blocks/Fx_A.scl", src, 0);
    return { idx, src };
  };

  it("are PLC tags for the code: hover, the assignment list, no unknown names", () => {
    const { idx, src } = setup();
    const uri = "file:///w/plc/P/blocks/Fx_A.scl";
    expect(hover(idx, uri, src.indexOf('"Start"') + 2)?.markdown).toBe("PLC tag **Start** : `Bool` at `%I0.0` (table Fx Inputs)");
    expect(hover(idx, uri, src.indexOf('"MaxSpeed"') + 2)?.markdown).toBe("PLC constant **MaxSpeed** : `Int` = `1500` (table Fx Inputs)");
    expect(diagnostics(idx, uri).filter((d) => d.code === "UNKNOWN_GLOBAL")).toEqual([]);
    expect(assignmentList(idx).items.map((a) => `${a.address} ${a.tags.map((t) => t.name).join(",")}`)).toEqual(["%I0.0 Start", "%IB1005 Level", "%MD10 Speed set"]);
    expect(diagnostics(idx, TABLE)).toEqual([]);
  });

  it("flags a tag without an address, as TIA Portal would refuse it", () => {
    const { idx } = setup(text.replace("Start AT %I0.0 : Bool;", "Start : Bool;"));
    expect(diagnostics(idx, TABLE).map((d) => `${d.code}: ${d.message}`)).toEqual(["NO_ADDRESS: Start has no address: a PLC tag is at an address (Start AT %M10.0 : Bool;)"]);
  });

  it("flags a type that does not fit its address, which TIA Portal keeps and shows red", () => {
    const { idx } = setup(text.replace("AT %I0.0 : Bool", "AT %IW40 : Bool").replace("AT %MD10 : Real", "AT %MW10 : Real"));
    expect(diagnostics(idx, TABLE).map((d) => `${d.code}: ${d.message}`)).toEqual([
      "ADDRESS_SIZE: Start is a Bool (one bit) but %IW40 is 16 bits: use %I40.0",
      "ADDRESS_SIZE: Speed set is a Real (32 bits) but %MW10 is 16 bits: use %MD10",
    ]);
  });
});
