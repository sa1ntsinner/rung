// @vitest-environment happy-dom
// SPDX-License-Identifier: MIT
import { beforeAll, expect, it } from "vitest";
import type { DeclModel } from "../../src/protocol/declarations";
import type { RgTreegrid } from "../../src/webview/grid/rg-treegrid";

let saved: unknown;
beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: () => {}, getState: () => saved, setState: (state: unknown) => { saved = state; },
  });
});

const ranges = { whole: { start: 0, end: 1 }, name: { start: 0, end: 1 }, type: { start: 0, end: 1 } };
const attrs = { accessible: { value: true, explicit: false }, visible: { value: true, explicit: false }, writable: { value: true, explicit: false }, setpoint: { value: false, explicit: false } };
const model: DeclModel = {
  uri: "file:///Motor.scl", version: 1, editable: true, unavailable: [],
  sections: [{ id: "Static-0", title: "Static", keyword: "VAR", modifiers: [], range: { start: 0, end: 1 }, rows: [{
    id: "Settings", depth: 0, name: "Settings", type: "Struct", kind: "struct", attrs, hmi: true, other: [], ranges,
    children: [{ id: "Settings/Speed", depth: 1, name: "Speed", type: "Real", kind: "plain", attrs, hmi: true, other: [], ranges }],
  }] }],
};

it("keeps ancestors open after a host cursor reveal selects a nested declaration", async () => {
  const { RgDeclarations } = await import("../../src/webview/declarations/view");
  document.body.innerHTML = "";
  const view = new RgDeclarations();
  document.body.append(view);
  window.dispatchEvent(new MessageEvent("message", { data: { v: 1, kind: "model", model, context: { file: "Motor.scl", pinned: false, dirty: false } } }));
  await view.updateComplete;
  const grid = view.querySelector<RgTreegrid>("rg-treegrid")!;
  await grid.updateComplete;
  window.dispatchEvent(new MessageEvent("message", { data: { v: 1, kind: "reveal", rowId: "Settings/Speed" } }));
  await view.updateComplete;
  await grid.updateComplete;
  await view.updateComplete;
  await grid.updateComplete;
  expect(grid.querySelector('[data-row="Settings/Speed"]')).not.toBeNull();
  expect(grid.querySelector('[aria-selected="true"]')?.getAttribute("data-row")).toBe("Settings/Speed");
});
