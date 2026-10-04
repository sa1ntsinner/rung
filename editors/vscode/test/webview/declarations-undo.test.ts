// @vitest-environment happy-dom
// SPDX-License-Identifier: MIT
// With the table focused, VS Code's Undo (the page's execCommand("undo")) must not rewind the filter field.
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { DeclModel } from "../../src/protocol/declarations";

const native = vi.fn(() => true);
beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => undefined, setState: () => {} });
  (document as unknown as { execCommand: unknown }).execCommand = native;
});

const model: DeclModel = {
  uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl",
  version: 1,
  block: { name: "Fx_Motor", kind: "FB", range: { start: 0, end: 1 } },
  editable: true,
  unavailable: [],
  sections: [{
    id: "Input-0", title: "Input", keyword: "VAR_INPUT", modifiers: [], range: { start: 0, end: 1 }, body: { start: 0, end: 1 },
    rows: [{ id: "Start", depth: 0, name: "Start", type: "Bool", kind: "plain", attrs: { accessible: { value: true, explicit: false }, visible: { value: true, explicit: false }, writable: { value: true, explicit: false }, setpoint: { value: false, explicit: false } }, hmi: true, other: [], ranges: { whole: { start: 0, end: 1 }, name: { start: 0, end: 1 }, type: { start: 0, end: 1 } } }],
  }],
};

describe("declarations view and the page's own undo", () => {
  it("undo with the table focused leaves the filter alone; in the filter it is the field's own", async () => {
    const { RgDeclarations } = await import("../../src/webview/declarations/view");
    const v = new RgDeclarations();
    document.body.append(v);
    window.dispatchEvent(new MessageEvent("message", { data: { v: 1, kind: "model", model, context: { plc: "PLC_1", file: "plc/PLC_1/blocks/Fx_Motor.scl", dirty: false, pinned: false } } }));
    await v.updateComplete;
    v.querySelector<HTMLElement>('[role="treegrid"]')!.focus();
    document.execCommand("undo");
    expect(native).not.toHaveBeenCalled();
    v.querySelector<HTMLInputElement>(".rg-filter input")!.focus();
    document.execCommand("undo");
    expect(native).toHaveBeenCalledWith("undo");
  });

  it("after the table's undo the keyboard is back in the table, so a second Ctrl+Z undoes again", async () => {
    const { RgDeclarations } = await import("../../src/webview/declarations/view");
    document.body.innerHTML = "";
    const v = new RgDeclarations();
    document.body.append(v);
    const model2 = (version: number) => ({ v: 1, kind: "model", model: { ...model, version }, context: { plc: "PLC_1", file: "plc/PLC_1/blocks/Fx_Motor.scl", dirty: true, pinned: false } });
    window.dispatchEvent(new MessageEvent("message", { data: model2(1) }));
    await v.updateComplete;
    const grid = () => v.querySelector<HTMLElement>('[role="treegrid"]')!;
    grid().focus();
    grid().dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    // the extension runs the undo in the text editor: the view loses the keyboard, then gets the new model
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(grid());
    window.dispatchEvent(new MessageEvent("message", { data: model2(2) }));
    await v.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(grid());
    // a model that is not the answer to an undo leaves the focus where it is
    v.querySelector<HTMLInputElement>(".rg-filter input")!.focus();
    window.dispatchEvent(new MessageEvent("message", { data: model2(3) }));
    await v.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(v.querySelector(".rg-filter input"));
  });
});
