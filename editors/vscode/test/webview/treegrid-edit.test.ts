// @vitest-environment happy-dom
// SPDX-License-Identifier: MIT
// Editing in the tree-grid: a cell becomes an input in place, Enter/Tab commit, Escape cancels, a toggle cell flips
// with Space or a click, and the row keys (Insert, Delete, undo) are only asked for, never done by the grid.
import { describe, it, expect } from "vitest";
import { RgTreegrid } from "../../src/webview/grid/rg-treegrid";
import type { GridColumn, GridRow, GridSection } from "../../src/webview/grid/types";

interface Row extends GridRow {
  name: string;
  type: string;
  on: boolean;
}

const sections: GridSection<Row>[] = [
  { id: "st", title: "Static", rows: [
    { id: "a", depth: 0, name: "a", type: "Int", on: false },
    { id: "b", depth: 0, name: "b", type: "Bool", on: true },
  ] },
];
const columns: GridColumn[] = [
  { key: "name", label: "Name", width: 120 },
  { key: "type", label: "Type", width: 120 },
  { key: "on", label: "On", width: 40 },
  { key: "fixed", label: "Fixed", width: 0 },
];

async function mount(editable = true) {
  document.body.innerHTML = "";
  const g = new RgTreegrid<Row>();
  g.sections = sections;
  g.columns = columns;
  g.cellText = (r, c) => (c === "name" ? r.name : c === "type" ? r.type : c === "on" ? String(r.on) : "x");
  if (editable) g.editable = (_r, c) => (c === "on" ? "toggle" : c === "fixed" ? false : "text");
  const events: { type: string; detail: unknown }[] = [];
  for (const t of ["rg-commit", "rg-toggle", "rg-insert", "rg-delete", "rg-open", "rg-undo", "rg-redo", "rg-paste"]) g.addEventListener(t, (e) => events.push({ type: t, detail: (e as CustomEvent).detail }));
  document.body.append(g);
  await g.updateComplete;
  return { g, events, grid: g.querySelector<HTMLElement>('[role="treegrid"]')! };
}
const key = async (g: RgTreegrid<Row>, target: HTMLElement, k: string, mods: KeyboardEventInit = {}) => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  await g.updateComplete;
};
const input = (g: HTMLElement) => g.querySelector<HTMLInputElement>("input.rg-input");

