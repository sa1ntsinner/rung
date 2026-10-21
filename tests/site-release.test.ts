// SPDX-License-Identifier: MIT
// The site names the version that is out: bump it with the packages.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync("packages/cli/package.json", "utf8")).version as string;
const site = readFileSync("site/index.html", "utf8");

describe("site", () => {
  it("shows the current version and links its release", () => {
    expect(site).toContain(`<p class="nm">${version}</p>`);
    expect(site).toContain(`releases/tag/v${version}"`);
    expect(site).toContain("CHANGELOG.md");
  });
});
