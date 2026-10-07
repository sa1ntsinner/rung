// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { declarationModel, parse, planDeclarationEdit, type DeclOp } from "../src/index.js";

const URI = "file:///w/plc/PLC_1/tags/Motors.tags.st";
const TEXT = `// PLC tag table Motors in TIA Portal; rung sync writes changes to TIA Portal.
// A tag: Name AT %address : Type;  // comment        A constant: Name : Type := value;
VAR_GLOBAL
    Start_PB AT %I0.0 : Bool;   // start button
    Speed {ExternalAccessible := 'false'} AT %MW10 : Int;
END_VAR
VAR_GLOBAL CONSTANT
    Max_Speed : Int := 1500;
END_VAR
`;

const model = () => declarationModel(URI, 3, TEXT, parse(TEXT, { dialect: "iec", unitName: "Motors" }), undefined, () => false, [], "%M2.0");
const apply = (op: DeclOp) => {
  const plan = planDeclarationEdit(TEXT, model(), op);
  if (!plan.ok) return plan.reason;
  let out = TEXT;
  for (const e of [...plan.edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
};

describe("a PLC tag table as a declarations table", () => {
  it("shows its tags with their addresses and its constants", () => {
    const m = model();
    expect(m.block).toMatchObject({ name: "Motors", kind: "TAGS" });
    expect(m.sections.map((s) => `${s.title}: ${s.rows.map((r) => `${r.name} ${r.address ?? "-"} ${r.type}${r.start ? ` := ${r.start}` : ""}`).join(", ")}`)).toEqual([
      "Tags: Start_PB %I0.0 Bool, Speed %MW10 Int",
      "Constants: Max_Speed - Int := 1500",
    ]);
    const speed = m.sections[0]!.rows[1]!;
    expect(TEXT.slice(speed.ranges.address!.start, speed.ranges.address!.end)).toBe("%MW10");
    expect(speed.attrs.accessible).toMatchObject({ value: false, explicit: true });
    expect(m.sections[1]!.rows[0]!.hmi).toBe(false);
    expect(m.nextAddress).toBe("%M2.0");
  });

  it("edits an address as TIA Portal writes it, and refuses what is none", () => {
    expect(apply({ op: "setAddress", row: "Speed", value: "%mw12" })).toContain("Speed {ExternalAccessible := 'false'} AT %MW12 : Int;");
    expect(apply({ op: "setAddress", row: "Speed", value: "%MW10.3" })).toMatch(/is not an address/);
    expect(apply({ op: "setAddress", row: "Max_Speed", value: "%MW0" })).toBe("Only a PLC tag has an address.");
    expect(apply({ op: "setStart", row: "Start_PB", value: "TRUE" })).toMatch(/A PLC tag has no start value/);
    expect(apply({ op: "setStart", row: "Max_Speed", value: "1200" })).toContain("Max_Speed : Int := 1200;");
  });

  it("gives a new tag the next free bit memory; several need their own addresses", () => {
    expect(apply({ op: "insertRows", after: "Speed", rows: [{ name: "Tag_1", type: "Bool" }] })).toContain("    Speed {ExternalAccessible := 'false'} AT %MW10 : Int;\n    Tag_1 AT %M2.0 : Bool;\nEND_VAR");
    expect(apply({ op: "insertRows", after: "Speed", rows: [{ name: "A", type: "Bool" }, { name: "B", type: "Bool" }] })).toMatch(/add them one at a time/);
    expect(apply({ op: "insertRows", after: "Speed", rows: [{ name: "A", type: "Int", address: "%MW20" }, { name: "B", type: "Bool", address: "%Q0.1" }] })).toContain("    A AT %MW20 : Int;\n    B AT %Q0.1 : Bool;\n");
    expect(apply({ op: "insertRows", after: "Max_Speed", rows: [{ name: "Min_Speed", type: "Int", start: "10" }] })).toContain("    Min_Speed : Int := 10;\n");
  });
});
