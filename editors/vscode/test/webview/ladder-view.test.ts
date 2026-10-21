// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
it("describes a ladder network and opens operands with the keyboard", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage }));
  const { RgLadder } = await import("../../src/webview/ladder/view");
  const view = new RgLadder(); document.body.append(view);
  view.block = { name: "Motor", type: "FB", language: "LAD", title: "", comment: "", networks: [{ index: 1, title: "Start motor", comment: "", language: "LAD", rung: [
    { k: "par", merge: true, branches: [[{ k: "contact", operand: "Start", negated: false }], [{ k: "contact", operand: "Run", negated: false }]] },
    { k: "contact", operand: "Stop", negated: true }, { k: "coil", operand: "Run", kind: "", negated: false },
  ] }] };
  await view.updateComplete;
  const network = view.querySelector(".lad-svg")!;
  expect(network.getAttribute("role")).toBe("group");
  expect(network.getAttribute("aria-label")).toContain("(Start or Run), and not Stop, and coil Run");
  const operand = view.querySelector<SVGElement>(".lad-operand[tabindex='0']")!;
  expect(operand.getAttribute("role")).toBe("link");
  operand.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(postMessage).toHaveBeenCalledWith({ kind: "operand", name: "Start" });
  view.remove(); vi.unstubAllGlobals();
});
