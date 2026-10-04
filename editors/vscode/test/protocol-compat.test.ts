// SPDX-License-Identifier: MIT
// The extension's copy of the declaration model stays identical to the language server's, and the view's messages
// are checked before the extension acts on them.
import { describe, it, expect, expectTypeOf } from "vitest";
import type { DeclModel as Server } from "../../../packages/lsp/src/declarations";
import type { DeclOp as ServerOp } from "../../../packages/lsp/src/declarationEdit";
import type { PasteResult as ServerPaste } from "../../../packages/lsp/src/declarationPaste";
import { isViewToHost, type DeclModel as Client, type DeclOp as ClientOp, type PasteResult as ClientPaste } from "../src/protocol/declarations";

describe("declaration protocol", () => {
  it("client and server models are the same type", () => {
    expectTypeOf<Client>().toEqualTypeOf<Server>();
    expectTypeOf<ClientOp>().toEqualTypeOf<ServerOp>();
    expectTypeOf<ClientPaste>().toEqualTypeOf<ServerPaste>();
  });

  it("accepts edits only in their known shapes", () => {
    const ok = (op: unknown) => isViewToHost({ v: 1, kind: "edit", req: 1, uri: "u", version: 3, op });
    expect(ok({ op: "setStart", row: "a", value: "1" })).toBe(true);
    expect(ok({ op: "setStart", row: "a", value: null })).toBe(true);
    expect(ok({ op: "setComment", row: "a", value: "x" })).toBe(true);
    expect(ok({ op: "setAttr", row: "a", key: "ExternalVisible", state: "off" })).toBe(true);
    expect(ok({ op: "setAttr", row: "a", key: "ExternalVisible", state: "maybe" })).toBe(false);
    // only the four attributes the table shows: a key is never text for the file
    expect(ok({ op: "setAttr", row: "a", key: "S7_SetPoint", state: "on" })).toBe(true);
    expect(ok({ op: "setAttr", row: "a", key: "ExternalVisible := 'False'} : Int; x : Int; //", state: "on" })).toBe(false);
    expect(ok({ op: "setType", row: "a", type: "Int" })).toBe(true);
    expect(ok({ op: "insertRows", after: "a", rows: [{ name: "b", type: "Int", start: "1", comment: "c" }] })).toBe(true);
    expect(ok({ op: "insertRows", section: "Static-0", rows: [{ name: "b" }] })).toBe(false);
    expect(ok({ op: "insertRows", rows: "b" })).toBe(false);
    expect(ok({ op: "deleteRow", row: "a" })).toBe(true);
    expect(ok({ op: "format", row: "a" })).toBe(false);
    expect(isViewToHost({ v: 1, kind: "edit", req: "1", uri: "u", version: 3, op: { op: "deleteRow", row: "a" } })).toBe(false);
    expect(isViewToHost({ v: 1, kind: "rename", req: 2, uri: "u", version: 3, rowId: "a", name: "b" })).toBe(true);
    expect(isViewToHost({ v: 1, kind: "add", req: 2, uri: "u", version: 3, after: "a" })).toBe(true);
    expect(isViewToHost({ v: 1, kind: "add", req: 2, uri: "u", version: 3, section: "Static-0" })).toBe(true);
    expect(isViewToHost({ v: 1, kind: "add", req: 2, uri: "u", version: 3, into: "S" })).toBe(true);
    expect(isViewToHost({ v: 1, kind: "delete", req: 2, uri: "u", version: 3, rowId: "a" })).toBe(true);
    expect(isViewToHost({ v: 1, kind: "delete", req: 2, version: 3, rowId: "a" })).toBe(false);
    expect(isViewToHost({ v: 1, kind: "paste", req: 2, uri: "u", text: "a\tInt" })).toBe(true);
    expect(isViewToHost({ v: 1, kind: "undo" })).toBe(true);
    expect(isViewToHost({ v: 1, kind: "redo" })).toBe(true);
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
