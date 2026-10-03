// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig } from "@rung/core";
import { pull } from "../src/pull.js";
import { mentions, renameObject } from "../src/rename.js";
import { FakeBridge } from "./fake-bridge.js";

const COUNTER = 'FUNCTION_BLOCK "Fx_Counter"\nBEGIN\n  ;\nEND_FUNCTION_BLOCK\n';
const DB = 'DATA_BLOCK "Fx_CounterDB"\n"Fx_Counter"\nBEGIN\nEND_DATA_BLOCK\n';
const MAIN = 'ORGANIZATION_BLOCK "Main"\nBEGIN\n  "Fx_CounterDB"(Pulse := TRUE);\nEND_ORGANIZATION_BLOCK\n';

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "rung-rename-"));
  const bridge = new FakeBridge()
    .add("plc:PLC_1/blocks/Drives/Fx_Counter", { content: COUNTER, blockType: "FB" })
    .add("plc:PLC_1/blocks/Fx_CounterDB", { form: "db", content: DB, blockType: "InstanceDB" })
    .add("plc:PLC_1/blocks/Main", { content: MAIN, blockType: "OB" });
  const config = defaultConfig(bridge.info.path, "V20", "fake");
  const state = await StateStore.open(root, { projectPath: bridge.info.path, tiaVersion: "V20", devices: ["PLC_1"] });
  await pull(root, bridge, state, { config });
  return { root, bridge, config, state };
}

describe("rung rename", () => {
  it("labels an unrelated block that was already inconsistent before the rename", async () => {
    const { root, bridge, config, state } = await setup();
    bridge.add("plc:PLC_1/blocks/Broken", { content: "// broken\n", isConsistent: false });
    await pull(root, bridge, state, { config });
    const r = await renameObject(root, bridge, state, config, "plc:PLC_1/blocks/Drives/Fx_Counter", "Fx_Pulse");
    expect(r.pull.warnings).toContainEqual(expect.objectContaining({ address: "plc:PLC_1/blocks/Broken", code: "INCONSISTENT", message: expect.stringContaining("already inconsistent before rename") }));
    await state.close();
  });
  it("renames in TIA, moves the file and brings back every file that named the old object", async () => {
    const { root, bridge, config, state } = await setup();
    mkdirSync(join(root, "tests", "drives"), { recursive: true });
    writeFileSync(join(root, "tests", "drives", "counter.test.yaml"), "block: Fx_Counter # the FB\ncases:\n  - steps:\n      - expect: { '\"Fx_Counter\".x': 1 }\n");
    // what an earlier pass said about the new name (a hand rename it held back) is answered by the rename
    mkdirSync(join(root, ".rung"), { recursive: true });
    writeFileSync(join(root, ".rung", "diagnostics.json"), JSON.stringify({ seq: 3, items: [{ address: "plc:PLC_1/blocks/Drives/Fx_Pulse", path: "plc/PLC_1/blocks/Drives/Fx_Pulse.scl", code: "LOOKS_LIKE_RENAME", severity: "error", message: "held back" }] }));
    const r = await renameObject(root, bridge, state, config, "plc:PLC_1/blocks/Drives/Fx_Counter", "Fx_Pulse");
    expect(JSON.parse(readFileSync(join(root, ".rung", "diagnostics.json"), "utf8")).items).toEqual([]);
    expect(readFileSync(join(root, "tests", "drives", "counter.test.yaml"), "utf8")).toBe("block: Fx_Pulse # the FB\ncases:\n  - steps:\n      - expect: { '\"Fx_Pulse\".x': 1 }\n");
    expect(r.users).toContain("tests/drives/counter.test.yaml");
    expect(r).toMatchObject({ from: "plc:PLC_1/blocks/Drives/Fx_Counter", to: "plc:PLC_1/blocks/Drives/Fx_Pulse", oldPath: "plc/PLC_1/blocks/Drives/Fx_Counter.scl", newPath: "plc/PLC_1/blocks/Drives/Fx_Pulse.scl" });
    expect(r.users).toContain("plc/PLC_1/blocks/Fx_CounterDB.db");
    expect(existsSync(join(root, "plc/PLC_1/blocks/Drives/Fx_Counter.scl"))).toBe(false);
    expect(readFileSync(join(root, "plc/PLC_1/blocks/Drives/Fx_Pulse.scl"), "utf8")).toContain('FUNCTION_BLOCK "Fx_Pulse"');
    // the instance DB names the FB: TIA changed its text without changing its fingerprint
    expect(readFileSync(join(root, "plc/PLC_1/blocks/Fx_CounterDB.db"), "utf8")).toContain('"Fx_Pulse"');
    expect(state.get("plc:PLC_1/blocks/Drives/Fx_Counter")).toBeUndefined();
    expect(state.get("plc:PLC_1/blocks/Drives/Fx_Pulse")?.status).toBe("synced");
    expect(bridge.renameCalls[0]!.rev).toMatch(/^fp:/);
    await state.close();
  });

  it("refuses when the file has changes TIA does not have yet, and touches nothing", async () => {
    const { root, bridge, config, state } = await setup();
    writeFileSync(join(root, "plc/PLC_1/blocks/Drives/Fx_Counter.scl"), COUNTER.replace(";", "#x := 1;"));
    await expect(renameObject(root, bridge, state, config, "plc:PLC_1/blocks/Drives/Fx_Counter", "Fx_Pulse")).rejects.toMatchObject({ code: "LOCAL_CHANGES" });
    expect(bridge.renameCalls).toEqual([]);
    await state.close();
  });

  it("finds uses in SCL, SD and SimaticML text", () => {
    expect(mentions('"Fx_Counter".Count', "Fx_Counter")).toBe(true);
    expect(mentions('<Component Name="Fx_Counter" />', "Fx_Counter")).toBe(true);
    expect(mentions('"Fx_CounterDB"(', "Fx_Counter")).toBe(false);
  });
});
