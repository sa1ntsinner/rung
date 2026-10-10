// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { nativeGlobalReads, verifyNativeBody, verifyNativeScalars } from "../src/native-source.js";

const uri = "file:///fixture/plc/PLC_1/blocks/F.scl";
function source(body: string) {
  const index = new WorkspaceIndex();
  index.set(uri, `FUNCTION_BLOCK "F"\nVAR_OUTPUT\n text : String;\n n : Int;\nEND_VAR\nBEGIN\n${body}\nEND_FUNCTION_BLOCK`, 0);
  return index;
}
it("compares native body tokens using the existing SCL lexer", () => {
  expect(() => verifyNativeBody(source("#n := 2; // edited comment"), "file:///other.scl", "#n:=2;")).toThrow();
  expect(() => verifyNativeBody(source("#n := 2; // edited comment"), uri, "#n:=2;")).not.toThrow();
  expect(() => verifyNativeBody(source("#text := 'a  b';"), uri, "#text := 'a b';")).toThrow(/source/i);
  expect(() => verifyNativeBody(source("#n := 3;"), uri, "#n:=2;")).toThrow(/source/i);
  expect(() => verifyNativeBody(source("#n := 2;"), uri, "#n := 'unfinished;")).toThrow();
});

it("requires complete nonoverlapping native scalar declarations with matching widths", () => {
  const index = new WorkspaceIndex();
  index.set(uri, 'FUNCTION_BLOCK "F"\nVAR_INPUT\n n : Int;\nEND_VAR\nVAR\n flag : Bool;\nEND_VAR\nVAR_TEMP\n tmp : Int;\nEND_VAR\nBEGIN\n#n := 2;\nEND_FUNCTION_BLOCK', 0);
  const bindings = [{ name: "N", bitOffset: 32, bits: 16, type: '{Scalar"33554437"Int}' }, { name: "FLAG", bitOffset: 48, bits: 1, type: '{Scalar"33554433"Bool}' }];
  expect(() => verifyNativeScalars(index, uri, bindings)).not.toThrow();
  // a member without a binding is not captured: the replay refuses only if the cycle reads it
  expect(() => verifyNativeScalars(index, uri, bindings.slice(0, 1))).not.toThrow();
  expect(() => verifyNativeScalars(index, uri, [bindings[0]!, { ...bindings[1]!, bitOffset: 40 }])).toThrow(/overlap/i);
  expect(() => verifyNativeScalars(index, uri, [{ ...bindings[0]!, type: '{Scalar"33554439"DInt}', bits: 32 }, bindings[1]!])).toThrow(/type/i);
  expect(() => verifyNativeScalars(index, uri, [...bindings, bindings[0]!])).toThrow(/duplicate/i);
  expect(() => verifyNativeScalars(index, uri, [{ ...bindings[0]!, bitOffset: -1 }, bindings[1]!])).toThrow();
  const doc = index.docs.get(uri)!;
  index.set(uri, doc.text.replace("#n := 2", "#n := #tmp"), 1);
  // TEMP is left to the replay, which refuses a read on the path it takes before the cycle wrote it
  expect(() => verifyNativeScalars(index, uri, bindings)).not.toThrow();
});

it("refuses uncaptured native CPU clock dependencies", () => {
  const bindings = [{ name: "N", bitOffset: 32, bits: 16, type: '{Scalar"33554437"Int}' }];
  for (const clock of ["RD_SYS_T", "RD_LOC_T", "RUNTIME"]) {
    const index = new WorkspaceIndex();
    index.set(uri, `FUNCTION_BLOCK "F"\nVAR_OUTPUT\n n : Int;\nEND_VAR\nBEGIN\n#n := ${clock}();\nEND_FUNCTION_BLOCK`, 0);
    expect(() => verifyNativeScalars(index, uri, bindings)).toThrow(/clock/i);
  }
});

it("refuses local constants whose native initializer was not matched", () => {
  const index = new WorkspaceIndex();
  index.set(uri, 'FUNCTION_BLOCK "F"\nVAR_OUTPUT\n n : Int;\nEND_VAR\nVAR CONSTANT\n Step : Int := 2;\nEND_VAR\nBEGIN\n#n := #n + #Step;\nEND_FUNCTION_BLOCK', 0);
  const bindings = [{ name: "N", bitOffset: 32, bits: 16, type: '{Scalar"33554437"Int}' }];
  expect(() => verifyNativeBody(index, uri, '#n := #n + #Step;')).not.toThrow();
  expect(() => verifyNativeScalars(index, uri, bindings)).toThrow(/constant/i);
  // the PLC reports the value each used constant was compiled with: replay only when it is the one the source declares
  const step = (value: string, type = '{Scalar"33554437"Int}') => [{ name: "STEP", type, value }];
  expect(() => verifyNativeScalars(index, uri, bindings, step("2"))).not.toThrow();
  expect(() => verifyNativeScalars(index, uri, bindings, step("3"))).toThrow(/Step.*3.*2|compiled/i);
  expect(() => verifyNativeScalars(index, uri, bindings, step("2", '{Scalar"33554439"DInt}'))).toThrow(/Step/);
  index.set(uri, index.docs.get(uri)!.text.replace("#n := #n + #Step;", "#n := 1;"), 1);
  // an unused constant changes nothing the replay computes
  expect(() => verifyNativeScalars(index, uri, bindings, [])).not.toThrow();
});

