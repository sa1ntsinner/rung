// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it, vi } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { reconstructCycle, reconstructionRevision, reconstructionWhy, type CycleCapture } from "../src/reconstruct.js";

const uri = "file:///w/plc/P/blocks/Counter.scl";
const source = `FUNCTION_BLOCK "Counter"
VAR_INPUT
  Enable : Bool;
END_VAR
VAR_OUTPUT
  Result : Int;
END_VAR
VAR
  Count : Int;
END_VAR
BEGIN
  IF #Enable THEN
    #Count := #Count + 1;
  END_IF;
  #Result := #Count;
END_FUNCTION_BLOCK`;
const scope = { plc: "P", instance: '"Counter_DB"', epoch: 1 };
function fixture() {
  const index = new WorkspaceIndex(); index.set(uri, source, 0);
  const capture: CycleCapture = { scope, sourceRevision: reconstructionRevision(index, uri), time: 10, clockStart: 0,
    before: { mem: { ENABLE: true, RESULT: 4, COUNT: 4 }, globals: {} },
    observed: { ENABLE: true, RESULT: 5, COUNT: 5 }, coherence: "controlled-cycle" };
  return { index, capture };
}

describe("one-cycle reconstructed SCL status", () => {
  it("attributes only attached destinations and preserves aliased FB paths", () => {
    const run = (body: string, childBody: string) => {
      const index = new WorkspaceIndex();
      index.set(uri, 'FUNCTION_BLOCK "Counter"\nVAR A : Child; B : Child; END_VAR\nBEGIN\n' + body + '\nEND_FUNCTION_BLOCK', 0);
      index.set("file:///w/plc/P/blocks/Child.scl", 'FUNCTION_BLOCK "Child"\nVAR_OUTPUT Q : Int; END_VAR\nBEGIN\n' + childBody + '\nEND_FUNCTION_BLOCK', 0);
      index.set("file:///w/plc/P/blocks/Counter_DB.db", 'DATA_BLOCK "Counter_DB"\n"Counter"\nBEGIN\nEND_DATA_BLOCK', 0);
      const mem = { A: { __fb: "Child", mem: { Q: 0 } }, B: { __fb: "Child", mem: { Q: 0 } } };
      return reconstructCycle(index, uri, { scope, sourceRevision: reconstructionRevision(index, uri), time: 0, clockStart: 0,
        coherence: "controlled-cycle", before: { mem, globals: {} }, observed: mem }, scope);
    };
    const detached = run('#A();', '"Counter_DB".A := "Counter_DB".B; #Q := 9;');
    expect(reconstructionWhy(detached, "A.Q").children[0]?.text).not.toContain("9");
    const aliased = run('#A := #B; #B.Q := 7;', '');
    expect(reconstructionWhy(aliased, "A.Q").children[0]?.text).toContain("7");
    expect(reconstructionWhy(aliased, "B.Q").children[0]?.text).toContain("7");
  });
  it("records writes into freshly bound nested FB array inputs", () => {
    const index = new WorkspaceIndex();
    index.set(uri, 'FUNCTION_BLOCK "Counter"\nVAR C : Child; Arr : Array[1..2] of Int; END_VAR\nBEGIN\n#C(A := #Arr);\nEND_FUNCTION_BLOCK', 0);
    index.set("file:///w/plc/P/blocks/Child.scl", 'FUNCTION_BLOCK "Child"\nVAR_INPUT A : Array[1..2] of Int; END_VAR\nBEGIN\n#A[1] := 9;\nEND_FUNCTION_BLOCK', 0);
    const arr = () => ({ __array: true, lo: 1, items: [0, 0] });
    const mem = { C: { __fb: "Child", mem: { A: arr() } }, ARR: arr() };
    const result = reconstructCycle(index, uri, { scope, sourceRevision: reconstructionRevision(index, uri), time: 0, clockStart: 0,
      coherence: "controlled-cycle", before: { mem, globals: {} }, observed: mem }, scope);
    expect(reconstructionWhy(result, "C.A[1]").children[0]).toMatchObject({ kind: "write" });
  });
  it("does not attribute an earlier scalar write after an unobserved bulk operation", () => {
    const index = new WorkspaceIndex();
    index.set(uri, 'FUNCTION_BLOCK "Counter"\nVAR Arr : Array[1..2] of Int; END_VAR\nBEGIN\n#Arr[1] := 1; FILL_BLK(IN := 7, COUNT := 2, OUT => #Arr[1]);\nEND_FUNCTION_BLOCK', 0);
    const mem = { ARR: { __array: true, lo: 1, items: [0, 0] } };
    const result = reconstructCycle(index, uri, { scope, sourceRevision: reconstructionRevision(index, uri), time: 0, clockStart: 0,
      coherence: "controlled-cycle", before: { mem, globals: {} }, observed: mem }, scope);
    expect(reconstructionWhy(result, "Arr[1]").children[0]?.text).toContain("7");
  });
  it("records FB parameter binding that overwrites an earlier nested member write", () => {
    const index = new WorkspaceIndex();
    index.set(uri, 'FUNCTION_BLOCK "Counter"\nVAR C : Child; Arr : Array[1..2] of Int; END_VAR\nBEGIN\n#C.A[1] := 5;\n#C(A := #Arr);\nEND_FUNCTION_BLOCK', 0);
    index.set("file:///w/plc/P/blocks/Child.scl", 'FUNCTION_BLOCK "Child"\nVAR_INPUT A : Array[1..2] of Int; END_VAR\nBEGIN\nEND_FUNCTION_BLOCK', 0);
    const arr = () => ({ __array: true, lo: 1, items: [0, 0] });
    const mem = { C: { __fb: "Child", mem: { A: arr() } }, ARR: arr() };
    const result = reconstructCycle(index, uri, { scope, sourceRevision: reconstructionRevision(index, uri), time: 0, clockStart: 0,
      coherence: "controlled-cycle", before: { mem, globals: {} }, observed: mem }, scope);
    expect(reconstructionWhy(result, "C.A[1]").children[0]).toMatchObject({ kind: "write", at: { line: 5 } });
  });
  it("refuses missing globals that initializers allocated while constructing the template", () => {
    const { index, capture } = fixture();
    index.set(uri, source.replace('Count : Int;', 'Count : Int := "External".Step;').replace('#Count + 1', '"External".Step'), 0);
    index.set("file:///w/plc/P/blocks/External.db", 'DATA_BLOCK "External"\nVAR Step : Int := 7; END_VAR\nBEGIN\nEND_DATA_BLOCK', 0);
    capture.sourceRevision = reconstructionRevision(index, uri);
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/External.*missing/i);
    capture.before.globals.EXTERNAL = { STEP: 7 };
    capture.observed.COUNT = 7; capture.observed.RESULT = 7;
    expect(reconstructCycle(index, uri, capture, scope).divergences).toEqual([]);
  });
  it("explains the actual last write with recorded operands and branch conditions", () => {
    const { index, capture } = fixture();
    const result = reconstructCycle(index, uri, capture, scope);
    const why = reconstructionWhy(result, "#Count");
    expect(why.value).toBe("5");
    expect(why.children[0]).toMatchObject({ kind: "write", at: { uri, line: 13 } });
    expect(JSON.stringify(why)).toContain("TRUE");
    expect(JSON.stringify(why)).toContain('"value":"4"');
    expect(JSON.stringify(why)).toContain("unverified");
    expect(reconstructionWhy(result, "Enable").children[0]?.text).toMatch(/not written/i);
  });
  it("records dynamic-index writes without evaluating a side-effecting index twice", () => {
    const index = new WorkspaceIndex();
    index.set(uri, `FUNCTION_BLOCK "Counter"
VAR Count : Int; Arr : Array[1..2] of Int; END_VAR
BEGIN
  #Arr["Next"(c := #Count)] := 9;
END_FUNCTION_BLOCK`, 0);
    index.set("file:///w/plc/P/blocks/Next.scl", `FUNCTION "Next" : Int
VAR_IN_OUT c : Int; END_VAR
BEGIN
  #c := #c + 1;
  #Next := #c;
END_FUNCTION`, 0);
    const capture: CycleCapture = { scope, sourceRevision: reconstructionRevision(index, uri), time: 0, clockStart: 0,
      coherence: "controlled-cycle", before: { mem: { COUNT: 0, ARR: { __array: true, lo: 1, items: [0, 0] } }, globals: {} },
      observed: { COUNT: 1, ARR: { __array: true, lo: 1, items: [9, 0] } } };
    const result = reconstructCycle(index, uri, capture, scope);
    expect(result.divergences).toEqual([]);
    expect(reconstructionWhy(result, "Arr[1]").value).toBe("9");
    expect(reconstructionWhy(result, "Count").children[0]).toMatchObject({ kind: "write", at: { line: 4 } });
    expect(reconstructionWhy(result, "Arr[2]").children[0]?.text).toMatch(/not written/i);
    expect(capture.before.mem.COUNT).toBe(0);
  });
  it("advances pre-cycle memory once, records actual expression values and leaves capture unchanged", () => {
    const { index, capture } = fixture(); const original = structuredClone(capture);
    const result = reconstructCycle(index, uri, capture, scope);
    expect(result.kind).toBe("reconstructed"); expect(result.exact).toBe(false);
    expect(result.after.COUNT).toBe(5); expect(result.divergences).toEqual([]);
    expect(result.trace.filter(e => e.kind === "expression" && e.expression.k === "bin").map(e => e.value)).toEqual([5]);
    expect(result.trace.filter(e => e.kind === "statement").map(e => e.line)).toEqual([12, 13, 15]);
    expect(capture).toEqual(original);
  });

  it("shows a skipped branch and a deliberately divergent observation without claiming PLC execution", () => {
    const { index, capture } = fixture(); capture.before.mem.ENABLE = false; capture.observed.ENABLE = false;
    const result = reconstructCycle(index, uri, capture, scope);
    expect(result.trace.filter(e => e.kind === "statement").map(e => e.line)).toEqual([12, 15]);
    expect(result.divergences).toEqual([
      { path: "COUNT", reconstructed: 4, observed: 5 }, { path: "RESULT", reconstructed: 4, observed: 5 },
    ]);
    expect(result.coherence).toBe("controlled-cycle");
  });

  it("refuses incomplete and wrongly typed state instead of substituting defaults", () => {
    const { index, capture } = fixture(); delete capture.before.mem.COUNT;
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/COUNT.*missing/i);
    capture.before.mem.COUNT = "4";
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/COUNT.*type/i);
  });

  it("binds source, PLC, instance and epoch; another PLC's source does not invalidate it", () => {
    const { index, capture } = fixture();
    expect(() => reconstructCycle(index, uri, capture, { ...scope, epoch: 2 })).toThrow(/scope/i);
    expect(() => reconstructCycle(index, uri, capture, { ...scope, instance: '"Other"' })).toThrow(/scope/i);
    index.set("file:///w/plc/Other/blocks/Counter.scl", source + "\n", 0);
    expect(reconstructCycle(index, uri, capture, scope).after.COUNT).toBe(5);
    index.set(uri, source.replace("+ 1", "+ 2"), 1);
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/source/i);
  });

  it("bounds trace output and labels ordinary observations approximate", () => {
    const { index, capture } = fixture(); capture.coherence = "subscription-sample";
    expect(reconstructCycle(index, uri, capture, scope).coherence).toBe("subscription-sample");
    expect(() => reconstructCycle(index, uri, capture, scope, 2)).toThrow(/trace.*limit/i);
  });

  it("does not invent opaque timer state or missing globals", () => {
    const { index, capture } = fixture();
    index.set(uri, source.replace("Count : Int;", "Count : Int;\n Timer1 : TON;"), 0);
    capture.sourceRevision = reconstructionRevision(index, uri);
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/Timer1.*(opaque|standard)/i);
    index.set(uri, source.replace("#Count + 1", '"External".Step + 1'), 0);
    index.set("file:///w/plc/P/blocks/External.db", 'DATA_BLOCK "External"\nVAR\n Step : Int;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK', 0);
    capture.sourceRevision = reconstructionRevision(index, uri);
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/External.*missing/i);
  });

  it("records loop conditions under the loop statement after each body execution", () => {
    const { index, capture } = fixture();
    index.set(uri, source.replace("IF #Enable THEN", "WHILE #Count < 6 DO").replace("END_IF", "END_WHILE"), 0);
    capture.sourceRevision = reconstructionRevision(index, uri); capture.observed.COUNT = 6; capture.observed.RESULT = 6;
    const result = reconstructCycle(index, uri, capture, scope);
    expect(result.trace.filter(e => e.kind === "expression" && e.expression.k === "bin" && e.expression.op === "<")
      .map(e => [e.line, e.kind === "expression" && e.value])).toEqual([[12, true], [12, true], [12, false]]);
    expect(result.divergences).toEqual([]);
  });

  it("observes a side-effecting function once rather than evaluating it again for display", () => {
    const { index, capture } = fixture();
    index.set(uri, source.replace("#Count := #Count + 1", '#Result := "Next"(N := #Count)'), 0);
    index.set("file:///w/plc/P/blocks/Next.scl", `FUNCTION "Next" : Int
VAR_IN_OUT
 N : Int;
END_VAR
BEGIN
 #N := #N + 1;
 #Next := #N;
END_FUNCTION`, 0);
    capture.sourceRevision = reconstructionRevision(index, uri);
    const result = reconstructCycle(index, uri, capture, scope);
    expect(result.after.COUNT).toBe(5); expect(result.divergences).toEqual([]);
    expect(result.trace.filter(e => e.kind === "expression" && e.expression.k === "call")).toHaveLength(1);
  });

  it("refuses ambiguous FB names rather than executing another source file", () => {
    const { capture } = fixture(); const index = new WorkspaceIndex();
    index.set("file:///w/plc/P/blocks/Other.scl", source.replace("+ 1", "+ 100"), 0); index.set(uri, source, 0);
    capture.sourceRevision = reconstructionRevision(index, uri);
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/ambiguous.*source/i);
  });

  it("aliases the selected DB's global reference to the same instance memory", () => {
    const { index, capture } = fixture();
    index.set(uri, source.replace("#Count := #Count + 1;", '#Count := #Count + 1;\n #Count := "Counter_DB".Count + 1;'), 0);
    index.set("file:///w/plc/P/blocks/Counter_DB.db", 'DATA_BLOCK "Counter_DB"\n"Counter"\nBEGIN\nEND_DATA_BLOCK', 0);
    capture.sourceRevision = reconstructionRevision(index, uri); capture.observed.COUNT = 6; capture.observed.RESULT = 6;
    capture.before.globals.COUNTER_DB = { __fb: "Counter", mem: structuredClone(capture.before.mem) };
    expect(reconstructCycle(index, uri, capture, scope).divergences).toEqual([]);
    (capture.before.globals.COUNTER_DB as { mem: Record<string, unknown> }).mem.COUNT = 3;
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/conflicting.*state/i);
    delete capture.before.globals.COUNTER_DB;
    expect(reconstructCycle(index, uri, capture, scope).after.COUNT).toBe(6);
  });

  it("rejects fractional and out-of-range integer state", () => {
    const { index, capture } = fixture(); capture.before.mem.COUNT = 4.5;
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/COUNT.*(integer|type)/i);
    capture.before.mem.COUNT = 32768;
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/COUNT.*range/i);
  });

  it("validates integer members inside arrays of inline structs", () => {
    const { index, capture } = fixture();
    index.set(uri, source.replace("Count : Int;", "Count : Int;\n Rows : Array[-1..0] of Struct\n N : Int;\n END_STRUCT;"), 0);
    capture.sourceRevision = reconstructionRevision(index, uri);
    capture.before.mem.ROWS = { __array: true, lo: -1, items: [{ N: 4.5 }, { N: 0 }] };
    capture.observed.ROWS = structuredClone(capture.before.mem.ROWS);
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/ROWS.*N.*integer/i);
  });

  it("refuses a declared Pointer even when its runtime placeholder is numeric", () => {
    const { index, capture } = fixture();
    index.set(uri, 'FUNCTION_BLOCK "Counter"\nVAR\n P : Pointer;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK', 0);
    capture.sourceRevision = reconstructionRevision(index, uri); capture.before.mem = { P: 123 }; capture.observed = { P: 123 };
    expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/pointer.*unsupported|unsupported.*pointer/i);
  });

  it("bounds declaration shapes before allocating a large array template", () => {
    const { index, capture } = fixture();
    index.set(uri, source.replace("Count : Int;", "Count : Array[0..1000000] of Int;"), 0);
    capture.sourceRevision = reconstructionRevision(index, uri);
    const original = Array.from;
    const spy = vi.spyOn(Array, "from").mockImplementation(((value: ArrayLike<unknown>) => {
      if (value.length > 100_000) throw new Error("unbounded allocation attempted");
      return original(value);
    }) as typeof Array.from);
    try { expect(() => reconstructCycle(index, uri, capture, scope)).toThrow(/state.*limit/i); }
    finally { spy.mockRestore(); }
  });
});
