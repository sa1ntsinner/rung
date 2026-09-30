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

  it("reads tags named like a keyword of a variable list (Begin, Retain, Persistent, END_TYPE)", () => {
    const table = [
      "VAR_GLOBAL",
      "    Persistent AT %M0.0 : Bool;",
      "    Begin AT %M0.1 : Bool;",
      "    Retain {ExternalWritable := 'false'} AT %M0.2 : Bool;",
      "    END_TYPE AT %M0.3 : Bool;",
      "    NON_RETAIN AT %M0.4 : Bool;",
      "    Last AT %M0.5 : Bool;",
      "END_VAR",
      "VAR_GLOBAL CONSTANT",
      "    Constant : Int := 1;",
      "END_VAR",
      "",
    ].join("\n");
    const idx = new WorkspaceIndex();
    idx.set(TABLE, table, 0);
    expect(diagnostics(idx, TABLE)).toEqual([]);
    expect(idx.allGlobals().map((g) => `${g.name} ${g.tag?.address ?? g.tag?.value}`)).toEqual(["Persistent %M0.0", "Begin %M0.1", "Retain %M0.2", "END_TYPE %M0.3", "NON_RETAIN %M0.4", "Last %M0.5", "Constant 1"]);
  });

  it("flags what the import into TIA Portal refuses: two tags on a line, a name twice, start values, constants without one", () => {
    const table = [
      "VAR_GLOBAL",
      "    A AT %M0.0 : Bool; B AT %M0.1 : Bool;",
      "    a AT %M0.2 : Bool;",
      "    C AT %M0.3 : Bool := TRUE;",
      "    (* old *) D AT %M0.4 : Bool;",
      "END_VAR",
      "VAR_GLOBAL CONSTANT",
      "    K : Int;",
      "END_VAR",
      "",
    ].join("\n");
    const idx = new WorkspaceIndex();
    idx.set(TABLE, table, 0);
    expect(diagnostics(idx, TABLE).map((d) => `${d.code}: ${table.slice(d.start, d.end)}: ${d.message}`)).toEqual([
      "TAG_LINE: B: one tag per line: B goes on a line of its own",
      "DUPLICATE_TAG: a: a is declared twice in the table (line 2)",
      "START_VALUE: C: a PLC tag has no start value in TIA Portal; constants go in VAR_GLOBAL CONSTANT",
      "TAG_COMMENT: (* old *): use // for a comment, it belongs to the tag on its line",
      "NO_VALUE: K: a constant needs a value: K : Int := 10;",
    ]);
  });

  it("flags a type that does not fit its address, which TIA Portal keeps and shows red", () => {
    const { idx } = setup(text.replace("AT %I0.0 : Bool", "AT %IW40 : Bool").replace("AT %MD10 : Real", "AT %MW10 : Real"));
    expect(diagnostics(idx, TABLE).map((d) => `${d.code}: ${d.message}`)).toEqual([
      "ADDRESS_SIZE: Start is a Bool (one bit) but %IW40 is 16 bits: use %I40.0",
      "ADDRESS_SIZE: Speed set is a Real (32 bits) but %MW10 is 16 bits: use %MD10",
    ]);
  });
});
