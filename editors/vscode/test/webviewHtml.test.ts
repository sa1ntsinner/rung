// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { nonce, webviewHtml } from "../src/host/webviewHtml";

describe("webviewHtml", () => {
  it("locks everything down to local nonce scripts and styles", () => {
    const n = nonce();
    const html = webviewHtml({ cspSource: "vscode-resource:", nonce: n, script: "s.js", styles: ["c.css", "t.css"], title: "Declarations" });
    expect(html).toContain(`default-src 'none'`);
    expect(html).toContain(`script-src 'nonce-${n}'`);
    expect(html).toContain(`<script nonce="${n}" src="s.js"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="c.css">`);
    expect(html).not.toMatch(/https?:\/\//);
    expect(n).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it("escapes the title", () => {
    expect(webviewHtml({ cspSource: "x", nonce: "n", script: "s", styles: [], title: "<b>&" })).toContain("<title>&lt;b&gt;&amp;</title>");
  });
});
