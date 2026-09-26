// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig } from "@rung/core";
import { pull } from "@rung/sync";
import { writeAgentsFile, BEGIN, END } from "../src/agents.js";
import { FakeBridge } from "../../sync/test/fake-bridge.js";

describe("AGENTS.md generator", () => {
  it("writes a project summary and keeps the user's own text on regeneration", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-agents-"));
    const b = new FakeBridge();
    b.add("plc:PLC_1/blocks/10_Drives/Fx_Motor", { content: 'FUNCTION_BLOCK "Fx_Motor"\nBEGIN\n  "Fx_Global".x := 1;\nEND_FUNCTION_BLOCK\n' });
    b.add("plc:PLC_1/blocks/10_Drives/Fx_Pump", { content: 'FUNCTION_BLOCK "Fx_Pump"\nBEGIN\n  "Fx_Global".x := 2;\nEND_FUNCTION_BLOCK\n' });
    b.add("plc:PLC_1/blocks/Fx_Global", { form: "db", content: 'DATA_BLOCK "Fx_Global"\nVAR\n  x : Int;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n' });
    b.add("plc:PLC_1/blocks/Fx_Safe", { form: "xml", isFailsafe: true, language: "F_LAD", content: "<x/>\n" });
    const state = await StateStore.open(root, { projectPath: b.info.path, tiaVersion: "V20", devices: [] });
    await pull(root, b, state, { config: defaultConfig(b.info.path, "V20", "fake") });
    await state.close();
    const text = await writeAgentsFile(root, b.info.path, "# Working here\n\nMy own notes.\n");
    expect(text).toContain("My own notes.");
    expect(text).toContain("PLCs: `PLC_1`");
    expect(text).toContain("Objects: 4 (1 db, 2 scl, 1 xml)");
    expect(text).toContain("`10_Drives` (2)");
    expect(text).toContain("`Fx_Global` (2 users)");
    expect(text).toContain("Naming prefixes in use: `Fx_` (3 blocks)");
    expect(text).toContain("`plc/PLC_1/blocks/Fx_Safe.xml`");
    writeFileSync(join(root, "AGENTS.md"), readFileSync(join(root, "AGENTS.md"), "utf8").replace("My own notes.", "Edited notes."));
    const again = await writeAgentsFile(root, b.info.path, "unused");
    expect(again.split(BEGIN)).toHaveLength(2);
    expect(again.split(END)).toHaveLength(2);
    expect(again).toContain("Edited notes.");
  });
});
