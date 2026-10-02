// SPDX-License-Identifier: MIT
import { describe as group, expect, it } from "vitest";
import { describe, parsePreview } from "../src/core/preview";

group("Preview Sync", () => {
  it("reads the CLI's JSON even after TIA Portal's own messages on stderr", () => {
    const out = 'TIA Portal: Project opened\n{\n  "plan": { "entries": [{ "address": "a", "path": "plc/PLC_1/blocks/Fx_A.scl", "action": "update" }], "compile": [] },\n  "writesOff": true\n}\n';
    expect(parsePreview(out)).toEqual({ plan: { entries: [{ address: "a", path: "plc/PLC_1/blocks/Fx_A.scl", action: "update" }], compile: [] }, writesOff: true });
    expect(parsePreview("rung: TIA_NOT_RUNNING")).toBeUndefined();
    expect(parsePreview("{ broken")).toBeUndefined();
  });

  it("says where each change goes in plain words", () => {
    const e = (action: Parameters<typeof describe>[0]["action"]) => describe({ address: "a", path: "plc/PLC_1/blocks/Fx_A.scl", action });
    expect(e("update")).toEqual({ label: "Fx_A.scl → TIA Portal", description: "your edit" });
    expect(e("export")).toEqual({ label: "TIA Portal → Fx_A.scl", description: "changed in TIA Portal" });
    expect(e("conflict").description).toMatch(/nothing is sent/);
    expect(e("pending-delete").description).toMatch(/rung confirm-delete/);
  });
});
