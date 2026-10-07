// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultConfig } from "@rung/core";
import { pull } from "../src/pull.js";
import { syncOnce, type SyncBridge } from "../src/sync.js";
import { readTombstones } from "../src/tombstones.js";
import { FakeBridge } from "./fake-bridge.js";

const COUNTER = 'FUNCTION_BLOCK "Fx_Counter"\nBEGIN\n  ;\nEND_FUNCTION_BLOCK\n';
const DB = 'DATA_BLOCK "Fx_CounterDB"\n"Fx_Counter"\nBEGIN\nEND_DATA_BLOCK\n';
const OLD = "plc:PLC_1/blocks/Drives/Fx_Counter";
const FILE = "plc/PLC_1/blocks/Drives/Fx_Counter.scl";

async function setup(identities = true) {
  const root = mkdtempSync(join(tmpdir(), "rung-tia-rename-"));
  const bridge = new FakeBridge().add(OLD, { content: COUNTER, blockType: "FB" }).add("plc:PLC_1/blocks/Fx_CounterDB", { form: "db", content: DB, blockType: "InstanceDB" });
  bridge.identities = identities;
  const config = defaultConfig(bridge.info.path, "V20", "fake");
  const state = await StateStore.open(root, { projectPath: bridge.info.path, tiaVersion: "V20", devices: ["PLC_1"] });
  await pull(root, bridge, state, { config });
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "counter.test.yaml"), "block: Fx_Counter\ncases:\n  - steps:\n      - cycle: 1\n");
  return { root, bridge, config, state, read: (p: string) => readFileSync(join(root, p), "utf8") };
}

