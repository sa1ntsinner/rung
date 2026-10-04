// @vitest-environment happy-dom
// SPDX-License-Identifier: MIT
// Editing in the declarations view: each committed cell is one checked message to the extension, a refusal keeps the
// draft, a new row's name opens for typing, pasted rows are previewed first, and a read-only block edits nothing.
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import type { DeclModel, DeclRow, HostToView, ViewToHost } from "../../src/protocol/declarations";
import type { RgTreegrid } from "../../src/webview/grid/rg-treegrid";

const posted: ViewToHost[] = [];
beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: ViewToHost) => posted.push(m), getState: () => undefined, setState: () => {} });
});

const attr = (value: boolean, explicit = false) => ({ value, explicit });
const ranges = { whole: { start: 0, end: 1 }, name: { start: 0, end: 1 }, type: { start: 0, end: 1 } };
const row = (id: string, extra: Partial<DeclRow> = {}): DeclRow => ({ id, depth: 0, name: id, type: "Bool", kind: "plain", attrs: { accessible: attr(true), visible: attr(true), writable: attr(true), setpoint: attr(false) }, hmi: true, other: [], ranges, ...extra });
const model = (rows: DeclRow[], editable = true): DeclModel => ({
  uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl",
  version: 7,
  block: { name: "Fx_Motor", kind: "FB", range: { start: 0, end: 1 } },
  editable,
  ...(editable ? {} : { reason: "Read only: graphical or protected block" }),
  unavailable: [],
  sections: [
    { id: "Input-0", title: "Input", keyword: "VAR_INPUT", modifiers: [], range: { start: 0, end: 1 }, body: { start: 0, end: 1 }, rows: [row("Start", { comment: "push button" })] },
    { id: "Static-1", title: "Static", keyword: "VAR", modifiers: [], range: { start: 0, end: 1 }, body: { start: 0, end: 1 }, rows },
  ],
});
const ROWS = [row("Speed", { type: "Real", start: "1500.0" }), row("Cfg", { type: "Struct", kind: "struct", children: [row("Cfg/a", { name: "a", depth: 1, type: "Int" })] })];

const send = async (v: HTMLElement & { updateComplete: Promise<unknown> }, m: HostToView) => {
  window.dispatchEvent(new MessageEvent("message", { data: m }));
  await v.updateComplete;
  await grid(v)?.updateComplete;
};
const grid = (v: HTMLElement) => v.querySelector("rg-treegrid") as unknown as (RgTreegrid<DeclRow> & HTMLElement) | null;
async function mount(m = model(ROWS)) {
  const { RgDeclarations } = await import("../../src/webview/declarations/view");
  document.body.innerHTML = "";
  const v = new RgDeclarations();
  document.body.append(v);
  await send(v, { v: 1, kind: "model", model: m, context: { plc: "PLC_1", file: "plc/PLC_1/blocks/Fx_Motor.scl", dirty: false, pinned: false } });
  posted.length = 0;
  return v;
}
const key = async (v: HTMLElement & { updateComplete: Promise<unknown> }, target: Element, k: string, mods: KeyboardEventInit = {}) => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  await grid(v)!.updateComplete;
  await v.updateComplete;
};
const cell = (v: HTMLElement, rowId: string, col: string) => v.querySelector<HTMLElement>(`[data-row="${rowId}"] [data-col="${col}"]`)!;
const input = (v: HTMLElement) => v.querySelector<HTMLInputElement>("input.rg-input");
/** opens a cell by a double click, types `value` and presses Enter */
const edit = async (v: HTMLElement & { updateComplete: Promise<unknown> }, rowId: string, col: string, value: string) => {
  cell(v, rowId, col).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await grid(v)!.updateComplete;
  input(v)!.value = value;
  await key(v, input(v)!, "Enter");
};
const edits = () => posted.filter((m) => m.kind !== "ready");

