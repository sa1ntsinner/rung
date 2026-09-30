// SPDX-License-Identifier: BUSL-1.1
// The operands of LAD and FBD networks in SimaticML reach the editor: references, go to definition, no false
// warnings. The fixtures are TIA Portal V20's own exports.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex, definition, diagnostics, references } from "../src/index.js";

const dir = fileURLToPath(new URL("../../../tools/fixtures/xml/sim/", import.meta.url));
const names = ["Fx_LadEdges.xml", "Fx_LadBoxes.xml", "Fx_FbdLogic.xml", "Fx_LadHelper.scl"];
const uri = (n: string) => `file:///w/plc/P/blocks/${n}`;

function index() {
  const idx = new WorkspaceIndex();
  for (const n of names) idx.set(uri(n), readFileSync(dir + n, "utf8"), 0);
  return idx;
}

describe("LAD and FBD networks in SimaticML in the editor", () => {
  it("raises no warning for blocks TIA Portal compiled", () => {
    const idx = index();
    for (const n of names) expect([n, diagnostics(idx, uri(n))]).toEqual([n, []]);
  });

  it("finds the uses of a local in the networks and goes to its declaration", () => {
    const idx = index();
    const text = idx.docs.get(uri("Fx_LadBoxes.xml"))!.text;
    const use = text.indexOf('<Component Name="sum" />') + '<Component Name="'.length;
    const decl = definition(idx, uri("Fx_LadBoxes.xml"), use + 1);
    expect(decl && text.slice(decl.start, decl.end)).toBe("sum");
    expect(decl!.start).toBeLessThan(text.indexOf("<SW.Blocks.CompileUnit"));
    const refs = references(idx, uri("Fx_LadBoxes.xml"), use + 1, false);
    expect(refs.map((r) => text.slice(r.start, r.end))).toEqual(["sum"]);
  });

  it("finds the FC call in a LAD network from the FC", () => {
    const idx = index();
    const scl = idx.docs.get(uri("Fx_LadHelper.scl"))!.text;
    const at = scl.indexOf('"Fx_LadHelper"') + 2;
    const refs = references(idx, uri("Fx_LadHelper.scl"), at, false).filter((r) => r.uri === uri("Fx_LadBoxes.xml"));
    const xml = idx.docs.get(uri("Fx_LadBoxes.xml"))!.text;
    expect(refs.map((r) => xml.slice(r.start, r.end))).toEqual(["Fx_LadHelper"]);
  });
});
