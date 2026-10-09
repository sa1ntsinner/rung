// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ESM module without types
import { checkFiles, listFiles } from "../../tools/lint/spdx-headers.mjs";

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "spdx-"));
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), c); }
  return root;
}

describe("spdx lint", () => {
  it("does not relabel generated editor distribution dependencies", () => {
    const root = repo({ "editors/vscode/rung/source/S7CommPlusDriver/Driver.cs": "// LGPL-3.0-or-later\n" });
    expect(checkFiles(root, listFiles(root))).toEqual([]);
  });
  it("flags a core file without header", () => {
    const root = repo({ "packages/core/src/x.ts": "export const x = 1;\n" });
    expect(checkFiles(root, listFiles(root))).toEqual(["packages/core/src/x.ts: expected SPDX-License-Identifier: BUSL-1.1"]);
  });
  it("accepts correct headers and MIT client", () => {
    const root = repo({
      "packages/core/src/x.ts": "// SPDX-License-Identifier: BUSL-1.1\nexport const x = 1;\n",
      "packages/bridge-client/src/y.ts": "// SPDX-License-Identifier: MIT\n",
      "bridge/src/A.cs": "﻿// SPDX-License-Identifier: BUSL-1.1\n",
    });
    expect(checkFiles(root, listFiles(root))).toEqual([]);
  });
  it("rejects the wrong license for the directory", () => {
    const root = repo({ "packages/bridge-client/src/y.ts": "// SPDX-License-Identifier: BUSL-1.1\n" });
    expect(checkFiles(root, listFiles(root))).toHaveLength(1);
  });
});
