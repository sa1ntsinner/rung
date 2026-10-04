// @vitest-environment happy-dom
// SPDX-License-Identifier: MIT
// The declarations view: what it draws from a model, its column presets and filter, the inspector, and the only
// messages it sends.
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import type { DeclModel, ViewToHost } from "../../src/protocol/declarations";

const posted: ViewToHost[] = [];
let saved: unknown;
beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: ViewToHost) => posted.push(m),
    getState: () => saved,
    setState: (s: unknown) => (saved = s),
  });
});

const attr = (value: boolean, explicit = false) => ({ value, explicit });
const ranges = { whole: { start: 0, end: 1 }, name: { start: 0, end: 1 }, type: { start: 0, end: 1 } };
const model: DeclModel = {
  uri: "file:///w/plc/PLC_1/blocks/Line/Fx_Motor.scl",
  version: 4,
  block: { name: "Fx_Motor", kind: "FB", range: { start: 0, end: 1 } },
  editable: true,
  unavailable: [],
  sections: [
    { id: "Input-0", title: "Input", keyword: "VAR_INPUT", modifiers: [], range: { start: 0, end: 1 }, rows: [{ id: "Start", depth: 0, name: "Start", type: "Bool", kind: "plain", comment: "push button", attrs: { accessible: attr(true), visible: attr(true), writable: attr(true), setpoint: attr(false) }, hmi: true, other: [], ranges }] },
    {
      id: "Static-1",
      title: "Static",
      keyword: "VAR",
      modifiers: ["RETAIN"],
      range: { start: 0, end: 1 },
      rows: [
        {
          id: "Settings",
          depth: 0,
          name: "Settings",
          type: "Struct",
          kind: "struct",
          attrs: { accessible: attr(true), visible: attr(true), writable: attr(false, true), setpoint: attr(false) },
          hmi: true,
          other: [],
          ranges,
          children: [{ id: "Settings/Speed", depth: 1, name: "Speed", type: "Real", kind: "plain", start: "1500.0", attrs: { accessible: attr(true), visible: attr(true), writable: attr(true), setpoint: attr(true, true) }, hmi: true, other: [{ key: "Foo", value: "x" }], ranges }],
        },
      ],
    },
  ],
};

async function mount() {
  const { RgDeclarations } = await import("../../src/webview/declarations/view");
  document.body.innerHTML = "";
  const v = new RgDeclarations();
  document.body.append(v);
  window.dispatchEvent(new MessageEvent("message", { data: { v: 1, kind: "model", model, context: { plc: "PLC_1", file: "plc/PLC_1/blocks/Line/Fx_Motor.scl", dirty: true, pinned: false } } }));
  await v.updateComplete;
  await (v.querySelector("rg-treegrid") as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return v;
}
const headers = (v: HTMLElement) => [...v.querySelectorAll('[role="columnheader"]')].map((h) => h.textContent!.trim());

describe("declarations view", () => {
  beforeEach(() => {
    posted.length = 0;
    saved = undefined;
  });

  it("says it is ready, then draws the block, its sections and the document state", async () => {
    const v = await mount();
    expect(posted[0]).toEqual({ v: 1, kind: "ready" });
    expect(v.querySelector(".rg-title-name")!.textContent).toBe("Fx_Motor");
    expect(v.querySelector(".rg-kind")!.textContent).toBe("FB");
    expect(v.querySelector(".rg-crumbs")!.textContent).toContain("PLC_1");
    expect([...v.querySelectorAll(".rg-band:not(.rg-band-ghost) .rg-band-title")].map((b) => b.textContent)).toEqual(["Input", "Static"]);
    expect(v.querySelector(".rg-band-note")!.textContent).toBe("RETAIN");
    expect(v.querySelector(".rg-status")!.textContent).toContain("Edited, not saved");
  });

  it("column presets: code by default, HMI access shows the four attributes", async () => {
    const v = await mount();
    expect(headers(v)).toEqual(["Name", "Data type", "Default value", "Comment"]);
    (v.querySelector('[data-preset="hmi"]') as HTMLElement).click();
    await v.updateComplete;
    expect(headers(v)).toEqual(["Name", "Data type", "Accessible", "Writable", "Visible", "Setpoint", "Comment"]);
    expect(saved).toMatchObject({ preset: "hmi" });
  });

  it("an explicit attribute and TIA's default read differently", async () => {
    const v = await mount();
    (v.querySelector('[data-preset="hmi"]') as HTMLElement).click();
    await v.updateComplete;
    const writable = v.querySelector('[data-row="Settings"] [data-col="writable"]')!;
    expect(writable.getAttribute("aria-label")).toBe("Writable from HMI/OPC UA: No");
    const accessible = v.querySelector('[data-row="Settings"] [data-col="accessible"]')!;
    expect(accessible.getAttribute("aria-label")).toBe("Accessible from HMI/OPC UA: Yes (TIA default)");
  });

  it("the filter keeps matching members and the structs around them", async () => {
    const v = await mount();
    const input = v.querySelector<HTMLInputElement>(".rg-filter input")!;
    input.value = "speed";
    input.dispatchEvent(new Event("input"));
    await v.updateComplete;
    await (v.querySelector("rg-treegrid") as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const rows = [...v.querySelectorAll<HTMLElement>('[role="row"][aria-level]')].map((r) => r.dataset.row);
    expect(rows).toEqual(["Settings", "Settings/Speed"]);
  });

  it("the inspector shows the selected row; its actions send only known messages", async () => {
    const v = await mount();
    const grid = v.querySelector("rg-treegrid") as unknown as HTMLElement & { reveal(id: string): void; updateComplete: Promise<unknown> };
    grid.reveal("Settings/Speed");
    await grid.updateComplete;
    await v.updateComplete;
    const insp = v.querySelector(".rg-inspector")!;
    expect(insp.querySelector(".rg-insp-name")!.textContent).toBe("Speed");
    expect(insp.textContent).toContain("Settings / Speed");
    expect(insp.textContent).toContain("1500.0");
    expect(insp.textContent).toContain("Foo");
    (insp.querySelector('[data-action="usages"]') as HTMLElement).click();
    (insp.querySelector('[data-action="text"]') as HTMLElement).click();
    expect(posted.slice(1)).toEqual([
      { v: 1, kind: "usages", rowId: "Settings/Speed" },
      { v: 1, kind: "open", rowId: "Settings/Speed", target: "name" },
    ]);
  });

  it("a part the parser could not read is said once, with a way to the text", async () => {
    const v = await mount();
    window.dispatchEvent(new MessageEvent("message", { data: { v: 1, kind: "model", model: { ...model, unavailable: [{ start: 5, end: 9 }] }, context: { file: "f.scl", dirty: false, pinned: false } } }));
    await v.updateComplete;
    expect(v.querySelector(".rg-notice")!.textContent).toContain("could not be read");
  });

  it("states without a model: loading and no language server", async () => {
    const v = await mount();
    window.dispatchEvent(new MessageEvent("message", { data: { v: 1, kind: "state", state: "noServer" } }));
    await v.updateComplete;
    expect(v.querySelector(".rg-state")!.textContent).toContain("language server is not running");
  });
});
