// @vitest-environment happy-dom
// SPDX-License-Identifier: MIT
// Styles reach an element through the CSSOM from the first render on: the webview's CSP refuses a style attribute
// written as text, and lit's styleMap writes one on its first render.
import { describe, it, expect, vi } from "vitest";
import { html, render } from "lit";
import { styleProps } from "../../src/webview/grid/style-props";

describe("styleProps", () => {
  it("sets custom properties and plain ones on the first render without writing the style attribute", () => {
    // a style attribute written as text, not by the CSSOM itself (happy-dom reflects setProperty into the attribute)
    let inCssom = false;
    const written: string[] = [];
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    const cssom = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (this: CSSStyleDeclaration, ...a: Parameters<typeof setProperty>) {
      inCssom = true;
      try {
        return setProperty.apply(this, a);
      } finally {
        inCssom = false;
      }
    });
    const setAttribute = Element.prototype.setAttribute;
    const attr = vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (this: Element, name: string, value: string) {
      if (name === "style" && !inCssom) written.push(value);
      return setAttribute.call(this, name, value);
    });
    const host = document.createElement("div");
    render(html`<div class="g" style=${styleProps({ "--rg-cols": "10px 1fr", "min-width": "120px" })}></div>`, host);
    const el = host.querySelector<HTMLElement>(".g")!;
    expect(el.style.getPropertyValue("--rg-cols")).toBe("10px 1fr");
    expect(el.style.getPropertyValue("min-width")).toBe("120px");
    expect(written).toEqual([]);
    attr.mockRestore();
    cssom.mockRestore();
  });

  it("updates changed values and removes dropped ones", () => {
    const host = document.createElement("div");
    const draw = (s: Record<string, string>) => render(html`<div class="g" style=${styleProps(s)}></div>`, host);
    draw({ width: "16px", "--a": "1" });
    draw({ width: "32px" });
    const el = host.querySelector<HTMLElement>(".g")!;
    expect(el.style.getPropertyValue("width")).toBe("32px");
    expect(el.style.getPropertyValue("--a")).toBe("");
  });
});
