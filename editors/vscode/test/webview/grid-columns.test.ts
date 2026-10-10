// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { columnsMinWidth, columnsTemplate } from "../../src/webview/grid/types";

describe("tree-grid columns in a narrow panel", () => {
  const cols = [
    { key: "name", label: "Name", width: 220 },
    { key: "type", label: "Data type", width: 180 },
    { key: "retain", label: "Retain", width: 84 },
    { key: "comment", label: "Comment", width: 0 },
  ];
  it("lets names and types give way so the comment stays in view", () => {
    expect(columnsTemplate(cols)).toBe("minmax(121px, 220px) minmax(99px, 180px) minmax(80px, 84px) minmax(100px, 1fr)");
    expect(columnsMinWidth(cols)).toBe(121 + 99 + 80 + 100);
  });
});
