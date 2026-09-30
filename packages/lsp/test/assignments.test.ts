// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, assignmentList, parseAbsolute } from "../src/index.js";

const tags = (name: string, rows: [string, string, string][]) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<Document>\n<SW.Tags.PlcTagTable ID="0">\n<AttributeList><Name>${name}</Name></AttributeList>\n<ObjectList>\n` +
  rows.map(([n, t, a], i) => `<SW.Tags.PlcTag ID="${i + 1}" CompositionName="Tags"><AttributeList><DataTypeName>${t}</DataTypeName><LogicalAddress>${a}</LogicalAddress><Name>${n}</Name></AttributeList></SW.Tags.PlcTag>\n`).join("") +
  `</ObjectList>\n</SW.Tags.PlcTagTable>\n</Document>\n`;

describe("assignment list: sizes TIA Portal does not write in the address", () => {
  it("a 64-bit tag at a bit address takes eight bytes; peripheral access in code stays peripheral", () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/P/tags/Default%20tag%20table.tags.st", "VAR_GLOBAL\n    Wide AT %M0.0 : LReal;\nEND_VAR\n", 0);
    idx.set("file:///w/plc/P/blocks/Fx_A.scl", 'FUNCTION "Fx_A" : Void\nBEGIN\n\t%MD4 := %IW256:P;\n\t"Flag" := TRUE;\nEND_FUNCTION\n', 0);
    const r = assignmentList(idx);
    const wide = r.items.find((a) => a.tags.some((t) => t.name === "Wide"))!;
    expect([wide.address, wide.bits]).toEqual(["%M0.0", 64]);
    expect(r.overlaps).toContainEqual({ device: "P", a: "%M0.0", b: "%MD4", bytes: [4, 5, 6, 7], nested: true });
    expect(r.items.find((a) => a.address === "%IW256")).toMatchObject({ peripheral: true });
  });
});

describe("assignment list of a workspace with several PLCs", () => {
  it("keeps each PLC's addresses, tags and uses apart; addresses of two PLCs never overlap", () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/PLC_A/tags/IO.tags.st", "VAR_GLOBAL\n    Start AT %I0.0 : Bool;\n    Speed AT %MW10 : Int;\nEND_VAR\n", 0);
    idx.set("file:///w/plc/PLC_B/tags/IO.tags.st", "VAR_GLOBAL\n    Start AT %I0.0 : Bool;\n    Level AT %MW11 : Int;\nEND_VAR\n", 0);
    idx.set("file:///w/plc/PLC_A/blocks/Fx_A.scl", 'FUNCTION "Fx_A" : Void\nBEGIN\n\t"Speed" := 1;\n\tIF "Start" THEN\n\t\t%M20.0 := TRUE;\n\tEND_IF;\nEND_FUNCTION\n', 0);
    idx.set("file:///w/plc/PLC_B/blocks/Fx_B.scl", 'FUNCTION "Fx_B" : Void\nBEGIN\n\tIF "Start" THEN\n\t\t"Level" := 2;\n\tEND_IF;\nEND_FUNCTION\n', 0);
    const r = assignmentList(idx);
    const file = (u: string) => u.split("/").slice(-3).join("/");
    expect(r.items.map((a) => `${a.device} ${a.address} ${a.tags.map((t) => t.name).join(",")} ${a.uses.map((u) => `${file(u.uri)}:${u.line + 1}`).join(",")}`)).toEqual([
      "PLC_A %I0.0 Start PLC_A/blocks/Fx_A.scl:4",
      "PLC_A %MW10 Speed PLC_A/blocks/Fx_A.scl:3",
      "PLC_A %M20.0  PLC_A/blocks/Fx_A.scl:5",
      "PLC_B %I0.0 Start PLC_B/blocks/Fx_B.scl:3",
      "PLC_B %MW11 Level PLC_B/blocks/Fx_B.scl:4",
    ]);
    expect(r.overlaps).toEqual([]);
    expect(assignmentList(idx, "PLC_B").items.map((a) => a.address)).toEqual(["%I0.0", "%MW11"]);
  });
});

describe("assignment list", () => {
  it("reads absolute addresses like TIA Portal, German mnemonics and peripheral access too", () => {
    expect(parseAbsolute("%I0.3")).toMatchObject({ address: "%I0.3", area: "I", byte: 0, bit: 3, bits: 1 });
    expect(parseAbsolute("%MW10")).toMatchObject({ address: "%MW10", area: "M", byte: 10, bits: 16 });
    expect(parseAbsolute("%EB4")).toMatchObject({ address: "%IB4", area: "I", bits: 8 });
    expect(parseAbsolute("%AD8")).toMatchObject({ address: "%QD8", area: "Q", bits: 32 });
    expect(parseAbsolute("%IW256:P")).toMatchObject({ address: "%IW256", peripheral: true });
    expect([parseAbsolute("%MW10.3"), parseAbsolute("%M10"), parseAbsolute("%DB1.DBX0.0")]).toEqual([undefined, undefined, undefined]);
  });

  it("lists addresses with their tags and uses, and tells crossing overlaps from nested ones", () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/P/tags/IO.tags.xml", tags("IO", [["Start", "Bool", "%I0.0"], ["Status", "Byte", "%IB2"], ["Speed", "Int", "%MW10"], ["Speed2", "Int", "%MW11"]]), 0);
    const src = 'FUNCTION "Fx_A" : Void\nBEGIN\n\tIF "Start" AND %I2.1 THEN\n\t\t%M20.0 := TRUE;\n\tEND_IF;\nEND_FUNCTION\n';
    idx.set("file:///w/plc/P/blocks/Fx_A.scl", src, 0);
    const r = assignmentList(idx);
    expect(r.items.map((a) => `${a.address} ${a.tags.map((t) => t.name).join(",")} ${a.uses.map((u) => u.line + 1).join(",")}`)).toEqual([
      "%I0.0 Start 3",
      "%IB2 Status ",
      "%I2.1  3",
      "%MW10 Speed ",
      "%MW11 Speed2 ",
      "%M20.0  4",
    ]);
    expect(r.overlaps).toEqual([
      { device: "P", a: "%IB2", b: "%I2.1", bytes: [2], nested: true },
      { device: "P", a: "%MW10", b: "%MW11", bytes: [11], nested: false },
    ]);
  });
});
