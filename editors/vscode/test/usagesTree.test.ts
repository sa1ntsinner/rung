// SPDX-License-Identifier: MIT
// The Usages tree: writers first, then readers and hand-overs, each with where it is called from; and a last line
// saying what static analysis cannot see.
import { describe, it, expect } from "vitest";
import { usagesTree, type Site } from "../src/core/usagesTree";

const pos = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 1 } });
const site = (block: string, line: number, extra: Partial<Site> = {}): Site => ({ uri: `file:///w/${block}.scl`, range: pos(line), kind: "write", block, text: "x := 1;", ...extra });
const rel = (u: string) => u.replace("file:///w/", "");

describe("usagesTree", () => {
  it("groups writers, readers and hand-overs with their call chains, and says what it cannot see", () => {
    const t = usagesTree(
      {
        writes: [site("Fx_Setup", 83, { calledFrom: [{ block: "Main", uri: "file:///w/Main.scl", range: pos(4) }] })],
        reads: [site("Fx_Motor", 111, { kind: "read" })],
        handedOn: [site("Main", 9, { handedTo: { block: "FB_Wrap", param: "Total" } })],
      },
      rel,
    );
    expect(t.map((n) => n.label)).toEqual(["Writes", "Reads", "Handed on", "Workspace code only"]);
    expect(t[0]!.description).toBe("1");
    expect(t[0]!.children![0]).toMatchObject({ label: "Fx_Setup", description: "Fx_Setup.scl:84 · x := 1;" });
    expect(t[0]!.children![0]!.children![0]).toMatchObject({ label: "called from Main", description: "Main.scl:5" });
    expect(t[2]!.children![0]!.children![0]!.label).toBe("to FB_Wrap as Total");
    expect(t[3]!.tooltip).toContain("HMI");
  });

  it("an empty group is left out, not shown as zero; nothing at all says so", () => {
    expect(usagesTree({ writes: [], reads: [site("A", 0, { kind: "read" })] }, rel).map((n) => n.label)).toEqual(["Reads", "Workspace code only"]);
    expect(usagesTree({ writes: [], reads: [] }, rel).map((n) => n.label)).toEqual(["No uses in the workspace", "Workspace code only"]);
  });

  it("a write reached through a parameter names the call it came through", () => {
    const t = usagesTree({ writes: [site("FC_Count", 5, { through: { block: "FB_Wrap", param: "Cnt", uri: "file:///w/FB_Wrap.scl", range: pos(11), text: "FC_Count(Cnt := #Total);" } })], reads: [] }, rel);
    expect(t[0]!.children![0]!.children![0]).toMatchObject({ label: "as Cnt, from FB_Wrap", description: "FB_Wrap.scl:12" });
  });
});
