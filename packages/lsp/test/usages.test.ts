// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, usagesAt } from "../src/index.js";

const u = (p: string) => `file:///w/plc/PLC_1/blocks/${p}`;
const DB = 'DATA_BLOCK "Line_DB"\nVERSION : 0.1\n   VAR\n      Speed : Real;\n      Running : Bool;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n';
const SETTER = 'FUNCTION "Set_Speed" : Void\n   VAR_INPUT\n      v : Real;\n   END_VAR\nBEGIN\n   "Line_DB".Speed := #v;\nEND_FUNCTION\n';
const READER = 'FUNCTION_BLOCK "Fx_Drive"\n   VAR_OUTPUT\n      Out : Real;\n   END_VAR\nBEGIN\n   #Out := "Line_DB".Speed * 2.0;\n   "Line_DB".Running := #Out > 0.0;\nEND_FUNCTION_BLOCK\n';
const MAIN = 'ORGANIZATION_BLOCK "Main"\nBEGIN\n   "Set_Speed"(v := 1500.0);\nEND_ORGANIZATION_BLOCK\n';

describe("usagesAt: who writes and who reads it", () => {
  const index = new WorkspaceIndex();
  index.set(u("Line_DB.db"), DB, 0);
  index.set(u("Set_Speed.scl"), SETTER, 0);
  index.set(u("Fx_Drive.scl"), READER, 0);
  index.set(u("Main.scl"), MAIN, 0);

  it("splits the uses of a DB member into writes and reads, with the block and where a writer is called from", () => {
    const at = READER.indexOf("Speed * 2.0");
    const r = usagesAt(index, u("Fx_Drive.scl"), at);
    expect(r.writes.map((w) => [w.uri, w.block])).toEqual([[u("Set_Speed.scl"), "Set_Speed"]]);
    expect(r.writes[0]!.calledFrom).toEqual([{ block: "Main", uri: u("Main.scl"), start: MAIN.indexOf('"Set_Speed"') }]);
    expect(r.reads.map((x) => [x.uri, x.block])).toEqual([[u("Fx_Drive.scl"), "Fx_Drive"]]);
  });

  it("knows a member written in the same block it is read in", () => {
    const r = usagesAt(index, u("Fx_Drive.scl"), READER.indexOf("Running :="));
    expect(r.writes.map((w) => w.block)).toEqual(["Fx_Drive"]);
    expect(r.reads).toEqual([]);
  });
});

describe("usagesAt: an address written in the code is a use of the tag at it", () => {
  const t = (p: string, plc = "PLC_1") => `file:///w/plc/${plc}/${p}`;
  const TAGS = "VAR_GLOBAL\n    Start_PB AT %I0.0 : Bool;\n    Reset_PB AT %I0.2 : Bool;\n    Lamp AT %Q0.0 : Bool;\nEND_VAR\n";
  const OB = 'ORGANIZATION_BLOCK "Main"\nBEGIN\n   "Line_DB".Running := %I0.2 AND "Start_PB";\n   %Q0.0 := %IX0.2;\nEND_ORGANIZATION_BLOCK\n';
  const OTHER = 'FUNCTION "Fx_Reset" : Void\nBEGIN\n   "Line_DB".Running := "Reset_PB";\nEND_FUNCTION\n';
  const PLC2 = 'ORGANIZATION_BLOCK "Main"\nBEGIN\n   %Q0.0 := %I0.2;\nEND_ORGANIZATION_BLOCK\n';
  const index = new WorkspaceIndex();
  index.set(t("tags/IO.tags.st"), TAGS, 0);
  index.set(t("blocks/Line_DB.db"), DB, 0);
  index.set(t("blocks/Main.scl"), OB, 0);
  index.set(t("blocks/Fx_Reset.scl"), OTHER, 0);
  index.set(t("blocks/Main.scl", "PLC_2"), PLC2, 0);
  const at = (uri: string, s: { start: number }) => [uri, s.start];

  it("from the tag's declaration: its name and its address, in this PLC only", () => {
    const r = usagesAt(index, t("tags/IO.tags.st"), TAGS.indexOf("Reset_PB"));
    expect(r.reads.map((s) => at(s.uri, s)).sort()).toEqual([
      [t("blocks/Fx_Reset.scl"), OTHER.indexOf('"Reset_PB"')],
      [t("blocks/Main.scl"), OB.indexOf("%I0.2")],
      [t("blocks/Main.scl"), OB.indexOf("%IX0.2")],
    ].sort());
    expect(r.reads.find((s) => s.uri === t("blocks/Main.scl"))!.block).toBe("Main");
    expect(r.writes).toEqual([]);
  });

  it("from the address in a block: the tag's uses too; the left of := writes", () => {
    const r = usagesAt(index, t("blocks/Main.scl"), OB.indexOf("%I0.2") + 2);
    expect(r.reads).toHaveLength(3);
    const q = usagesAt(index, t("blocks/Main.scl"), OB.indexOf("%Q0.0") + 1);
    expect(q.writes.map((s) => at(s.uri, s))).toEqual([[t("blocks/Main.scl"), OB.indexOf("%Q0.0")]]);
    expect(q.reads).toEqual([]);
  });

  it("an address no tag has: its own uses", () => {
    const r = usagesAt(index, t("blocks/Main.scl", "PLC_2"), PLC2.indexOf("%I0.2") + 1);
    expect(r.reads.map((s) => at(s.uri, s))).toEqual([[t("blocks/Main.scl", "PLC_2"), PLC2.indexOf("%I0.2")]]);
  });
});

