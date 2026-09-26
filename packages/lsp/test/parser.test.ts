// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "../src/parser.js";

const fixtures = fileURLToPath(new URL("../../../tools/fixtures/scl/", import.meta.url));

describe("parse fixtures", () => {
  for (const f of readdirSync(fixtures).filter((n) => /\.(scl|db|udt|awl)$/.test(n) && !n.includes("Broken"))) {
    it(`${f} parses without errors`, () => {
      const r = parse(readFileSync(join(fixtures, f), "utf8"));
      expect(r.diagnostics).toEqual([]);
      expect(r.blocks).toHaveLength(1);
    });
  }

  it("Fx_Motor: FB interface, comments and references", () => {
    const r = parse(readFileSync(join(fixtures, "Fx_Motor.scl"), "utf8"));
    const b = r.blocks[0]!;
    expect([b.kind, b.name]).toEqual(["FB", "Fx_Motor"]);
    expect(b.vars.map((v) => [v.section, v.name, v.type])).toEqual([
      ["Input", "Start", "Bool"],
      ["Input", "Stop", "Bool"],
      ["Input", "SpeedSetpoint", "Real"],
      ["Output", "Running", "Bool"],
      ["Output", "SpeedOut", "Real"],
      ["Static", "Latch", "Bool"],
    ]);
    expect(b.vars[2]!.comment).toBe("rpm");
    expect(b.refs.filter((x) => x.kind === "local").map((x) => x.name)).toContain("SpeedSetpoint");
    expect(b.refs.find((x) => x.kind === "call")!.name).toBe("LIMIT");
  });

  it("Fx_Counter: multi-instance with attributes and member access", () => {
    const b = parse(readFileSync(join(fixtures, "Fx_Counter.scl"), "utf8")).blocks[0]!;
    expect(b.vars.find((v) => v.name === "Debounce")).toMatchObject({ typeRef: "TON_TIME", section: "Static" });
    const q = b.refs.find((x) => x.name === "Debounce" && x.members.length);
    expect(q!.members.map((m) => m.name)).toEqual(["Q"]);
  });

  it("Fx_Global: DB with UDT-typed member and start values", () => {
    const b = parse(readFileSync(join(fixtures, "Fx_Global.db"), "utf8")).blocks[0]!;
    expect(b.kind).toBe("DB");
    expect(b.vars.find((v) => v.name === "Station")).toMatchObject({ typeRef: "Fx_Types" });
    expect(b.refs.map((r) => r.name)).toContain("Counter");
  });

  it("Fx_Types: UDT struct members", () => {
    const b = parse(readFileSync(join(fixtures, "Fx_Types.udt"), "utf8")).blocks[0]!;
    expect(b.kind).toBe("UDT");
    expect(b.vars.map((v) => v.name)).toEqual(["Enabled", "Mode", "Setpoint", "Label"]);
    expect(b.vars.find((v) => v.name === "Label")!.type).toBe("String[20]");
  });
});

describe("parse structure", () => {
  const fb = (body: string, decl = "VAR_TEMP\n  i : Int;\n  a : Array[0..9] of Int;\nEND_VAR\n") => `FUNCTION_BLOCK "B"\n${decl}BEGIN\n${body}\nEND_FUNCTION_BLOCK\n`;

  it("accepts nested control structures, regions and CASE", () => {
    const r = parse(fb("REGION Main loop\n FOR #i := 0 TO 9 DO\n  IF #a[#i] > 0 THEN #a[#i] := 0; ELSIF #i = 1 THEN ; ELSE ; END_IF;\n END_FOR;\n CASE #i OF 1: ; ELSE ; END_CASE;\n WHILE FALSE DO ; END_WHILE;\n REPEAT ; UNTIL TRUE END_REPEAT;\nEND_REGION"));
    expect(r.diagnostics).toEqual([]);
    expect(r.blocks[0]!.regions).toEqual([expect.objectContaining({ name: "Main loop" })]);
  });

  it("reports unclosed and mismatched statements", () => {
    const r = parse(fb("IF TRUE THEN\n FOR #i := 0 TO 1 DO ;\n END_IF;"));
    expect(r.diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/Expected END_FOR/), expect.stringMatching(/IF is not closed/)]);
  });

  it("reports a missing END_FUNCTION_BLOCK and missing END_VAR", () => {
    expect(parse('FUNCTION_BLOCK "B"\nVAR\n x : Bool;\nBEGIN\n').diagnostics.map((d) => d.message)).toEqual(["Missing END_VAR", "Missing END_FUNCTION_BLOCK"]);
  });

  it("reports unbalanced parentheses", () => {
    expect(parse(fb("#i := (1 + 2;")).diagnostics.map((d) => d.message)).toContain("Missing ')'");
    expect(parse(fb("#i := 1 + 2);")).diagnostics.map((d) => d.message)).toContain("Unbalanced ')'");
  });

  it("parses nested STRUCTs, arrays of UDTs and FC return types", () => {
    const r = parse('FUNCTION "F" : Int\nVAR_INPUT\n  s : Struct\n    x : Bool;\n    y : Array[1..3] of "U";\n  END_STRUCT;\nEND_VAR\nBEGIN\n  #F := 1;\nEND_FUNCTION\n');
    expect(r.diagnostics).toEqual([]);
    const s = r.blocks[0]!.vars[0]!;
    expect(s.members!.map((m) => [m.name, m.typeRef, m.isArray])).toEqual([
      ["x", "Bool", false],
      ["y", "U", true],
    ]);
    expect(r.blocks[0]!.returnType).toBe("Int");
  });

  it("recovers from garbage and keeps parsing later blocks", () => {
    const r = parse('garbage ; ;\nFUNCTION "A" : Void\nVAR_INPUT x Bool; y : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION\nFUNCTION "B" : Void\nBEGIN\nEND_FUNCTION\n');
    expect(r.blocks.map((b) => b.name)).toEqual(["A", "B"]);
    expect(r.blocks[0]!.vars.map((v) => v.name)).toEqual(["y"]);
    expect(r.diagnostics.length).toBeGreaterThanOrEqual(2);
  });

  it("parses the interface of an STL source", () => {
    const r = parse(readFileSync(join(fixtures, "Fx_Stl.awl"), "utf8"));
    expect(r.blocks[0]!.vars.map((v) => v.name)).toEqual(["A", "B", "Q"]);
  });

  it("does not crash on truncated inputs", () => {
    const src = readFileSync(join(fixtures, "Fx_Counter.scl"), "utf8");
    for (let cut = 0; cut < src.length; cut += 7) expect(() => parse(src.slice(0, cut))).not.toThrow();
  });
});

describe("reference access", () => {
  it("marks writes, reads and calls", () => {
    const b = parse('FUNCTION_BLOCK "B"\nVAR\n  t : TON;\n  x : Bool;\nEND_VAR\nBEGIN\n  #x := "Tag_In";\n  #t(IN := #x, Q => "Tag_Out");\n  "Fx_Db".Counter := "Fx_Db".Counter + 1;\n  "Fx_Fc"(a := 1);\n  FOR #i := 0 TO 1 DO ; END_FOR;\nEND_FUNCTION_BLOCK\n').blocks[0]!;
    const acc = b.refs.map((r) => `${r.name}${r.members.length ? "." + r.members.map((m) => m.name).join(".") : ""}:${r.access}`);
    expect(acc).toEqual(["x:write", "Tag_In:read", "t:call", "x:read", "Tag_Out:write", "Fx_Db.Counter:write", "Fx_Db.Counter:read", "Fx_Fc:call", "i:write"]);
  });
});
