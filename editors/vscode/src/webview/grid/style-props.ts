// SPDX-License-Identifier: MIT
// Inline styles through the CSSOM only. The webview's CSP (style-src without 'unsafe-inline') refuses a style
// attribute written as text, which is what lit's styleMap does on its first render; setProperty is allowed.
import { noChange } from "lit";
import { Directive, directive, PartType, type AttributePart, type PartInfo } from "lit/directive.js";

class StyleProps extends Directive {
  private previous = new Set<string>();

  constructor(part: PartInfo) {
    super(part);
    if (part.type !== PartType.ATTRIBUTE || (part as { name?: string }).name !== "style") throw new Error("styleProps belongs in style=${…}");
  }

  render(_styles: Record<string, string | undefined>): typeof noChange {
    return noChange;
  }

  override update(part: AttributePart, [styles]: [Record<string, string | undefined>]): typeof noChange {
    const style = (part.element as HTMLElement).style;
    for (const name of this.previous) if (styles[name] == null) style.removeProperty(name);
    this.previous = new Set();
    for (const [name, value] of Object.entries(styles)) {
      if (value == null) continue;
      style.setProperty(name, value);
      this.previous.add(name);
    }
    return noChange;
  }
}

/** style=${styleProps({ "--rg-cols": "…", "min-width": "…" })}: property names as in CSS (kebab-case). */
export const styleProps = directive(StyleProps);
