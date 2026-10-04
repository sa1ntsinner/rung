// SPDX-License-Identifier: BUSL-1.1
// What the P2 review found: a section written into a comment, YAML that reads back as another type, values the
// simulator refuses, structure edits of flow-form cases, a test of another PLC, start values lost, blank lines lost.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/parser.js";
import { declarationModel } from "../src/declarations.js";
import { planDeclarationEdit } from "../src/declarationEdit.js";
import { testModel } from "../src/testModel.js";
import { planTestEdit, type TestOp } from "../src/testEdit.js";
import { valueProblem } from "../src/testSymbols.js";
import { testSkeleton } from "../src/testSkeleton.js";
import { testFilesOf } from "../src/testkeys.js";

const applyTest = (src: string, op: TestOp, strings?: (key: string) => boolean) => {
  const p = planTestEdit(src, testModel(src), op, strings ? { isString: strings } : undefined);
  if (!p.ok) throw new Error(p.reason);
  let out = src;
  for (const e of [...p.edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
};

describe("P2 review", () => {
  it("1: a new section never lands in a comment", () => {
    const fb = "FUNCTION_BLOCK \"FB\"\n(*\nVERSION : draft\n*)\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\n\nBEGIN\nEND_FUNCTION_BLOCK\n";
    const p = planDeclarationEdit(fb, declarationModel("u", 1, fb, parse(fb)), { op: "insertRows", section: "new:Input", rows: [{ name: "Start", type: "Bool" }] });
    if (!p.ok) throw new Error(p.reason);
    const out = fb.slice(0, p.edits[0]!.start) + p.edits[0]!.text + fb.slice(p.edits[0]!.end);
    expect(declarationModel("u", 1, out, parse(out)).sections.map((s) => [s.title, s.rows.map((r) => r.name)])).toEqual([["Input", ["Start"]]]);
  });

  it("5: a case name and a STRING value stay strings; an empty string is ''", () => {
    const src = "block: X\ncases:\n  - name: a\n    steps:\n      - set: { Label: idle }\n";
    expect(applyTest(src, { op: "renameCase", case: 0, name: "123" })).toContain("- name: '123'");
    expect(applyTest(src, { op: "addCase", name: "true" })).toContain("- name: 'true'");
    expect(applyTest(src, { op: "setValue", case: 0, step: 0, part: "set", key: "Label", value: "001" }, (k) => k === "Label")).toContain("Label: '001'");
    expect(applyTest(src, { op: "setValue", case: 0, step: 0, part: "set", key: "Label", value: "" }, (k) => k === "Label")).toContain("Label: ''");
    // a number stays a number where the variable is one
    expect(applyTest(src, { op: "setValue", case: 0, step: 0, part: "set", key: "Label", value: "001" })).toContain("Label: 001");
  });

  it("6: a value must fit the variable's type, as rung test checks it", () => {
    expect(valueProblem("Int", "40000")).toMatch(/Int/);
    expect(valueProblem("Int", "-32768")).toBeUndefined();
    expect(valueProblem("Bool", "yes")).toMatch(/true or false/);
    expect(valueProblem("Bool", "TRUE")).toBeUndefined();
    expect(valueProblem("Real", "1.5e3")).toBeUndefined();
    expect(valueProblem("Real", "abc")).toMatch(/number/);
    expect(valueProblem("Time", "200")).toMatch(/unit/);
    expect(valueProblem("Time", "T#2s")).toBeUndefined();
    expect(valueProblem("String[3]", "abcd")).toMatch(/3 characters/);
    expect(valueProblem('"T_Pos"', "1")).toBeUndefined();
  });

  it("7: structure edits of flow-form cases and steps are refused, not written wrong", () => {
    const flow = "block: X\ncases:\n  - { name: a, steps: [{ cycle: 1 }] }\n";
    const refused = (op: TestOp) => expect(planTestEdit(flow, testModel(flow), op)).toMatchObject({ ok: false });
    refused({ op: "addCase", name: "b" });
    refused({ op: "duplicateCase", case: 0, name: "b" });
    refused({ op: "addStep", case: 0, kind: "cycle" });
    const inline = "block: X\ncases:\n  - name: a\n    steps: [{ cycle: 1 }, { cycle: 2 }]\n";
    expect(planTestEdit(inline, testModel(inline), { op: "addStep", case: 0, kind: "cycle" })).toMatchObject({ ok: false });
    expect(planTestEdit(inline, testModel(inline), { op: "moveStep", case: 0, step: 1, by: -1 })).toMatchObject({ ok: false });
    expect(planTestEdit(inline, testModel(inline), { op: "removeStep", case: 0, step: 1 })).toMatchObject({ ok: false });
    // values inside them still edit
    expect(applyTest(flow, { op: "setRun", case: 0, step: 0, kind: "cycle", value: "3" })).toContain("[{ cycle: 3 }]");
  });

  it("9: a test kept under another PLC's folder is not this PLC's", async () => {
    const root = await mkdtemp(join(tmpdir(), "rung-p2r-"));
    try {
      await mkdir(join(root, "tests", "PLC_1"), { recursive: true });
      await mkdir(join(root, "plc", "PLC_1"), { recursive: true });
      await mkdir(join(root, "plc", "PLC_2"), { recursive: true });
      await writeFile(join(root, "tests", "PLC_1", "Motor.test.yaml"), "block: Motor\ncases: []\n");
      expect(await testFilesOf(root, "Motor", "PLC_2")).toEqual([]);
      expect(await testFilesOf(root, "Motor", "PLC_1")).toEqual(["tests/PLC_1/Motor.test.yaml"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("13: start values of strings and typed literals, a string return value", () => {
    const fc = "FUNCTION \"TextFn\" : String\n   VAR_INPUT\n      Label : String := 'ready';\n      Count : Int := INT#7;\n      Mask : Word := 16#FF;\n      C : Char := 'x';\n   END_VAR\nBEGIN\nEND_FUNCTION\n";
    const s = testSkeleton(declarationModel("u", 1, fc, parse(fc)), { severalPlcs: false });
    expect(s.text).toContain("- set: { Label: 'ready', Count: 7, Mask: 255, C: 'x' }");
    expect(s.text).toContain("- expect: { TextFn: '' }");
  });

  it("15: moving a step keeps the blank line between steps", () => {
    const src = "block: X\ncases:\n  - name: a\n    steps:\n      - cycle: 1\n\n      # second\n      - cycle: 2\n";
    expect(applyTest(src, { op: "moveStep", case: 0, step: 1, by: -1 })).toBe("block: X\ncases:\n  - name: a\n    steps:\n      # second\n      - cycle: 2\n\n      - cycle: 1\n");
  });
});
