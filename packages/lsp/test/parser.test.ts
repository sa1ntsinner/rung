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
    expect(b.refs.map((r) => r.name)).toContain("Count");
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

  it("treats the rest of a REGION / END_REGION line as its name (keywords, odd characters)", () => {
    const r = parse(fb("REGION data for x?\n  #i := 1;\nEND_REGION data for x?\nREGION b\n  #r ?= #v;\nEND_REGION"));
    expect(r.diagnostics).toEqual([]);
    expect(r.blocks[0]!.regions.map((x) => x.name)).toEqual(["data for x?", "b"]);
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

  it("parses a standard-access DB declared with STRUCT … END_STRUCT (QA-24)", () => {
    const r = parse('DATA_BLOCK "S"\n{ S7_Optimized_Access := \'FALSE\' }\nVERSION : 0.1\nNON_RETAIN\n   STRUCT\n      Limits : Struct\n         MaxCurrent : Int;\n      END_STRUCT;\n      Flag : Bool;\n   END_STRUCT;\n\nBEGIN\n   Flag := TRUE;\nEND_DATA_BLOCK\n');
    expect(r.diagnostics).toEqual([]);
    expect(r.blocks[0]!.vars.map((v) => v.name)).toEqual(["Limits", "Flag"]);
    expect(r.blocks[0]!.vars[0]!.members!.map((m) => m.name)).toEqual(["MaxCurrent"]);
  });

  it("indexes the interface of STL sources but ignores the STL body (QA-24)", () => {
    const src = 'FUNCTION "S" : Void\nVAR_INPUT\n  a : Bool;\nEND_VAR\nBEGIN\nNETWORK\nTITLE = with brackets\n      A(;\n      A "Db".x;\n      O #a;\n      );\n      L s5t#10ms;\n      = "Db".y;\n      JC m001;\nm001: NOP 0;\nEND_FUNCTION\n';
    for (const r of [parse(src, { dialect: "stl" }), parse(src)]) {
      expect(r.diagnostics).toEqual([]);
      expect(r.blocks[0]!.vars.map((v) => v.name)).toEqual(["a"]);
      expect(r.blocks[0]!.refs).toEqual([]);
    }
  });

  it("accepts REF_TO, POINTER TO and REFERENCE TO declarations", () => {
    const r = parse('FUNCTION "F" : Void\nVAR_INPUT\n  r : REF_TO Int;\n  u : REF_TO "U";\nEND_VAR\nBEGIN\nEND_FUNCTION\n');
    expect(r.diagnostics).toEqual([]);
    expect(r.blocks[0]!.vars.map((v) => [v.type, v.typeRef])).toEqual([
      ["REF_TO Int", "Int"],
      ["REF_TO \"U\"", "U"],
    ]);
    const iec = parse("FUNCTION_BLOCK FB\nVAR\n  p : POINTER TO INT;\n  q : REFERENCE TO ST_X;\n  x AT %I* : BOOL;\nEND_VAR\nEND_FUNCTION_BLOCK\n", { dialect: "iec" });
    expect(iec.diagnostics).toEqual([]);
    expect(iec.blocks[0]!.vars.map((v) => [v.name, v.typeRef])).toEqual([
      ["p", "INT"],
      ["q", "ST_X"],
      ["x", "BOOL"],
    ]);
  });

  it("collects DB start values with member paths as references to the DB's variables (QA-21)", () => {
    const b = parse('DATA_BLOCK "D"\nVAR\n  Plug : Struct\n    Delay_time : S5Time;\n  END_STRUCT;\nEND_VAR\nBEGIN\n   Plug.Delay_time := S5T#1s;\n   arr[1].x := 16#2;\nEND_DATA_BLOCK\n').blocks[0]!;
    expect(b.refs.map((r) => [r.kind, r.name, r.members.map((m) => m.name).join("."), r.access])).toEqual([
      ["local", "Plug", "Delay_time", "write"],
      ["local", "arr", "x", "write"],
    ]);
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

  it("treats compound and attempt assignments as writes", () => {
    const b = parse('FUNCTION_BLOCK "B"\nVAR\n  n : Int;\n  r : REF_TO Int;\nEND_VAR\nBEGIN\n  #n += 1;\n  #n -= #n;\n  #r ?= #v;\nEND_FUNCTION_BLOCK\n').blocks[0]!;
    expect(b.refs.map((r) => `${r.name}:${r.access}`)).toEqual(["n:write", "n:write", "n:read", "r:write", "v:read"]);
  });
});
