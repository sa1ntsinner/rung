// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { Simulator, type Instance } from "../src/index.js";

function simulator(...sources: string[]) {
  const index = new WorkspaceIndex();
  sources.forEach((s, i) => index.set(`file:///w/source${i}.st`, s, 0));
  return new Simulator(index);
}

describe("IEC FB inheritance", () => {
  it("initialises every ancestor's variables and runs only the child's body", () => {
    const s = simulator(
      `FUNCTION_BLOCK Root
VAR_INPUT step : INT := 2; END_VAR
VAR_OUTPUT count : INT := 10; END_VAR
VAR timer : TON; END_VAR
count := count + 100;
END_FUNCTION_BLOCK`,
      `FUNCTION_BLOCK Middle EXTENDS Root
VAR middleValue : INT := 3; END_VAR
count := count + 1000;
END_FUNCTION_BLOCK`,
      `FUNCTION_BLOCK Child EXTENDS Middle
VAR ownValue : INT := 4; END_VAR
count := count + step + middleValue + ownValue;
END_FUNCTION_BLOCK`,
    );
    const i = s.newInstance("Child");
    expect([i.mem.COUNT, i.mem.STEP, i.mem.MIDDLEVALUE, i.mem.OWNVALUE, (i.mem.TIMER as Instance)?.mem.PT]).toEqual([10, 2, 3, 4, 0]);
    s.callBlock(i);
    expect(i.mem.COUNT).toBe(19);
    s.callBlock(i, { step: 5 });
    expect(i.mem.COUNT).toBe(31);
  });

  it("runs nested SUPER bodies on the same child instance with inherited positional inputs and outputs", () => {
    const s = simulator(
      `FUNCTION_BLOCK Root
VAR_INPUT step : INT := 1; END_VAR
VAR_OUTPUT count : INT := 10; END_VAR
count := count + step;
END_FUNCTION_BLOCK`,
      `FUNCTION_BLOCK Middle EXTENDS Root
SUPER^();
count := count * 2;
END_FUNCTION_BLOCK`,
      `FUNCTION_BLOCK Child EXTENDS Middle
SUPER^(step := step);
count := count + 3;
END_FUNCTION_BLOCK`,
      `PROGRAM MAIN
VAR child : Child; result : INT; END_VAR
child(2, count => result);
END_PROGRAM`,
    );
    const main = s.newInstance("MAIN");
    s.callBlock(main);
    expect(main.mem.RESULT).toBe(27);
    s.callBlock(main);
    expect(main.mem.RESULT).toBe(61);
  });

  it("finds inherited methods, overrides and lexical SUPER methods while THIS uses the child", () => {
    const s = simulator(
      `FUNCTION_BLOCK Root
VAR count : INT := 1; END_VAR
END_FUNCTION_BLOCK
METHOD Bump : INT
VAR_INPUT step : INT; END_VAR
count := count + step;
Bump := THIS^.Value();
END_METHOD
METHOD Value : INT
Value := count + 10;
END_METHOD`,
      `FUNCTION_BLOCK Middle EXTENDS Root
END_FUNCTION_BLOCK
METHOD Value : INT
Value := SUPER^.Value() + 100;
END_METHOD`,
      `FUNCTION_BLOCK Child EXTENDS Middle
VAR answer : INT; parentValue : INT; END_VAR
answer := Bump(step := 2);
parentValue := SUPER^.Value();
END_FUNCTION_BLOCK
METHOD Value : INT
Value := SUPER^.Value() + 1000;
END_METHOD`,
      `PROGRAM MAIN
VAR child : Child; result : INT; END_VAR
child();
result := child.Bump(step := 4);
END_PROGRAM`,
    );
    const main = s.newInstance("MAIN");
    s.callBlock(main);
    const child = main.mem.CHILD as Instance;
    expect([child.mem.COUNT, child.mem.ANSWER, child.mem.PARENTVALUE, main.mem.RESULT]).toEqual([7, 1113, 113, 1117]);
  });

  it("keeps parent storage and its type on illegal redeclarations while method locals can shadow it", () => {
    const s = simulator(
      `FUNCTION_BLOCK Parent
VAR count : INT := 32767; END_VAR
END_FUNCTION_BLOCK`,
      `FUNCTION_BLOCK Child EXTENDS Parent
VAR count : DINT := 100000; result : DINT; END_VAR
count := count + 1;
result := Local();
END_FUNCTION_BLOCK
METHOD Local : DINT
VAR count : DINT := 100000; END_VAR
Local := count + THIS^.count;
END_METHOD`,
    );
    const i = s.newInstance("Child");
    expect(i.mem.COUNT).toBe(32767);
    s.callBlock(i);
    expect([i.mem.COUNT, i.mem.RESULT]).toEqual([-32768, 67232]);
  });

  it("uses the ancestor scope for inherited start values and constants", () => {
    const s = simulator(
      `FUNCTION_BLOCK Parent
VAR CONSTANT initial : INT := 7; END_VAR
VAR count : INT := initial; END_VAR
count := count + initial;
END_FUNCTION_BLOCK`,
      `FUNCTION_BLOCK Child EXTENDS Parent
VAR own : INT := 2; END_VAR
SUPER^();
count := count + initial + own;
END_FUNCTION_BLOCK`,
    );
    const i = s.newInstance("Child");
    expect(i.mem.COUNT).toBe(7);
    s.callBlock(i);
    expect(i.mem.COUNT).toBe(23);
  });

  it("uses inherited storage types for writes from another block and binds inherited IN_OUT", () => {
    const s = simulator(
      `FUNCTION_BLOCK Parent
VAR count : INT := 32767; END_VAR
VAR_IN_OUT total : INT; END_VAR
END_FUNCTION_BLOCK`,
      `FUNCTION_BLOCK Child EXTENDS Parent
VAR count : DINT := 100000; END_VAR
total := total + 1;
END_FUNCTION_BLOCK`,
      `PROGRAM MAIN
VAR child : Child; total : INT := 4; END_VAR
child.count := child.count + 1;
child(total := total);
END_PROGRAM`,
    );
    const i = s.newInstance("MAIN");
    s.callBlock(i);
    expect([(i.mem.CHILD as Instance).mem.COUNT, i.mem.TOTAL]).toEqual([-32768, 5]);
  });

  it.each(["method", "property"])("lets %s locals shadow inherited constants", (kind) => {
    const s = simulator(
      `FUNCTION_BLOCK Parent
VAR CONSTANT value : INT := 7; END_VAR
END_FUNCTION_BLOCK`,
      `FUNCTION_BLOCK Child EXTENDS Parent
VAR result : INT; END_VAR
result := ${kind === "method" ? "Read()" : "Read"};
END_FUNCTION_BLOCK
${kind === "method" ? "METHOD Read : INT" : "PROPERTY Read : INT\nGET"}
VAR value : INT := 100; END_VAR
Read := value;
${kind === "method" ? "END_METHOD" : "END_GET\nEND_PROPERTY"}`,
    );
    const i = s.newInstance("Child");
    s.callBlock(i);
    expect(i.mem.RESULT).toBe(100);
  });

  it("handles cyclic inheritance without overflowing the stack", () => {
    const s = simulator(
      "FUNCTION_BLOCK A EXTENDS B\nVAR a : INT := 1; END_VAR\nEND_FUNCTION_BLOCK",
      "FUNCTION_BLOCK B EXTENDS A\nVAR b : INT := 2; END_VAR\nEND_FUNCTION_BLOCK",
    );
    expect(() => s.newInstance("A")).toThrow(/inheritance.*cycl|cycl.*inheritance/i);
  });
});