it("refuses external state and user calls without matching native dependency sources", () => {
  const bindings = [{ name: "N", bitOffset: 32, bits: 16, type: '{Scalar"33554437"Int}' }];
  for (const expression of ['"Other"()', 'Other()', '"G".n', '%MW0']) {
    const index = new WorkspaceIndex();
    index.set(uri, `FUNCTION_BLOCK "F"\nVAR_OUTPUT\n n : Int;\nEND_VAR\nBEGIN\n#n := ${expression};\nEND_FUNCTION_BLOCK`, 0);
    index.set(uri.replace('/F.scl', '/Other.scl'), 'FUNCTION "Other" : Int\nBEGIN\nOther := 1;\nEND_FUNCTION', 0);
    expect(() => verifyNativeScalars(index, uri, bindings)).toThrow(/external|dependency/i);
  }
  const local = new WorkspaceIndex();
  local.set(uri, 'FUNCTION_BLOCK "F"\nVAR_OUTPUT\n n : Int;\nEND_VAR\nBEGIN\n#n := #n.%X3;\nEND_FUNCTION_BLOCK', 0);
  expect(() => verifyNativeScalars(local, uri, bindings)).not.toThrow();
});

it("lists the DB members and tags a body reads, and refuses what a sample cannot capture by name", () => {
  const bindings = [{ name: "N", bitOffset: 32, bits: 16, type: '{Scalar"33554437"Int}' }];
  const make = (body: string) => {
    const index = new WorkspaceIndex();
    index.set(uri, `FUNCTION_BLOCK "F"\nVAR_OUTPUT\n n : Int;\nEND_VAR\nBEGIN\n${body}\nEND_FUNCTION_BLOCK`, 0);
    index.set(uri.replace("/F.scl", "/Line_DB.db"), 'DATA_BLOCK "Line_DB"\nVERSION : 0.1\n   VAR\n      Speed : Int;\n      arr : Array[0..3] of Int;\n      s : Struct\n         a : Int;\n      END_STRUCT;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK', 0);
    index.set(uri.replace("/blocks/F.scl", "/tags/Io.tags.st"), "VAR_GLOBAL\n    Start_PB AT %I0.0 : Bool;\nEND_VAR\n", 0);
    return index;
  };
  const ok = make('IF "Start_PB" THEN\n#n := "Line_DB".Speed + "Line_DB".s.a + "Line_DB".Speed;\nEND_IF;');
  expect(nativeGlobalReads(ok, uri)).toEqual(['"Start_PB"', '"Line_DB".Speed', '"Line_DB".s.a']);
  expect(() => verifyNativeScalars(ok, uri, bindings)).not.toThrow();
  expect(nativeGlobalReads(make('#n := DINT_TO_INT(INT_TO_DINT(#n) + 1);'), uri)).toEqual([]);
  // a written member is captured too: the replay's value is compared with the PLC's
  expect(nativeGlobalReads(make('"Line_DB".Speed := #n + "Line_DB".s.a;'), uri)).toEqual(['"Line_DB".Speed', '"Line_DB".s.a']);
  expect(() => nativeGlobalReads(make('#n := "Line_DB".arr[#n];'), uri)).toThrow(/index/i);
  expect(() => nativeGlobalReads(make('#n := "Line_DB".s;'), uri)).toThrow(/whole/i);
});

it("accepts a structure member and an array element by path when the declaration says so", () => {
  const index = new WorkspaceIndex();
  index.set(uri, 'FUNCTION_BLOCK "F"\nVAR_OUTPUT\n n : Int;\nEND_VAR\nVAR\n s : Struct\n  a : Int;\n  b : Bool;\n END_STRUCT;\n arr : Array[0..2] of Int;\nEND_VAR\nBEGIN\n#s.a := #arr[1];\nEND_FUNCTION_BLOCK', 0);
  const int = (name: string, bitOffset: number) => ({ name, bitOffset, bits: 16, type: '{Scalar"33554437"Int}' });
  expect(() => verifyNativeScalars(index, uri, [int("S.A", 48), int("ARR[1]", 96), { name: "S.B", bitOffset: 64, bits: 1, type: '{Scalar"33554433"Bool}' }])).not.toThrow();
  expect(() => verifyNativeScalars(index, uri, [int("ARR[5]", 96)])).toThrow(/ARR\[5\]/);
  expect(() => verifyNativeScalars(index, uri, [int("S.Z", 96)])).toThrow(/S\.Z/);
  expect(() => verifyNativeScalars(index, uri, [int("S.B", 64)])).toThrow(/type/i);
});
