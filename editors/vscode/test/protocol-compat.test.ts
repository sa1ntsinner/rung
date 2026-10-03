// SPDX-License-Identifier: MIT
// The extension's copy of the declaration model stays identical to the language server's, and the view's messages
// are checked before the extension acts on them.
import { describe, it, expect, expectTypeOf } from "vitest";
import type { DeclModel as Server } from "../../../packages/lsp/src/declarations";
import { isViewToHost, type DeclModel as Client } from "../src/protocol/declarations";

describe("declaration protocol", () => {
  it("client and server models are the same type", () => {
    expectTypeOf<Client>().toEqualTypeOf<Server>();
  });

  it("accepts only known view messages", () => {
    expect(isViewToHost({ v: 1, kind: "ready" })).toBe(true);
    expect(isViewToHost({ v: 1, kind: "open", target: "type", rowId: "a" })).toBe(true);
    expect(isViewToHost({ v: 1, kind: "open", target: "file", rowId: "a" })).toBe(false);
    expect(isViewToHost({ v: 1, kind: "run", cmd: "rung download" })).toBe(false);
    expect(isViewToHost({ v: 2, kind: "ready" })).toBe(false);
    expect(isViewToHost("ready")).toBe(false);
    expect(isViewToHost(null)).toBe(false);
  });
});
