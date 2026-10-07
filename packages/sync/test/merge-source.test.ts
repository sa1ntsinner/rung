// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mergeSource, mergeText } from "../src/merge.js";

const fb = (statics: string, body = "  #a := 1;") => `FUNCTION_BLOCK "FB"\nVERSION : 0.1\n   VAR \n      a : Int;\n${statics}   END_VAR\n\nBEGIN\n${body}\nEND_FUNCTION_BLOCK\n`;

describe("merging the file with TIA Portal's text", () => {
  it("a variable declared here and another in TIA Portal both stay", () => {
    expect(mergeText(fb(""), fb("      b : Bool;\n"), fb("      c : Real;\n"))).toEqual({ kind: "clean", text: fb("      b : Bool;\n      c : Real;\n") });
  });
});

describe("merging sources for git", () => {
  it("keeps the declarations both sides added at the end of a section", () => {
    const r = mergeSource(fb(""), fb("      b : Bool;   // mine\n"), fb('      "c d" : Real;\n      {ExternalAccessible := \'False\'} \n'), "FB.scl");
    // the second line of theirs is no declaration: a conflict after all
    expect(r.kind).toBe("conflict");
    const clean = mergeSource(fb(""), fb("      b : Bool;   // mine\n"), fb('      "c d" : Real;\n      t {InstructionName := \'TON_TIME\'} : TON_TIME;\n'), "FB.scl");
    expect(clean).toEqual({ kind: "clean", text: fb('      b : Bool;   // mine\n      "c d" : Real;\n      t {InstructionName := \'TON_TIME\'} : TON_TIME;\n') });
  });

  it("statements both sides added at the same place are still a conflict", () => {
    const r = mergeSource(fb(""), fb("", "  #a := 1;\n  #a := 2;"), fb("", "  #a := 1;\n  #a := 3;"), "FB.scl");
    expect(r.kind).toBe("conflict");
    expect(r.text).toContain("<<<<<<< ours\n  #a := 2;\n||||||| base\n=======\n  #a := 3;\n>>>>>>> theirs\n");
  });

  it("keeps the test cases both sides added", () => {
    const base = "block: FB\ncases:\n  - name: one\n    steps:\n      - cycle: 1\n";
    const ours = `${base}  - name: two\n    steps:\n      - cycle: 2\n`;
    const theirs = `${base}  - name: three\n    steps:\n      - cycle: 3\n`;
    expect(mergeSource(base, ours, theirs, "tests/fb.test.yaml")).toEqual({ kind: "clean", text: `${base}  - name: two\n    steps:\n      - cycle: 2\n  - name: three\n    steps:\n      - cycle: 3\n` });
    // a key both sides changed is a conflict
    expect(mergeSource(base, base.replace("FB", "FB1"), base.replace("FB", "FB2"), "t.test.yaml").kind).toBe("conflict");
  });
});
