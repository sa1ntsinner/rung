// SPDX-License-Identifier: BUSL-1.1
// Golden tests: the input as typed, the output as TIA Portal V19 exported it after a sync (2026-10-06).
import { describe, it, expect } from "vitest";
import { formatScl } from "../src/index.js";

const head = `FUNCTION_BLOCK "Fx_Fmt"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1
   VAR_INPUT
      a : Int;
      b : Bool;
   END_VAR


BEGIN
`;
const tail = "END_FUNCTION_BLOCK\n";
const block = (lines: string[]) => head + lines.join("\n") + "\n" + tail;

describe("formatting as TIA Portal writes SCL", () => {
  it("statements, calls, IF and CASE", () => {
    const typed = block([
      "\t#t(IN := #b, PT := T#1s);",
      "\t#t(IN:=#b,PT:=T#2s,Q=>#q);",
      "\t#x := LIMIT(MN := 0, IN := #a, MX := 100);",
      "\t#x:=#a+1;",
      "\tif #b then",
      "\t  #x := 2;",
      "\t   #y := 1.5;",
      "\telsif #a > 3 then",
      "\t\t#x := 3;",
      "\tend_if;",
      "\t#x := 1; #x := 2;",
      "\t  // a comment",
      "\t#y := INT_TO_REAL(#a) * 2.0;",
      "\t#t(IN := #b);",
      "\t#x := MAX(IN1 := #a, IN2 := 5);",
      "\tCASE #a OF",
      "\t    1: #x := 10;",
      "\t    2..3:",
      "\t        #x := 20;",
      "\t    ELSE",
      "\t        #x := 0;",
      "\tEND_CASE;",
      "\tFOR #x := 1 TO 3 DO",
      "\t    ;",
      "\tEND_FOR;",
    ]);
    const tia = block([
      "\t#t(IN := #b,",
      "\t   PT := T#1s);",
      "\t#t(IN := #b,",
      "\t   PT := T#2s,",
      "\t   Q => #q);",
      "\t#x := LIMIT(MN := 0, IN := #a, MX := 100);",
      "\t#x := #a + 1;",
      "\tIF #b THEN",
      "\t    #x := 2;",
      "\t    #y := 1.5;",
      "\tELSIF #a > 3 THEN",
      "\t    #x := 3;",
      "\tEND_IF;",
      "\t#x := 1;",
      "\t#x := 2;",
      "\t// a comment",
      "\t#y := INT_TO_REAL(#a) * 2.0;",
      "\t#t(IN := #b);",
      "\t#x := MAX(IN1 := #a, IN2 := 5);",
      "\tCASE #a OF",
      "\t    1:",
      "\t        #x := 10;",
      "\t    2..3:",
      "\t        #x := 20;",
      "\t    ELSE",
      "\t        #x := 0;",
      "\tEND_CASE;",
      "\tFOR #x := 1 TO 3 DO",
      "\t    ;",
      "\tEND_FOR;",
    ]);
    expect(formatScl(typed)).toBe(tia);
    expect(formatScl(tia)).toBe(tia); // already formatted: unchanged
  });

  it("regions, nesting, comments, blank lines, operators, loops", () => {
    const typed = block([
      "\tREGION init",
      "\tif #b then",
      "\tif #a>3 then",
      "\t#t(IN:=#b,PT:=t#1s);",
      "\tend_if;",
      "\tend_if;",
      "\tEND_REGION",
      "\t",
      "\t",
      "\t#x := 1; // trailing comment",
      "\t(* block comment *)",
      "\t#x:=-#a*(#a+1)/2 MOD 3;",
      "\t#q:=NOT#b AND(#a<>2 OR #a>=4);",
      "\t#arr[#x+1]:=#arr[ 0 ];",
      "\t#s:='Text';",
      "\tWHILE #x<10 DO",
      "\t#x:=#x+1;",
      "\tIF #x=5 THEN EXIT; END_IF;",
      "\tEND_WHILE;",
      "\tREPEAT",
      "\t#x:=#x-1;",
      "\tUNTIL #x<0",
      "\tEND_REPEAT;",
      "\t#y := int_to_real(in := #a);",
      "\t#t(IN := #b,",
      "\tPT := T#1s);",
      "\tRETURN;",
    ]);
    const tia = block([
      "\tREGION init",
      "\t    IF #b THEN",
      "\t        IF #a > 3 THEN",
      "\t            #t(IN := #b,",
      "\t               PT := t#1s);",
      "\t        END_IF;",
      "\t    END_IF;",
      "\tEND_REGION",
      "\t",
      "\t",
      "\t#x := 1; // trailing comment",
      "\t(* block comment *)",
      "\t#x := - #a * (#a + 1) / 2 MOD 3;",
      "\t#q := NOT#b AND (#a <> 2 OR #a >= 4);",
      "\t#arr[#x + 1] := #arr[0];",
      "\t#s := 'Text';",
      "\tWHILE #x < 10 DO",
      "\t    #x := #x + 1;",
      "\t    IF #x = 5 THEN",
      "\t        EXIT;",
      "\t    END_IF;",
      "\tEND_WHILE;",
      "\tREPEAT",
      "\t    #x := #x - 1;",
      "\tUNTIL #x < 0",
      "\tEND_REPEAT;",
      "\t#y := INT_TO_REAL(IN := #a);",
      "\t#t(IN := #b,",
      "\t   PT := T#1s);",
      "\tRETURN;",
    ]);
    expect(formatScl(typed)).toBe(tia);
    expect(formatScl(tia)).toBe(tia);
  });

  it("an empty statement stands at its level; a block of only ; one level in (V20)", () => {
    expect(formatScl(block(["\tCASE #a OF", "\t1: ;", "\tELSE", "\t;", "\tEND_CASE;"]))).toBe(block(["\tCASE #a OF", "\t    1:", "\t        ;", "\t    ELSE", "\t        ;", "\tEND_CASE;"]));
    expect(formatScl(block(["   ;"]))).toBe(block(["\t    ;"]));
  });

  it("a sign before a number stays on it, before a name it stands apart (V20)", () => {
    const typed = block(["\t#x := -5;", "\t#x := #a*-1;", "\t#r := - 1.5;", "\tFOR #i := 3 TO 0 BY -1 DO", "\t#x := #x+1;", "\tEND_FOR;", "\t#x := -#a;", "\t#x := 2-1;", "\t#x := #a - -1;"]);
    expect(formatScl(typed)).toBe(block(["\t#x := -5;", "\t#x := #a * -1;", "\t#r := -1.5;", "\tFOR #i := 3 TO 0 BY -1 DO", "\t    #x := #x + 1;", "\tEND_FOR;", "\t#x := - #a;", "\t#x := 2 - 1;", "\t#x := #a - -1;"]));
  });

  it("leaves declarations, and text with errors, alone", () => {
    const bad = block(["\t#x := 'unterminated;"]);
    expect(formatScl(bad)).toBeUndefined();
    const decl = head.replace("a : Int;", "a:Int;") + "\t    ;\n" + tail;
    expect(formatScl(decl)).toBe(decl);
  });
});
