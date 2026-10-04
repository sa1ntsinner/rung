// @vitest-environment happy-dom
// SPDX-License-Identifier: MIT
// VS Code's undo in a focused webview runs the page's own execCommand("undo"); the browser's undo stack is the
// document's, so it rewound the filter field's typing while the table had the focus. Native undo and redo stay for a
// text field that has the focus; elsewhere the table's own undo (Ctrl+Z on the grid) is the only one.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { guardNativeUndo } from "../../src/webview/nativeUndo";

describe("guardNativeUndo", () => {
  let native: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    document.body.innerHTML = `<input id="filter" type="text"><textarea id="note"></textarea><div id="grid" tabindex="0"></div>`;
    native = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = native;
    guardNativeUndo(document);
  });

  it("undo and redo with the focus outside a text field do nothing", () => {
    document.getElementById("grid")!.focus();
    expect(document.execCommand("undo")).toBe(false);
    expect(document.execCommand("redo")).toBe(false);
    expect(native).not.toHaveBeenCalled();
  });

  it("a text field with the focus keeps its own undo and redo", () => {
    document.getElementById("filter")!.focus();
    document.execCommand("undo");
    document.getElementById("note")!.focus();
    document.execCommand("redo");
    expect(native.mock.calls.map((c) => c[0])).toEqual(["undo", "redo"]);
  });

  it("other commands pass as they are, and installing twice wraps once", () => {
    guardNativeUndo(document);
    document.getElementById("grid")!.focus();
    document.execCommand("copy");
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith("copy");
  });
});
