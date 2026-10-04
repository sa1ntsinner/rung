// SPDX-License-Identifier: BUSL-1.1
// The data types a declaration table offers: elementary, TIA's instruction FBs and the PLC's own UDTs and FBs.
import { describe, it, expect } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { monitorServer } from "./monitorHarness.js";

describe("rung/testSkeleton", () => {
  it("drafts the block's first test, and names the test files it already has", async () => {
    const s = await monitorServer();
    try {
      const ask = () => s.client.sendRequest<{ path: string; text: string; existing: string[] }>("rung/testSkeleton", { textDocument: { uri: s.uri }, position: { line: 0, character: 0 } });
      const first = await ask();
      expect(first.path).toBe("tests/Motor.test.yaml");
      expect(first.text).toMatch(/^block: Motor\ncases:\n/);
      expect(first.existing).toEqual([]);
      await mkdir(join(s.root, "tests", "drives"), { recursive: true });
      await writeFile(join(s.root, "tests", "drives", "m.test.yaml"), "block: Motor\ncases: []\n");
      expect((await ask()).existing).toEqual(["tests/drives/m.test.yaml"]);
    } finally {
      await s.dispose();
    }
  });
});

describe("rung/newObject", () => {
  it("knows the PLC's names whatever its folder is called on disk, and tag tables in every unit", async () => {
    const s = await monitorServer(undefined, {
      setup: async (root) => {
        await mkdir(join(root, "plc", "PLC%2F1", "blocks", "Old"), { recursive: true });
        await writeFile(join(root, "plc", "PLC%2F1", "blocks", "Old", "Foo.scl"), 'FUNCTION_BLOCK "Foo"\nBEGIN\nEND_FUNCTION_BLOCK\n');
        await mkdir(join(root, "plc", "PLC%2F1", "units", "U1", "tags", "Old"), { recursive: true });
        await writeFile(join(root, "plc", "PLC%2F1", "units", "U1", "tags", "Old", "Motor%2F1.tags.st"), "VAR_GLOBAL\nEND_VAR\n");
      },
    });
    try {
      const ask = (p: Record<string, unknown>) => s.client.sendRequest<{ reason?: string; path?: string }>("rung/newObject", p);
      expect(await ask({ kind: "FB", name: "foo", plc: "PLC/1", groups: ["New"] })).toEqual({ reason: "PLC/1 already has a block foo." });
      expect(await ask({ kind: "TAGS", name: "Motor/1", plc: "PLC/1", groups: ["New"] })).toEqual({ reason: "PLC/1 already has a tag table Motor/1." });
      expect(await ask({ kind: "FB", name: "Bar", plc: "PLC/1" })).toMatchObject({ path: "plc/PLC%2F1/blocks/Bar.scl" });
    } finally {
      await s.dispose();
    }
  });
});

describe("rung/typeNames", () => {
  it("lists the types the file's PLC can use, not another PLC's", async () => {
    const s = await monitorServer(undefined, {
      setup: async (root) => {
        await mkdir(join(root, "plc", "PLC_1", "types"), { recursive: true });
        await writeFile(join(root, "plc", "PLC_1", "types", "T_Pos.udt"), 'TYPE "T_Pos"\nVERSION : 0.1\n   STRUCT\n      x : Real;\n   END_STRUCT;\n\nEND_TYPE\n');
        await writeFile(join(root, "plc", "PLC_1", "blocks", "Valve.scl"), 'FUNCTION_BLOCK "Valve"\n   VAR\n      x : Int;\n   END_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n');
        await mkdir(join(root, "plc", "PLC_2", "blocks"), { recursive: true });
        await writeFile(join(root, "plc", "PLC_2", "blocks", "Other.scl"), 'FUNCTION_BLOCK "Other"\n   VAR\n      x : Int;\n   END_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n');
      },
    });
    try {
      const r = await s.client.sendRequest<{ elementary: string[]; types: { name: string; kind: string }[] }>("rung/typeNames", { textDocument: { uri: s.uri } });
      expect(r.elementary).toContain("LReal");
      expect(r.elementary).not.toContain("Void");
      expect(r.types).toContainEqual({ name: "TON_TIME", kind: "SFB" });
      expect(r.types).toContainEqual({ name: '"T_Pos"', kind: "UDT" });
      expect(r.types).toContainEqual({ name: '"Valve"', kind: "FB" });
      expect(r.types.map((t) => t.name)).not.toContain('"Other"');
      const pasted = await s.client.sendRequest("rung/declarationPaste", { textDocument: { uri: s.uri }, text: "a\tInt\nb" });
      expect(pasted).toEqual({ rows: [{ name: "a", type: "Int" }], errors: [{ line: 2, message: '"b" has no data type.' }] });
    } finally {
      await s.dispose();
    }
  });
});