describe("usagesAt: a value handed on to in/outs, down to the block that really writes it", () => {
  const LDB = 'DATA_BLOCK "Line_DB"\n   VAR\n      PartsTotal : DInt;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n';
  const COUNT = 'FUNCTION "FC_Count" : Void\n   VAR_IN_OUT\n      Cnt : DInt;\n   END_VAR\nBEGIN\n   #Cnt := #Cnt + 1;\nEND_FUNCTION\n';
  const WRAP = 'FUNCTION_BLOCK "FB_Wrap"\n   VAR_IN_OUT\n      Total : DInt;\n   END_VAR\nBEGIN\n   "FC_Count"(Cnt := #Total);\nEND_FUNCTION_BLOCK\n';
  const CONV = 'FUNCTION_BLOCK "FB_Conveyor"\n   VAR_IN_OUT\n      Parts : DInt;\n   END_VAR\n   VAR\n      Wrap : "FB_Wrap";\n   END_VAR\nBEGIN\n   #Wrap(Total := #Parts);\nEND_FUNCTION_BLOCK\n';
  const OB = 'ORGANIZATION_BLOCK "Main"\n   VAR_TEMP\n      n : DInt;\n   END_VAR\nBEGIN\n   "Conv_DB"(Parts := "Line_DB".PartsTotal);\n   "FC_Count"(Cnt := #n);\nEND_ORGANIZATION_BLOCK\n';
  const index = new WorkspaceIndex();
  index.set(u("Line_DB.db"), LDB, 0);
  index.set(u("FC_Count.scl"), COUNT, 0);
  index.set(u("FB_Wrap.scl"), WRAP, 0);
  index.set(u("FB_Conveyor.scl"), CONV, 0);
  index.set(u("Conv_DB.db"), 'DATA_BLOCK "Conv_DB"\n"FB_Conveyor"\nBEGIN\nEND_DATA_BLOCK\n', 0);
  index.set(u("Main.scl"), OB, 0);

  it("from the DB member: one write, in FC_Count; the calls that hand it on are not writes", () => {
    const r = usagesAt(index, u("Main.scl"), OB.indexOf("PartsTotal"));
    expect(r.writes.map((s) => [s.block, s.through?.param])).toEqual([["FC_Count", "Cnt"]]);
    expect(r.handedOn!.map((s) => [s.block, s.handedTo])).toEqual([["Main", { block: "FB_Conveyor", param: "Parts" }], ["FB_Conveyor", { block: "FB_Wrap", param: "Total" }], ["FB_Wrap", { block: "FC_Count", param: "Cnt" }]]);
  });

  it("from an in/out inside a block: followed down into the block it is handed to", () => {
    const r = usagesAt(index, u("FB_Wrap.scl"), WRAP.indexOf("#Total") + 1);
    expect(r.writes.filter((s) => s.block === "FC_Count").map((s) => [s.uri, s.start, s.through?.block])).toEqual([[u("FC_Count.scl"), COUNT.indexOf("#Cnt :="), "FB_Wrap"]]);
    expect(r.handedOn!.map((s) => s.block)).toEqual(["FB_Wrap"]);
    expect(r.writes.some((s) => s.uri === u("FB_Wrap.scl"))).toBe(false);
  });

  it("from a temp handed to an in/out: the block that writes it", () => {
    const r = usagesAt(index, u("Main.scl"), OB.indexOf("#n") + 1);
    expect(r.writes.map((s) => s.block)).toEqual(["FC_Count"]);
    expect(r.handedOn!.map((s) => s.block)).toEqual(["Main"]);
  });
});
