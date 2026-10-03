// @vitest-environment happy-dom
// SPDX-License-Identifier: MIT
// The shared tree-grid: treegrid roles, collapsed children, arrow keys, Enter and what a screen reader hears.
import { describe, it, expect, beforeEach } from "vitest";
import { RgTreegrid } from "../../src/webview/grid/rg-treegrid";
import type { GridColumn, GridRow, GridSection } from "../../src/webview/grid/types";

interface Row extends GridRow {
  name: string;
  type: string;
  children?: Row[];
}

const sections: GridSection<Row>[] = [
  { id: "in", title: "Input", rows: [{ id: "Start", depth: 0, name: "Start", type: "Bool" }] },
  {
    id: "st",
    title: "Static",
    note: "RETAIN",
    rows: [
      { id: "Settings", depth: 0, name: "Settings", type: "Struct", children: [{ id: "Settings/Speed", depth: 1, name: "Speed", type: "Real" }] },
      { id: "Delay", depth: 0, name: "Delay", type: "Time" },
    ],
  },
];
const columns: GridColumn[] = [
  { key: "name", label: "Name", mono: true, width: 200 },
  { key: "type", label: "Type", tooltip: "Data type", mono: true, width: 0 },
];

async function mount() {
  document.body.innerHTML = "";
  const g = new RgTreegrid<Row>();
  g.sections = sections;
  g.columns = columns;
  g.cellText = (r, c) => (c === "name" ? r.name : r.type);
  document.body.append(g);
  await g.updateComplete;
  return g;
}
const key = async (g: RgTreegrid<Row>, k: string) => {
  g.querySelector<HTMLElement>('[role="treegrid"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  await g.updateComplete;
};
const dataRows = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>('[role="row"][aria-level]')];
const active = (g: HTMLElement) => g.querySelector<HTMLElement>('[role="row"][aria-selected="true"]');

describe("rg-treegrid", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("draws treegrid roles, section bands and collapsed children", async () => {
    const g = await mount();
    expect(g.querySelector('[role="treegrid"]')!.getAttribute("aria-rowcount")).toBe("5");
    expect(dataRows(g).map((r) => r.getAttribute("aria-level"))).toEqual(["1", "1", "1"]);
    expect(g.querySelectorAll(".rg-band").length).toBe(2);
    expect(g.querySelector(".rg-band")!.textContent).toContain("Input");
    const settings = dataRows(g).find((r) => r.dataset.row === "Settings")!;
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    expect(dataRows(g).some((r) => r.dataset.row === "Settings/Speed")).toBe(false);
  });

  it("arrows move, Right opens a struct and enters it, Left goes back to the parent", async () => {
    const g = await mount();
    expect(active(g)!.dataset.row).toBe("Start");
    await key(g, "ArrowDown");
    expect(active(g)!.dataset.row).toBe("Settings");
    await key(g, "ArrowRight");
    expect(dataRows(g).some((r) => r.dataset.row === "Settings/Speed")).toBe(true);
    await key(g, "ArrowRight");
    expect(active(g)!.dataset.row).toBe("Settings/Speed");
    await key(g, "ArrowLeft");
    expect(active(g)!.dataset.row).toBe("Settings");
    await key(g, "ArrowLeft");
    expect(dataRows(g).some((r) => r.dataset.row === "Settings/Speed")).toBe(false);
  });

  it("Enter opens the active cell; End and Home move between columns", async () => {
    const g = await mount();
    const opened: unknown[] = [];
    g.addEventListener("rg-open", (e) => opened.push((e as CustomEvent).detail));
    await key(g, "End");
    await key(g, "Enter");
    await key(g, "Home");
    await key(g, "Enter");
    expect(opened).toEqual([
      { rowId: "Start", column: "type" },
      { rowId: "Start", column: "name" },
    ]);
  });

  it("cells carry their column's long name for screen readers", async () => {
    const g = await mount();
    const cell = g.querySelector('[data-row="Start"] [data-col="type"]')!;
    expect(cell.getAttribute("role")).toBe("gridcell");
    expect(cell.getAttribute("aria-label")).toBe("Data type: Bool");
  });
});
