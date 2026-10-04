// SPDX-License-Identifier: MIT
// The extension's copy of the test file model stays identical to the language server's, and the test table's
// messages are checked before the extension acts on them.
import { describe, it, expect, expectTypeOf } from "vitest";
import type { TestModel as Server } from "../../../packages/lsp/src/testModel";
import type { TestOp as ServerOp } from "../../../packages/lsp/src/testEdit";
import type { KeyProblem as ServerProblem, TestSymbol as ServerSymbol } from "../../../packages/lsp/src/testSymbols";
import { isTestViewToHost, type KeyProblem, type TestModel, type TestOp, type TestSymbol } from "../src/protocol/tests";

describe("test table protocol", () => {
  it("client and server models are the same type", () => {
    expectTypeOf<TestModel>().toEqualTypeOf<Server>();
    expectTypeOf<TestOp>().toEqualTypeOf<ServerOp>();
    expectTypeOf<TestSymbol>().toEqualTypeOf<ServerSymbol>();
    expectTypeOf<KeyProblem>().toEqualTypeOf<ServerProblem>();
  });

  it("accepts only known messages and ops", () => {
    const edit = (op: unknown) => isTestViewToHost({ v: 1, kind: "edit", req: 1, uri: "u", version: 2, op });
    expect(edit({ op: "setValue", case: 0, step: 1, part: "set", key: "a", value: "1" })).toBe(true);
    expect(edit({ op: "setValue", case: 0, step: 1, part: "stub", key: "a", value: "1" })).toBe(false);
    expect(edit({ op: "setRun", case: 0, step: 0, kind: "advance", value: null })).toBe(true);
    expect(edit({ op: "moveStep", case: 0, step: 0, by: 2 })).toBe(false);
    expect(edit({ op: "addCase", name: "x" })).toBe(true);
    expect(edit({ op: "removeCase", case: -1 })).toBe(false);
    expect(edit({ op: "rm -rf", case: 0 })).toBe(false);
    expect(isTestViewToHost({ v: 1, kind: "pick", req: 2, uri: "u", version: 2, case: 0, step: 0, part: "expect" })).toBe(true);
    expect(isTestViewToHost({ v: 1, kind: "run", case: 1 })).toBe(true);
    expect(isTestViewToHost({ v: 1, kind: "run", case: "1" })).toBe(false);
    expect(isTestViewToHost({ v: 1, kind: "openText", line: 3 })).toBe(true);
    expect(isTestViewToHost({ v: 1, kind: "exec" })).toBe(false);
  });
});
