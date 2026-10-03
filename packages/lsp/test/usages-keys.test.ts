// SPDX-License-Identifier: BUSL-1.1
// Who writes a tag handed by its address or a DB member written through an FC's output; test keys an editor rename changes.
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceIndex } from "../src/workspace.js";
import { usagesAt } from "../src/features.js";
import { testKeyEdits } from "../src/testkeys.js";
import { monitorServer } from "./monitorHarness.js";

const uri = (name: string) => "file:///w/plc/PLC_1/blocks/" + name;
const DB = 'DATA_BLOCK "Plant"\nVAR\n Value : Int;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n';
const INCREMENT = 'FUNCTION "Increment" : Void\nVAR_IN_OUT\n N : Int;\nEND_VAR\nBEGIN\n #N := #N + 1;\nEND_FUNCTION\n';
const MOTOR = 'FUNCTION_BLOCK "Motor"\nVAR_INPUT\n Start : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n';

describe("who writes this through addresses and outputs; test keys renamed", () => {
  it("finds the real writer of a tag passed by its absolute address to IN_OUT", () => {
    const index = new WorkspaceIndex();
    const main = 'ORGANIZATION_BLOCK "Main"\nBEGIN\n "Increment"(N := %MW0);\nEND_ORGANIZATION_BLOCK\n';
    const tagsUri = "file:///w/plc/PLC_1/tags/IO.tags.st";
    const tags = "VAR_GLOBAL\n Counter AT %MW0 : Int;\nEND_VAR\n";
    index.set(uri("Increment.scl"), INCREMENT, 0);
    index.set(uri("Main.scl"), main, 0);
    index.set(tagsUri, tags, 0);
    for (const [u, at] of [[uri("Main.scl"), main.indexOf("%MW0")], [tagsUri, tags.indexOf("Counter")]] as const)
      expect(usagesAt(index, u, at).writes.map((s) => s.block)).toContain("Increment");
  });

  it("does not attribute reads of an FC's output copy to the caller's destination", () => {
    const index = new WorkspaceIndex();
    const fc = 'FUNCTION "Produce" : Void\nVAR_OUTPUT\n N : Int;\nEND_VAR\nVAR_TEMP\n Temp : Int;\nEND_VAR\nBEGIN\n #N := 5;\n #Temp := #N;\nEND_FUNCTION\n';
    const main = 'ORGANIZATION_BLOCK "Main"\nBEGIN\n "Produce"(N => "Plant".Value);\nEND_ORGANIZATION_BLOCK\n';
    index.set(uri("Plant.db"), DB, 0);
    index.set(uri("Produce.scl"), fc, 0);
    index.set(uri("Main.scl"), main, 0);
    const uses = usagesAt(index, uri("Plant.db"), DB.indexOf("Value"));
    expect(uses.writes.map((s) => s.block)).toContain("Produce");
    expect(uses.reads).toEqual([]);
  });

  it("keeps YAML valid when a plain parameter key is renamed to a legal quoted SCL name", async () => {
    const root = await mkdtemp(join(tmpdir(), "rung-edges-keys-"));
    try {
      await mkdir(join(root, "tests"));
      const text = "block: Motor\ncases:\n  - name: starts\n    steps:\n      - set: { Start: true }\n";
      await writeFile(join(root, "tests", "motor.test.yaml"), text);
      const edits = [...(await testKeyEdits(root, "Motor", "Start", "Reset: Manual")).values()][0]!;
      const lines = text.split("\n");
      for (const e of edits.reverse()) {
        const n = e.range.start.line;
        lines[n] = lines[n]!.slice(0, e.range.start.character) + e.newText + lines[n]!.slice(e.range.end.character);
      }
      expect(lines[4]).toBe('      - set: { "Reset: Manual": true }');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not rename tests of another PLC's same-named block", async () => {
    const s = await monitorServer(undefined, { setup: async (root) => {
      await writeFile(join(root, "plc", "PLC_1", "blocks", "Motor.scl"), MOTOR);
      await mkdir(join(root, "plc", "PLC_2", "blocks"), { recursive: true });
      await writeFile(join(root, "plc", "PLC_2", "blocks", "Motor.scl"), MOTOR);
      await mkdir(join(root, "tests"));
      for (const plc of ["PLC_1", "PLC_2"])
        await writeFile(join(root, "tests", plc + ".test.yaml"), "block: Motor\nplc: " + plc + "\ncases:\n  - name: starts\n    steps:\n      - set: { Start: true }\n");
    } });
    try {
      await s.open(s.uri, MOTOR);
      const edit = await s.client.sendRequest<{ changes: Record<string, unknown[]> }>("textDocument/rename", {
        textDocument: { uri: s.uri }, position: { line: 2, character: 2 }, newName: "StartPb",
      });
      expect(Object.keys(edit.changes).some((u) => u.endsWith("PLC_1.test.yaml"))).toBe(true);
      expect(Object.keys(edit.changes).some((u) => u.endsWith("PLC_2.test.yaml"))).toBe(false);
    } finally { await s.dispose(); }
  });
  it("does not rename text that resembles a key inside a quoted YAML scalar value", async () => {
    const root = await mkdtemp(join(tmpdir(), "rung-edges-value-"));
    try {
      await mkdir(join(root, "tests"));
      const text = "block: Motor\ncases:\n  - name: description\n    steps:\n      - set: { Description: 'operator, Start: true', Start: false }\n";
      await writeFile(join(root, "tests", "motor.test.yaml"), text);
      const edits = [...(await testKeyEdits(root, "Motor", "Start", "Go")).values()][0]!;
      const lines = text.split("\n");
      for (const e of edits.reverse()) {
        const n = e.range.start.line;
        lines[n] = lines[n]!.slice(0, e.range.start.character) + e.newText + lines[n]!.slice(e.range.end.character);
      }
      expect(lines[4]).toBe("      - set: { Description: 'operator, Start: true', Go: false }");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
