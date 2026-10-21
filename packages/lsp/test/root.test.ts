// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorServer } from "./monitorHarness.js";

describe("language server root", () => {
  it("indexes the folder the editor chose, not the window's first folder", async () => {
    // two rung workspaces in one window, both with a block Valve: the second is the one chosen
    const chosen = await mkdtemp(join(tmpdir(), "rung-lsp-chosen-"));
    const blocks = join(chosen, "plc", "PLC_1", "blocks");
    await mkdir(blocks, { recursive: true });
    await writeFile(join(blocks, "Valve.scl"), 'FUNCTION_BLOCK "Valve"\nBEGIN\nEND_FUNCTION_BLOCK\n');
    const s = await monitorServer(undefined, {
      initializationOptions: { monitor: false, root: chosen },
      setup: (first) => writeFile(join(first, "plc", "PLC_1", "blocks", "Valve.scl"), 'FUNCTION_BLOCK "Valve"\nBEGIN\nEND_FUNCTION_BLOCK\n'),
    });
    try {
      const found = await s.client.sendRequest<{ name: string; location: { uri: string } }[]>("workspace/symbol", { query: "Valve" });
      expect(found.map((x) => fileURLToPath(x.location.uri))).toEqual([join(blocks, "Valve.scl")]);
    } finally {
      await s.dispose();
      await rm(chosen, { recursive: true, force: true });
    }
  });
});
