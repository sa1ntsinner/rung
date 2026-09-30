// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, complete, definition, diagnostics, hover, references } from "../src/index.js";

// two PLCs of one project with objects of the same name: a name means the object of the file's own PLC
const A_TAGS = "file:///w/plc/PLC_A/tags/IO.tags.st";
const B_TAGS = "file:///w/plc/PLC_B/tags/IO.tags.st";
const A = "file:///w/plc/PLC_A/blocks/Fx_Run.scl";
const B = "file:///w/plc/PLC_B/blocks/Fx_Run.scl";
const srcA = 'FUNCTION "Fx_Run" : Void\nBEGIN\n\t"Start" := "Motor".On;\nEND_FUNCTION\n';
const srcB = 'FUNCTION "Fx_Run" : Void\nBEGIN\n\t"Start" := "Motor".On;\n\t"OnlyB" := TRUE;\nEND_FUNCTION\n';

function workspace() {
  const idx = new WorkspaceIndex();
  idx.set(A_TAGS, "VAR_GLOBAL\n    Start AT %I0.0 : Bool;\nEND_VAR\n", 0);
  idx.set(B_TAGS, "VAR_GLOBAL\n    Start AT %I1.0 : Bool;\n    OnlyB AT %I1.1 : Bool;\nEND_VAR\n", 0);
  idx.set("file:///w/plc/PLC_A/blocks/Motor.db", 'DATA_BLOCK "Motor"\n   VAR\n      On : Bool;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n', 0);
  idx.set("file:///w/plc/PLC_B/blocks/Motor.db", 'DATA_BLOCK "Motor"\n   VAR\n      On : Bool;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n', 0);
  idx.set(A, srcA, 0);
  idx.set(B, srcB, 0);
  return idx;
}
describe("a workspace with several PLCs", () => {
  it("resolves a tag or a DB member in the file's own PLC", () => {
    const idx = workspace();
    expect(definition(idx, A, srcA.indexOf("On;") + 1)?.uri).toBe("file:///w/plc/PLC_A/blocks/Motor.db");
    expect(hover(idx, B, srcB.indexOf('"Start"') + 1)?.markdown).toBe("PLC tag **Start** : `Bool` at `%I1.0` (table IO)");
  });

  it("finds the references of the file's own PLC's object only", () => {
    const idx = workspace();
    const tag = references(idx, A, srcA.indexOf('"Start"') + 1).map((l) => l.uri);
    expect(tag).toContain(A);
    expect(tag).not.toContain(B);
    const member = references(idx, B, srcB.indexOf("On;") + 1).map((l) => l.uri);
    expect(member).toContain(B);
    expect(member).not.toContain(A);
  });

  it("offers the names of the file's own PLC", () => {
    const idx = workspace();
    const text = srcA.replace('"Start" :=', '"');
    idx.set(A, text, 1);
    const labels = complete(idx, A, text.indexOf('"') + 1).map((c) => c.label);
    expect(labels).toContain("Start");
    expect(labels).not.toContain("OnlyB");
    expect(labels.filter((l) => l === "Motor")).toHaveLength(1);
    expect(diagnostics(idx, B).filter((d) => d.code === "UNKNOWN_GLOBAL")).toEqual([]);
  });
});
