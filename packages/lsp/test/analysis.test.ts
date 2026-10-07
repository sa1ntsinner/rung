// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, diagnostics } from "../src/index.js";

const CODES = new Set(["TEMP_READ_BEFORE_WRITE", "OUTPUT_NEVER_WRITTEN", "NO_RETURN_VALUE", "UNUSED"]);
function findings(text: string) {
  const i = new WorkspaceIndex();
  const uri = "file:///w/plc/P/blocks/X.scl";
  i.set(uri, text, 0);
  i.set("file:///w/plc/P/blocks/Fc_Out.scl", 'FUNCTION "Fc_Out" : Void\nVAR_OUTPUT\n  r : Int;\nEND_VAR\nVAR_IN_OUT\n  io : Int;\nEND_VAR\nBEGIN\n  #r := 1;\n  #io := #io + 1;\nEND_FUNCTION\n', 0);
  return diagnostics(i, uri)
    .filter((d) => CODES.has(d.code))
    .map((d) => `${d.code} ${text.slice(d.start, d.end)}`);
}

describe("analysis: what TIA Portal compiles without a word", () => {
  it("a temporary read before it is written, once per name", () => {
    expect(
      findings(`FUNCTION_BLOCK "X"
VAR_INPUT
  a : Int;
END_VAR
VAR_TEMP
  t : Int;
  u : Int;
END_VAR
BEGIN
  #u := #t + #a;
  #u := #t;
  #t := 1;
END_FUNCTION_BLOCK
`),
    ).toEqual(["TEMP_READ_BEFORE_WRITE #t"]);
  });

  it("no finding for what a call, a loop or a member writes, nor where silenced", () => {
    expect(
      findings(`FUNCTION_BLOCK "X"
VAR_TEMP
  r : Int;
  io : Int;
  i : Int;
  s : Struct
    a : Int;
    b : Int;
  END_STRUCT;
  arr : Array[0..3] of Int;
  k : Int;
END_VAR
VAR
  stat : Int;
END_VAR
BEGIN
  "Fc_Out"(r => #r, io := #io);
  #stat := #r + #io;
  FOR #i := 0 TO 3 DO
    #arr[#i] := #i;
  END_FOR;
  #stat := #arr[1];
  #s.a := 1;
  #stat := #s.b;
  // rung-ignore TEMP_READ_BEFORE_WRITE
  #stat := #k;
END_FUNCTION_BLOCK
`),
    ).toEqual([]);
  });

  it("an FC output never written, a return value never set, unused temporaries and constants", () => {
    expect(
      findings(`FUNCTION "X" : Int
VAR_OUTPUT
  done : Bool;
  count : Int;
END_VAR
VAR_TEMP
  spare : Int;
END_VAR
VAR CONSTANT
  LIMIT : Int := 5;
  OLD : Int := 1;
END_VAR
BEGIN
  #count := #LIMIT;
END_FUNCTION
`),
    ).toEqual(["OUTPUT_NEVER_WRITTEN done", 'NO_RETURN_VALUE "X"', "UNUSED spare", "UNUSED OLD"]);
  });

  it("no false alarm for a constant used in a declaration, an overlay's base, a loop-carried temporary", () => {
    expect(
      findings(`FUNCTION_BLOCK "X"
VAR CONSTANT
  MAX : Int := 3;
END_VAR
VAR_TEMP
  arr : Array[0..MAX] of Int;
  w : Word;
  bits AT w : Array[0..15] of Bool;
  prev : Int;
  i : Int;
END_VAR
VAR
  q : Int;
  b : Bool;
END_VAR
BEGIN
  #arr[0] := 1;
  #q := #arr[0];
  #b := #bits[2];
  FOR #i := 0 TO 3 DO
    IF #i > 0 THEN #q := #prev; END_IF;
    #prev := #i;
  END_FOR;
END_FUNCTION_BLOCK
`),
    ).toEqual([]);
  });

  it("statics are not flagged unused: other blocks and HMI read them from the instance", () => {
    expect(findings('FUNCTION_BLOCK "X"\nVAR\n  seen : Bool;\nEND_VAR\nBEGIN\n  ;\nEND_FUNCTION_BLOCK\n')).toEqual([]);
  });
});