describe("declarations view editing", () => {
  beforeEach(() => {
    posted.length = 0;
  });

  it("a default value, a comment and a type are one edit each, against the version shown", async () => {
    const v = await mount();
    await edit(v, "Speed", "start", "1200.0");
    await edit(v, "Start", "comment", "");
    await edit(v, "Speed", "type", "LReal");
    expect(edits()).toEqual([
      { v: 1, kind: "edit", uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", req: 1, version: 7, op: { op: "setStart", row: "Speed", value: "1200.0" } },
      { v: 1, kind: "edit", uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", req: 2, version: 7, op: { op: "setComment", row: "Start", value: null } },
      { v: 1, kind: "edit", uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", req: 3, version: 7, op: { op: "setType", row: "Speed", type: "LReal" } },
    ]);
  });

  it("a name is renamed through the language server", async () => {
    const v = await mount();
    await edit(v, "Speed", "name", "Velocity");
    expect(edits()).toEqual([{ v: 1, kind: "rename", req: 1, uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", version: 7, rowId: "Speed", name: "Velocity" }]);
  });

  it("a struct's type and default value do not edit", async () => {
    const v = await mount();
    cell(v, "Cfg", "type").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    cell(v, "Cfg", "start").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await grid(v)!.updateComplete;
    expect(input(v)).toBeNull();
  });

  it("an attribute flips with a click, written as on or off", async () => {
    const v = await mount();
    v.querySelector<HTMLButtonElement>('[data-preset="hmi"]')!.click();
    await v.updateComplete;
    await grid(v)!.updateComplete;
    cell(v, "Speed", "writable").click();
    cell(v, "Start", "setpoint").click();
    expect(edits()).toEqual([
      { v: 1, kind: "edit", uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", req: 1, version: 7, op: { op: "setAttr", row: "Speed", key: "ExternalWritable", state: "off" } },
      { v: 1, kind: "edit", uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", req: 2, version: 7, op: { op: "setAttr", row: "Start", key: "S7_SetPoint", state: "on" } },
    ]);
  });

  it("Insert adds after the row, Delete asks the extension, a band's + adds to that section", async () => {
    const v = await mount();
    cell(v, "Speed", "name").click();
    const g = v.querySelector('[role="treegrid"]')!;
    await key(v, g, "Insert");
    await key(v, g, "Delete");
    v.querySelectorAll<HTMLButtonElement>(".rg-band:not(.rg-band-ghost) .rg-band-add")[1]!.click();
    expect(edits()).toEqual([
      { v: 1, kind: "add", req: 1, uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", version: 7, after: "Speed" },
      { v: 1, kind: "delete", req: 2, uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", version: 7, rowId: "Speed" },
      { v: 1, kind: "add", req: 3, uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", version: 7, section: "Static-1" },
    ]);
  });

  it("a refusal is said in the status line and the cell opens again with the draft", async () => {
    const v = await mount();
    await edit(v, "Speed", "start", "abc;");
    await send(v, { v: 1, kind: "result", req: 1, ok: false, reason: '"abc;" is not a start value.' });
    expect(v.querySelector(".rg-status")!.textContent).toContain('"abc;" is not a start value.');
    expect(input(v)?.value).toBe("abc;");
  });

  it("a new row's name opens for typing once the row arrives", async () => {
    const v = await mount();
    cell(v, "Speed", "name").click();
    await key(v, v.querySelector('[role="treegrid"]')!, "Insert");
    await send(v, { v: 1, kind: "result", req: 1, ok: true, edit: { rowId: "Tag_1", column: "name" } });
    expect(input(v)).toBeNull();
    await send(v, { v: 1, kind: "model", model: { ...model([ROWS[0]!, row("Tag_1"), ROWS[1]!]), version: 8 }, context: { file: "f", dirty: true, pinned: false } });
    expect(input(v)?.value).toBe("Tag_1");
  });

  it("with a filter on, a new row stays in view to be named, and keeps its place once named", async () => {
    const v = await mount();
    const filter = v.querySelector<HTMLInputElement>(".rg-filter input")!;
    filter.value = "speed";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    await v.updateComplete;
    cell(v, "Speed", "name").click();
    await key(v, v.querySelector('[role="treegrid"]')!, "Insert");
    await send(v, { v: 1, kind: "result", req: 1, ok: true, edit: { rowId: "Tag_1", column: "name" } });
    await send(v, { v: 1, kind: "model", model: { ...model([ROWS[0]!, row("Tag_1"), ROWS[1]!]), version: 8 }, context: { file: "f", dirty: true, pinned: false } });
    // "Tag_1" does not match "speed", yet it is shown and open for its name
    expect(cell(v, "Tag_1", "name")).not.toBeNull();
    expect(input(v)?.value).toBe("Tag_1");
    input(v)!.value = "Ready";
    await key(v, input(v)!, "Enter");
    await send(v, { v: 1, kind: "model", model: { ...model([ROWS[0]!, row("Ready"), ROWS[1]!]), version: 9 }, context: { file: "f", dirty: true, pinned: false } });
    expect(cell(v, "Ready", "name")).not.toBeNull();
    // a new filter text: only what matches
    filter.value = "spee";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    await v.updateComplete;
    await grid(v)!.updateComplete;
    expect(v.querySelector('[data-row="Ready"]')).toBeNull();
  });

  it("pasted rows are previewed, then inserted after the selected row", async () => {
    const v = await mount();
    cell(v, "Speed", "name").click();
    const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    e.clipboardData = { getData: () => "a\tInt\nb" };
    v.querySelector('[role="treegrid"]')!.dispatchEvent(e);
    expect(edits()).toEqual([{ v: 1, kind: "paste", req: 1, uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", text: "a\tInt\nb" }]);
    await send(v, { v: 1, kind: "pastePreview", req: 1, result: { rows: [{ name: "a", type: "Int" }], errors: [{ line: 2, message: '"b" has no data type.' }] } });
    const dialog = v.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("a");
    expect(dialog.textContent).toContain('"b" has no data type.');
    dialog.querySelector<HTMLButtonElement>(".rg-primary")!.click();
    await v.updateComplete;
    expect(edits()[1]).toEqual({ v: 1, kind: "edit", uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", req: 2, version: 7, op: { op: "insertRows", after: "Speed", rows: [{ name: "a", type: "Int" }] } });
    expect(v.querySelector('[role="dialog"]')).toBeNull();
  });

  it("the type input suggests the PLC's types", async () => {
    const v = await mount();
    await send(v, { v: 1, kind: "types", elementary: ["Int", "Real"], types: [{ name: '"T_Pos"', kind: "UDT" }] });
    const options = [...v.querySelectorAll<HTMLOptionElement>("datalist option")].map((o) => o.value);
    expect(options).toEqual(["Int", "Real", '"T_Pos"']);
    cell(v, "Speed", "type").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await grid(v)!.updateComplete;
    expect(input(v)!.getAttribute("list")).toBe(v.querySelector("datalist")!.id);
  });

  it("a read-only block edits nothing and has no add or delete", async () => {
    const v = await mount(model(ROWS, false));
    await key(v, v.querySelector('[role="treegrid"]')!, "Enter");
    cell(v, "Speed", "start").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await grid(v)!.updateComplete;
    expect(input(v)).toBeNull();
    expect(v.querySelector(".rg-band-add")).toBeNull();
    expect(v.querySelector('[data-action="add"]')).toBeNull();
    expect(edits().map((m) => m.kind)).toEqual(["open", "open"]);
  });

  it("the inspector sets an attribute on or off, and resets an explicit one to TIA's default", async () => {
    const v = await mount(model([row("Speed", { attrs: { accessible: attr(true), visible: attr(true), writable: attr(false, true), setpoint: attr(false) } })]));
    cell(v, "Speed", "name").click();
    await v.updateComplete;
    const seg = (k: string) => v.querySelector(`.rg-inspector [data-attr="${k}"]`)!;
    expect(seg("writable").querySelector('[aria-pressed="true"]')!.textContent!.trim()).toBe("No");
    seg("visible").querySelector<HTMLButtonElement>('[data-state="off"]')!.click();
    seg("writable").querySelector<HTMLButtonElement>('[data-state="default"]')!.click();
    expect(seg("accessible").querySelector('[data-state="default"]')).toBeNull();
    expect(edits()).toEqual([
      { v: 1, kind: "edit", uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", req: 1, version: 7, op: { op: "setAttr", row: "Speed", key: "ExternalVisible", state: "off" } },
      { v: 1, kind: "edit", uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", req: 2, version: 7, op: { op: "setAttr", row: "Speed", key: "ExternalWritable", state: "default" } },
    ]);
  });

  it("a structure's inspector adds a member into it", async () => {
    const v = await mount();
    cell(v, "Cfg", "name").click();
    await v.updateComplete;
    v.querySelector<HTMLButtonElement>('[data-action="add-member"]')!.click();
    expect(edits()).toEqual([{ v: 1, kind: "add", req: 1, uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", version: 7, into: "Cfg" }]);
  });

  it("a problem the language server reports marks its cell, is spoken and shown in the inspector", async () => {
    const v = await mount(model([row("Speed", { type: "Bol", problems: [{ column: "type", severity: "error", message: "Unknown type Bol" }] })]));
    const mark = cell(v, "Speed", "type").querySelector(".rg-problem-error")!;
    expect(mark.getAttribute("title")).toBe("Unknown type Bol");
    expect(cell(v, "Speed", "type").getAttribute("aria-label")).toContain("Unknown type Bol");
    cell(v, "Speed", "name").click();
    await v.updateComplete;
    expect(v.querySelector(".rg-inspector .rg-insp-problems")!.textContent).toContain("Unknown type Bol");
  });

  it("a draft open when the view moves to another file or block is dropped, never sent there", async () => {
    const v = await mount();
    cell(v, "Speed", "start").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await grid(v)!.updateComplete;
    input(v)!.value = "99";
    await send(v, { v: 1, kind: "model", model: { ...model(ROWS), uri: "file:///w/plc/PLC_1/blocks/Other.scl" }, context: { file: "f", dirty: false, pinned: false } });
    expect(input(v)).toBeNull();
    expect(edits()).toEqual([]);
  });

  it("a draft for a cell changed meanwhile (in the text) is not sent over the new value", async () => {
    const v = await mount();
    cell(v, "Speed", "start").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await grid(v)!.updateComplete;
    input(v)!.value = "99";
    input(v)!.dispatchEvent(new Event("input", { bubbles: true }));
    await send(v, { v: 1, kind: "model", model: { ...model([row("Speed", { type: "Real", start: "2000.0" }), ROWS[1]!]), version: 8 }, context: { file: "f", dirty: true, pinned: false } });
    await key(v, input(v)!, "Enter");
    expect(edits()).toEqual([]);
    expect(v.querySelector(".rg-status")!.textContent).toContain("The file changed. Review this value again.");
    expect(input(v)?.value).toBe("99");
  });

  it("a section the block does not have yet is a quiet band whose + makes it, with a first declaration", async () => {
    const v = await mount();
    // Fx_Motor (FB) has Input and Static: Output, InOut, Temp and Constant can be added, in TIA's order
    expect([...v.querySelectorAll(".rg-band")].map((b) => `${b.querySelector(".rg-band-title")!.textContent}${b.classList.contains("rg-band-ghost") ? "?" : ""}`)).toEqual(["Input", "Output?", "InOut?", "Static", "Temp?", "Constant?"]);
    v.querySelector<HTMLButtonElement>(".rg-band-ghost .rg-band-add")!.click();
    expect(edits()).toEqual([{ v: 1, kind: "add", req: 1, uri: "file:///w/plc/PLC_1/blocks/Fx_Motor.scl", version: 7, section: "new:Output" }]);
  });

  it("undo outside an input goes to the document", async () => {
    const v = await mount();
    await key(v, v.querySelector('[role="treegrid"]')!, "z", { ctrlKey: true });
    expect(edits()).toEqual([{ v: 1, kind: "undo" }]);
  });
});
