// @vitest-environment happy-dom
// SPDX-License-Identifier: MIT
// The test table: cases left, the selected case's steps right; each change in place is one checked message, a run
// goes to the test explorer, and the last run shows on the rows it is about.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { TestFileModel, TestHostToView, TestViewToHost } from "../../src/protocol/tests";
import type { RgTreegrid } from "../../src/webview/grid/rg-treegrid";

const posted: TestViewToHost[] = [];
beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: TestViewToHost) => posted.push(m), getState: () => undefined, setState: () => {} });
});
beforeEach(() => {
  posted.length = 0;
});

const R = { start: 0, end: 1 };
const entry = (key: string, value: string) => ({ key, value, keyRange: R, valueRange: R, pairRange: R });
const FILE: TestFileModel = {
  uri: "file:///w/tests/m.test.yaml",
  version: 5,
  symbols: [{ name: "Start", type: "Bool", section: "Input" }],
  problems: [{ case: 0, step: 2, part: "expect", key: "Runing", message: "Fx_Motor has no Runing (did you mean Running?)" }],
  model: {
    block: { value: "Fx_Motor", range: R },
    stubs: [],
    errors: [],
    cases: [
      {
        index: 0,
        name: { value: "starts", range: R },
        range: R,
        line: 2,
        steps: [
          { index: 0, flow: false, range: R, line: 4, set: { flow: true, range: R, keyRange: R, entries: [entry("Start", "true")] }, unknown: [] },
          { index: 1, flow: false, range: R, line: 5, cycle: { value: "1", range: R, keyRange: R }, unknown: [] },
          { index: 2, flow: false, range: R, line: 6, expect: { flow: true, range: R, keyRange: R, entries: [entry("Runing", "true")] }, unknown: [] },
        ],
      },
      { index: 1, name: { value: "stops", range: R }, range: R, line: 8, steps: [{ index: 0, flow: false, range: R, line: 10, cycle: { value: "1", range: R, keyRange: R }, unknown: [] }] },
    ],
  },
};

const grid = (v: HTMLElement) => v.querySelector("rg-treegrid") as unknown as RgTreegrid & HTMLElement;
const send = async (v: HTMLElement & { updateComplete: Promise<unknown> }, m: TestHostToView) => {
  window.dispatchEvent(new MessageEvent("message", { data: m }));
  await v.updateComplete;
  await grid(v)?.updateComplete;
};
async function mount() {
  const { RgTests } = await import("../../src/webview/tests/view");
  document.body.innerHTML = "";
  const v = new RgTests();
  document.body.append(v);
  await send(v, { v: 1, kind: "model", file: FILE, context: { file: "tests/m.test.yaml", dirty: false } });
  posted.length = 0;
  return v;
}
const cell = (v: HTMLElement, rowId: string, col: string) => v.querySelector<HTMLElement>(`[data-row="${CSS.escape(rowId)}"] [data-col="${col}"]`)!;
const key = async (v: HTMLElement & { updateComplete: Promise<unknown> }, target: Element, k: string, mods: KeyboardEventInit = {}) => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  await grid(v).updateComplete;
  await v.updateComplete;
};
const edit = async (v: HTMLElement & { updateComplete: Promise<unknown> }, rowId: string, col: string, value: string) => {
  cell(v, rowId, col).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await grid(v).updateComplete;
  const input = v.querySelector<HTMLInputElement>("input.rg-input")!;
  input.value = value;
  await key(v, input, "Enter");
};