describe("an object renamed or moved in TIA Portal", () => {
  it("moves its file, brings back the files that name it and renames it in the tests (pull)", async () => {
    const { root, bridge, config, state, read } = await setup();
    expect(state.get(OLD)?.tiaId).toBe("id-1");
    await bridge.renameInTia(OLD, "plc:PLC_1/blocks/Drives/Fx_Pulse");
    const r = await pull(root, bridge, state, { config });
    expect(r.removed).toBe(0);
    expect(r.renamed).toEqual([{ from: OLD, to: "plc:PLC_1/blocks/Drives/Fx_Pulse", oldPath: FILE, newPath: "plc/PLC_1/blocks/Drives/Fx_Pulse.scl", tests: ["tests/counter.test.yaml"] }]);
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: "RENAMED_IN_TIA", message: expect.stringContaining("renamed from Fx_Counter in TIA Portal; its file moved here from " + FILE) }));
    expect(existsSync(join(root, FILE))).toBe(false);
    expect(read("plc/PLC_1/blocks/Drives/Fx_Pulse.scl")).toContain('"Fx_Pulse"');
    // TIA reports the instance DB unchanged, yet its text names the new block
    expect(read("plc/PLC_1/blocks/Fx_CounterDB.db")).toContain('"Fx_Pulse"');
    expect(read("tests/counter.test.yaml")).toMatch(/^block: Fx_Pulse$/m);
    expect(state.get("plc:PLC_1/blocks/Drives/Fx_Pulse")).toMatchObject({ tiaId: "id-1", path: "plc/PLC_1/blocks/Drives/Fx_Pulse.scl" });
    expect(state.get(OLD)).toBeUndefined();
    // the old file coming back with git (another branch) is the renamed block, not a new one
    expect(await readTombstones(root)).toContainEqual(expect.objectContaining({ address: OLD, path: FILE, to: "plc:PLC_1/blocks/Drives/Fx_Pulse" }));
    await state.close();
  });

  it("moved to another group: the file follows, nothing else changes", async () => {
    const { root, bridge, config, state, read } = await setup();
    await bridge.renameInTia(OLD, "plc:PLC_1/blocks/Motion/Fx_Counter");
    const r = await pull(root, bridge, state, { config });
    expect(r.renamed).toEqual([{ from: OLD, to: "plc:PLC_1/blocks/Motion/Fx_Counter", oldPath: FILE, newPath: "plc/PLC_1/blocks/Motion/Fx_Counter.scl", tests: [] }]);
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: "RENAMED_IN_TIA", message: expect.stringMatching(/^moved in TIA Portal/) }));
    expect(existsSync(join(root, FILE))).toBe(false);
    expect(read("tests/counter.test.yaml")).toMatch(/^block: Fx_Counter$/m);
    await state.close();
  });

  it("an edited old file is left to the person; a TIA Portal without identities deletes and creates as before", async () => {
    const edited = await setup();
    writeFileSync(join(edited.root, FILE), COUNTER.replace(";", "#x := 1;"));
    await edited.bridge.renameInTia(OLD, "plc:PLC_1/blocks/Drives/Fx_Pulse");
    const r = await pull(edited.root, edited.bridge, edited.state, { config: edited.config });
    expect(r.renamed).toBeUndefined();
    expect(existsSync(join(edited.root, FILE))).toBe(true);
    expect(existsSync(join(edited.root, "plc/PLC_1/blocks/Drives/Fx_Pulse.scl"))).toBe(true);
    await edited.state.close();

    const v19 = await setup(false);
    expect(v19.state.get(OLD)?.tiaId).toBeUndefined();
    await v19.bridge.renameInTia(OLD, "plc:PLC_1/blocks/Drives/Fx_Pulse");
    const r19 = await pull(v19.root, v19.bridge, v19.state, { config: v19.config });
    expect(r19.renamed).toBeUndefined();
    expect(r19.removed).toBe(1);
    await v19.state.close();
  });

  it("identity wins over a new object whose name differs only in letter case", async () => {
    const { root, bridge, config, state, read } = await setup();
    // listed before the renamed object: a new, unrelated fx_counter
    bridge.add("plc:PLC_1/blocks/Drives/fx_counter", { content: 'FUNCTION "fx_counter" : Void\nBEGIN\nEND_FUNCTION\n' });
    await bridge.renameInTia(OLD, "plc:PLC_1/blocks/Drives/Fx_Pulse");
    const r = await pull(root, bridge, state, { config });
    expect(r.renamed?.map((x) => x.to)).toEqual(["plc:PLC_1/blocks/Drives/Fx_Pulse"]);
    expect(state.get("plc:PLC_1/blocks/Drives/Fx_Pulse")?.tiaId).toBe("id-1");
    // on Windows fx_counter.scl and the old Fx_Counter.scl are one file name: the new block comes on the next pass
    await pull(root, bridge, state, { config });
    expect(state.get("plc:PLC_1/blocks/Drives/fx_counter")?.tiaId).toBe("id-3");
    expect(read("plc/PLC_1/blocks/Drives/Fx_Pulse.scl")).toContain('"Fx_Pulse"');
    await state.close();
  });

  it("an edited old file stays, and the files that name the object still come back with its new name", async () => {
    const { root, bridge, config, state, read } = await setup();
    writeFileSync(join(root, FILE), COUNTER.replace(";", "#x := 1;"));
    await bridge.renameInTia(OLD, "plc:PLC_1/blocks/Drives/Fx_Pulse");
    await pull(root, bridge, state, { config });
    expect(read("plc/PLC_1/blocks/Fx_CounterDB.db")).toContain('"Fx_Pulse"');
    await state.close();
  });

  it("a move whose first export fails moves the file on a later pass", async () => {
    const { root, bridge, config, state } = await setup();
    const to = "plc:PLC_1/blocks/Motion/Fx_Counter";
    await bridge.renameInTia(OLD, to);
    bridge.failExport.add(to);
    await syncOnce(root, bridge as unknown as SyncBridge, state, { config });
    bridge.failExport.delete(to);
    await syncOnce(root, bridge as unknown as SyncBridge, state, { config });
    expect(state.get(to)?.path).toBe("plc/PLC_1/blocks/Motion/Fx_Counter.scl");
    expect(existsSync(join(root, "plc/PLC_1/blocks/Motion/Fx_Counter.scl"))).toBe(true);
    expect(existsSync(join(root, FILE))).toBe(false);
    await state.close();
  });

  it("rung sync and rung watch follow it too", async () => {
    const { root, bridge, config, state, read } = await setup();
    await bridge.renameInTia(OLD, "plc:PLC_1/blocks/Drives/Fx_Pulse");
    const r = await syncOnce(root, bridge as unknown as SyncBridge, state, { config });
    expect(r.removed).toBe(0);
    expect(r.warnings).toContainEqual(expect.objectContaining({ address: "plc:PLC_1/blocks/Drives/Fx_Pulse", code: "RENAMED_IN_TIA" }));
    expect(existsSync(join(root, FILE))).toBe(false);
    expect(read("plc/PLC_1/blocks/Drives/Fx_Pulse.scl")).toContain('"Fx_Pulse"');
    expect(read("plc/PLC_1/blocks/Fx_CounterDB.db")).toContain('"Fx_Pulse"');
    expect(read("tests/counter.test.yaml")).toMatch(/^block: Fx_Pulse$/m);
    expect(await readTombstones(root)).toContainEqual(expect.objectContaining({ address: OLD, to: "plc:PLC_1/blocks/Drives/Fx_Pulse" }));
    await state.close();
  });
});
