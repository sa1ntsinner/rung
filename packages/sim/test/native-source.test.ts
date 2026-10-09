// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { verifyNativeBody, verifyNativeScalars } from "../src/native-source.js";

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
  expect(() => verifyNativeScalars(index, uri, bindings.slice(0, 1))).toThrow(/missing/i);
  expect(() => verifyNativeScalars(index, uri, [bindings[0]!, { ...bindings[1]!, bitOffset: 40 }])).toThrow(/overlap/i);
  expect(() => verifyNativeScalars(index, uri, [{ ...bindings[0]!, type: '{Scalar"33554439"DInt}', bits: 32 }, bindings[1]!])).toThrow(/type/i);
  expect(() => verifyNativeScalars(index, uri, [...bindings, bindings[0]!])).toThrow(/duplicate/i);
  expect(() => verifyNativeScalars(index, uri, [{ ...bindings[0]!, bitOffset: -1 }, bindings[1]!])).toThrow();
  const doc = index.docs.get(uri)!;
  index.set(uri, doc.text.replace("#n := 2", "#n := #tmp"), 1);
  expect(() => verifyNativeScalars(index, uri, bindings)).toThrow(/temporary/i);
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
