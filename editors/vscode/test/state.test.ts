// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { buildTree, devicesInState, objectsOf, parseAddress, parseState, summarize, type StateDoc, type StateObject, type TreeNode } from "../src/core/state";

function obj(address: string, path: string, form: string, extra: Partial<StateObject> = {}): StateObject {
  return { address, path, form, readOnly: false, warnings: [], status: "synced", ...extra };
}

const doc: StateDoc = {
  format: 1,
  objects: Object.fromEntries(
    [
      obj("plc:PLC_1/blocks/Main", "plc/PLC_1/blocks/Main.scl", "scl"),
      obj("plc:PLC_1/blocks/Valves/Valve", "plc/PLC_1/blocks/Valves/Valve.scl", "scl", { status: "conflicted" }),
      obj("plc:PLC_1/blocks/Valves/Sub/Pump", "plc/PLC_1/blocks/Valves/Sub/Pump.scl", "scl", { status: "fileDirty" }),
      obj("plc:PLC_1/blocks/Data", "plc/PLC_1/blocks/Data.db", "db"),
      obj("plc:PLC_1/blocks/Safety", "plc/PLC_1/blocks/Safety.protected.yaml", "protected.yaml", { readOnly: true }),
      obj("plc:PLC_1/types/Motor_T", "plc/PLC_1/types/Motor_T.udt", "udt"),
      obj("plc:PLC_1/tags/Default%20tag%20table", "plc/PLC_1/tags/Default%20tag%20table.tags.xml", "tags.xml"),
      obj("plc:PLC_1/units/Line1/blocks/Seq", "plc/PLC_1/units/Line1/blocks/Seq.scl", "scl"),
      obj("plc:PLC_2/watch/Commissioning", "plc/PLC_2/watch/Commissioning.xml", "xml", { status: "tiaDirty" }),
    ].map((o) => [o.address, o]),
  ),
};

const types: Record<string, "OB" | "FB" | "FC"> = { "plc/PLC_1/blocks/Main.scl": "OB", "plc/PLC_1/blocks/Valves/Valve.scl": "FB", "plc/PLC_1/blocks/Valves/Sub/Pump.scl": "FC" };

function outline(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.type}:${n.label}${n.type === "object" && n.description ? ` [${n.description}]` : ""}`, ...(n.type === "object" ? [] : outline(n.children, depth + 1))]);
}

describe("parseAddress", () => {
  it("decodes devices, units, groups and escapes", () => {
    expect(parseAddress("plc:PLC_1/blocks/A/B/Valve")).toEqual({ device: "PLC_1", kind: "block", groups: ["A", "B"], name: "Valve" });
    expect(parseAddress("plc:PLC%2F1/units/U1/types/T")).toEqual({ device: "PLC/1", unit: "U1", kind: "type", groups: [], name: "T" });
    expect(parseAddress("plc:P/blocks/ns~Name")).toMatchObject({ namespace: "ns", name: "Name" });
    expect(parseAddress("plc:P/nothing/X")).toBeUndefined();
    expect(parseAddress("file:x")).toBeUndefined();
  });
});

describe("parseState", () => {
  it("accepts format 1 only", () => {
    expect(parseState(JSON.stringify(doc))?.objects).toBeDefined();
    expect(parseState('{"format":2,"objects":{}}')).toBeUndefined();
    expect(parseState("{broken")).toBeUndefined();
    expect(parseState("")).toBeUndefined();
  });
});

describe("buildTree", () => {
  const objects = objectsOf(doc, { blockType: (o) => types[o.path] });

  it("groups by device, unit, section and folder", () => {
    expect(outline(buildTree(objects, { grouping: "folder", showReadOnly: true }))).toEqual([
      "device:PLC_1",
      "  section:Program blocks",
      "    folder:Valves",
      "      folder:Sub",
      "        object:Pump [changed here]",
      "      object:Valve [conflict]",
      "    object:Data",
      "    object:Main",
      "    object:Safety [read-only]",
      "  section:PLC data types",
      "    object:Motor_T",
      "  section:PLC tags",
      "    object:Default tag table",
      "  unit:Software unit Line1",
      "    section:Program blocks",
      "      object:Seq",
      "device:PLC_2",
      "  section:Watch tables",
      "    object:Commissioning [changed in TIA]",
    ]);
  });

  it("groups blocks by type with the folder as description", () => {
    const tree = buildTree(objects, { grouping: "kind", showReadOnly: false });
    expect(outline(tree).slice(0, 10)).toEqual([
      "device:PLC_1",
      "  section:Program blocks",
      "    folder:Organization blocks (OB)",
      "      object:Main",
      "    folder:Function blocks (FB)",
      "      object:Valve [conflict · Valves]",
      "    folder:Functions (FC)",
      "      object:Pump [changed here · Valves/Sub]",
      "    folder:Data blocks (DB)",
      "      object:Data",
    ]);
    expect(outline(tree).some((l) => l.includes("Safety"))).toBe(false);
  });

  it("counts objects and conflicts on containers", () => {
    const [plc1] = buildTree(objects, { grouping: "folder", showReadOnly: true });
    expect(plc1).toMatchObject({ type: "device", count: 8, conflicts: 1 });
    const blocks = plc1!.type === "device" ? plc1!.children[0] : undefined;
    expect(blocks).toMatchObject({ type: "section", count: 5, conflicts: 1 });
  });

  it("gives stable ids", () => {
    const ids = outline(buildTree(objects, { grouping: "folder", showReadOnly: true }));
    const flat: string[] = [];
    const walk = (ns: TreeNode[]) => ns.forEach((n) => (flat.push(n.id), n.type !== "object" && walk(n.children)));
    walk(buildTree(objects, { grouping: "folder", showReadOnly: true }));
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat).toContain("obj:plc:PLC_1/blocks/Valves/Valve");
    expect(ids.length).toBe(flat.length);
  });
});

describe("summaries", () => {
  it("lists conflicts and devices", () => {
    const s = summarize(objectsOf(doc));
    expect(s.conflicts).toEqual(["plc/PLC_1/blocks/Valves/Valve.scl"]);
    expect(s.readOnly).toBe(1);
    expect(s.dirty).toBe(2);
    expect(devicesInState(doc)).toEqual(["PLC_1", "PLC_2"]);
  });
});