describe("tree-grid editing", () => {
  it("Enter opens the active cell as an input with its text; Escape restores the cell", async () => {
    const { g, grid, events } = await mount();
    await key(g, grid, "Enter");
    expect(input(g)?.value).toBe("a");
    expect(input(g)?.closest('[role="gridcell"]')?.getAttribute("data-col")).toBe("name");
    await key(g, input(g)!, "Escape");
    expect(input(g)).toBeNull();
    expect(events).toEqual([]);
  });

  it("Enter commits a changed value once; an unchanged one sends nothing", async () => {
    const { g, grid, events } = await mount();
    await key(g, grid, "ArrowRight");
    await key(g, grid, "F2");
    input(g)!.value = "DInt";
    await key(g, input(g)!, "Enter");
    expect(events).toEqual([{ type: "rg-commit", detail: { rowId: "a", column: "type", value: "DInt", old: "Int" } }]);
    expect(input(g)).toBeNull();
    await key(g, grid, "Enter");
    await key(g, input(g)!, "Enter");
    expect(events).toHaveLength(1);
  });

  it("Tab commits and edits the next editable cell of the row", async () => {
    const { g, grid, events } = await mount();
    await key(g, grid, "Enter");
    input(g)!.value = "speed";
    await key(g, input(g)!, "Tab");
    expect(events[0]).toEqual({ type: "rg-commit", detail: { rowId: "a", column: "name", value: "speed", old: "a" } });
    expect(input(g)?.value).toBe("Int");
  });

  it("typing a character starts editing with it", async () => {
    const { g, grid } = await mount();
    await key(g, grid, "x");
    expect(input(g)?.value).toBe("x");
  });

  it("Space and a click flip a toggle cell; a fixed cell does not edit", async () => {
    const { g, grid, events } = await mount();
    await key(g, grid, "ArrowRight");
    await key(g, grid, "ArrowRight");
    await key(g, grid, " ");
    g.querySelector<HTMLElement>('[data-row="b"] [data-col="on"]')!.click();
    expect(events).toEqual([
      { type: "rg-toggle", detail: { rowId: "a", column: "on" } },
      { type: "rg-toggle", detail: { rowId: "b", column: "on" } },
    ]);
    await key(g, grid, "ArrowRight");
    await key(g, grid, "F2");
    expect(input(g)).toBeNull();
  });

  it("Insert, Delete, undo and redo are asked for", async () => {
    const { g, grid, events } = await mount();
    await key(g, grid, "Insert");
    await key(g, grid, "Delete");
    await key(g, grid, "z", { ctrlKey: true });
    await key(g, grid, "y", { ctrlKey: true });
    await key(g, grid, "Z", { ctrlKey: true, shiftKey: true });
    expect(events.map((e) => e.type)).toEqual(["rg-insert", "rg-delete", "rg-undo", "rg-redo", "rg-redo"]);
    expect(events[0]!.detail).toEqual({ rowId: "a" });
  });

  it("a paste on the grid hands over the clipboard text", async () => {
    const { grid, events } = await mount();
    const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    e.clipboardData = { getData: (t: string) => (t === "text/plain" ? "x\tInt" : "") };
    grid.dispatchEvent(e);
    expect(events).toEqual([{ type: "rg-paste", detail: { text: "x\tInt" } }]);
  });

  it("startEdit opens a cell from outside, selected", async () => {
    const { g } = await mount();
    g.startEdit("b", "name");
    await g.updateComplete;
    expect(input(g)?.value).toBe("b");
    expect(input(g)?.closest('[role="row"]')?.getAttribute("data-row")).toBe("b");
  });

  it("new rows arriving while a cell is open keep what was typed", async () => {
    const { g, grid } = await mount();
    await key(g, grid, "Enter");
    input(g)!.value = "typed";
    input(g)!.dispatchEvent(new Event("input", { bubbles: true }));
    g.sections = [{ ...sections[0]!, rows: [...sections[0]!.rows] }];
    await g.updateComplete;
    expect(input(g)?.value).toBe("typed");
  });

  it("the open cell's row is gone after new rows: the edit closes without a commit", async () => {
    const { g, grid, events } = await mount();
    await key(g, grid, "ArrowDown");
    await key(g, grid, "Enter");
    g.sections = [{ ...sections[0]!, rows: [sections[0]!.rows[0]!] }];
    await g.updateComplete;
    expect(input(g)).toBeNull();
    expect(events).toEqual([]);
  });

  it("a row that goes while its cell is open says so, with what was typed", async () => {
    const { g, grid } = await mount();
    const lost: unknown[] = [];
    g.addEventListener("rg-edit-lost", (e) => lost.push((e as CustomEvent).detail));
    await key(g, grid, "ArrowDown");
    await key(g, grid, "Enter");
    input(g)!.value = "typed";
    input(g)!.dispatchEvent(new Event("input", { bubbles: true }));
    g.sections = [{ ...sections[0]!, rows: [sections[0]!.rows[0]!] }];
    await g.updateComplete;
    expect(lost).toEqual([{ rowId: "b", column: "name", value: "typed" }]);
  });

  it("undo and redo work in a table without rows", async () => {
    const { g, grid, events } = await mount();
    g.sections = [{ id: "st", title: "Static", rows: [] }];
    await g.updateComplete;
    await key(g, grid, "z", { ctrlKey: true });
    expect(events.map((e) => e.type)).toEqual(["rg-undo"]);
  });

  it("without editable, Enter still opens the text and nothing edits", async () => {
    const { g, grid, events } = await mount(false);
    await key(g, grid, "Enter");
    await key(g, grid, "Insert");
    await key(g, grid, "x");
    expect(input(g)).toBeNull();
    expect(events.map((e) => e.type)).toEqual(["rg-open"]);
  });
});
