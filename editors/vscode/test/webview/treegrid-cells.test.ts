// @vitest-environment happy-dom
// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from "vitest";
import { RgTreegrid } from "../../src/webview/grid/rg-treegrid";

describe("rg-treegrid: active cell ids and columns", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("gives different Unicode declaration cells different DOM IDs", async () => {
    const grid = new RgTreegrid();
    grid.columns = [{ key: "name", label: "Name" }];
    grid.sections = [{ id: "Input", title: "Input", rows: [{ id: "温度", depth: 0 }, { id: "压力", depth: 0 }] }];
    grid.cellText = row => row.id;
    document.body.append(grid);
    await grid.updateComplete;
    const surface = grid.querySelector('[role="treegrid"]')!;
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await grid.updateComplete;
    const id = surface.getAttribute("aria-activedescendant")!;
    expect(grid.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    expect(document.getElementById(id)?.closest('[role="row"]')?.getAttribute("data-row")).toBe("压力");
  });

  it("keeps the active cell inside the available columns after a preset shrinks", async () => {
    const grid = new RgTreegrid();
    grid.columns = Array.from({ length: 7 }, (_, i) => ({ key: String(i), label: String(i) }));
    grid.sections = [{ id: "Input", title: "Input", rows: [{ id: "Run", depth: 0 }] }];
    document.body.append(grid);
    await grid.updateComplete;
    const surface = grid.querySelector('[role="treegrid"]')!;
    surface.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await grid.updateComplete;
    grid.columns = grid.columns.slice(0, 4);
    await grid.updateComplete;
    expect(grid.querySelectorAll(".rg-active")).toHaveLength(1);
    expect(document.getElementById(surface.getAttribute("aria-activedescendant")!)).not.toBeNull();
  });
});