describe("test table", () => {
  it("lists the cases and the selected case's steps, each name under its step", async () => {
    const v = await mount();
    expect([...v.querySelectorAll(".rg-case-name")].map((x) => x.textContent)).toEqual(["starts", "stops"]);
    expect([...v.querySelectorAll('[role="row"][aria-level="1"] [data-col="label"]')].map((x) => x.getAttribute("aria-label"))).toEqual(["Step: 1  Set", "Step: 2  Run", "Step: 3  Expect"]);
    expect(cell(v, "s1", "value").textContent).toContain("1 cycle");
    expect(cell(v, "s0/set/Start", "value").textContent!.trim()).toBe("true");
  });

  it("a value, a name and a cycle count are one edit each, against the version shown", async () => {
    const v = await mount();
    await edit(v, "s0/set/Start", "value", "false");
    await edit(v, "s2/expect/Runing", "name", "Running");
    await edit(v, "s1", "value", "3");
    expect(posted).toEqual([
      { v: 1, kind: "edit", req: 1, uri: FILE.uri, version: 5, op: { op: "setValue", case: 0, step: 0, part: "set", key: "Start", value: "false" } },
      { v: 1, kind: "edit", req: 2, uri: FILE.uri, version: 5, op: { op: "setKey", case: 0, step: 2, part: "expect", key: "Runing", newKey: "Running" } },
      { v: 1, kind: "edit", req: 3, uri: FILE.uri, version: 5, op: { op: "setRun", case: 0, step: 1, kind: "cycle", value: "3" } },
    ]);
  });

  it("Insert picks a name for the step; Delete removes a name or a step; Alt+Up moves a step", async () => {
    const v = await mount();
    const g = v.querySelector('[role="treegrid"]')!;
    cell(v, "s2/expect/Runing", "name").click();
    await key(v, g, "Insert");
    await key(v, g, "Delete");
    cell(v, "s1", "label").click();
    await key(v, g, "ArrowUp", { altKey: true });
    await key(v, g, "Delete");
    expect(posted.map((m) => (m.kind === "edit" ? m.op : m))).toEqual([
      { v: 1, kind: "pick", req: 1, uri: FILE.uri, version: 5, case: 0, step: 2, part: "expect" },
      { op: "removeEntry", case: 0, step: 2, part: "expect", key: "Runing" },
      { op: "moveStep", case: 0, step: 1, by: -1 },
      { op: "removeStep", case: 0, step: 1 },
    ]);
  });

  it("a name the block does not have is marked with the reason", async () => {
    const v = await mount();
    expect(cell(v, "s2/expect/Runing", "name").querySelector(".rg-problem")!.getAttribute("title")).toBe("Fx_Motor has no Runing (did you mean Running?)");
  });

  it("cases: select, add with a free name, rename in place, run one", async () => {
    const v = await mount();
    v.querySelector<HTMLElement>('[data-case="1"]')!.click();
    await v.updateComplete;
    expect(v.querySelector(".rg-band-title")!.textContent).toBe("stops");
    v.querySelector<HTMLButtonElement>('[data-action="add-case"]')!.click();
    v.querySelector<HTMLElement>('[data-case="1"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await v.updateComplete;
    const input = v.querySelector<HTMLInputElement>(".rg-case-input")!;
    input.value = "stops at once";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    v.querySelector<HTMLButtonElement>('[data-case="0"] [data-action="run"]')!.click();
    expect(posted.map((m) => (m.kind === "edit" ? m.op : m))).toEqual([{ op: "addCase", name: "new case" }, { op: "renameCase", case: 1, name: "stops at once" }, { v: 1, kind: "run", case: 0 }]);
  });

  it("the last run shows on the case and on the expectation that failed", async () => {
    const v = await mount();
    await send(v, { v: 1, kind: "runs", running: [1], runs: [{ index: 0, passed: false, failures: [{ step: 3, name: "Runing", expected: true, actual: false }] }] });
    expect(v.querySelector('[data-case="0"] .codicon-error')).not.toBeNull();
    expect(v.querySelector('[data-case="1"] .codicon-loading')).not.toBeNull();
    expect(cell(v, "s2/expect/Runing", "result").textContent).toContain("got false");
  });

  it("a YAML error is said with its line and a way to the text", async () => {
    const v = await mount();
    await send(v, { v: 1, kind: "model", file: { ...FILE, model: { ...FILE.model, errors: [{ message: "Missing , or }", line: 4, column: 2 }] } }, context: { file: "f", dirty: false } });
    expect(v.textContent).toContain("line 5: Missing , or }");
    v.querySelector<HTMLButtonElement>(".rg-state .rg-primary")!.click();
    expect(posted).toEqual([{ v: 1, kind: "openText", line: 4 }]);
  });
});
