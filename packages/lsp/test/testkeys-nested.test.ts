// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { nestedTestKeyEdits, type KeyEdit } from "../src/testkeys.js";
import { WorkspaceIndex } from "../src/workspace.js";
import { testModel } from "../src/testModel.js";
import { monitorServer } from "./monitorHarness.js";

it("resolves shared declarations in each test's PLC, including OB global paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-shared-testkeys-"));
  try {
    const index = new WorkspaceIndex();
    const cfg = 'TYPE "Cfg"\nSTRUCT\n Speed : Int;\nEND_STRUCT;\nEND_TYPE\n';
    const shared = pathToFileURL(join(root, "Cfg.udt")).href;
    index.set(shared, cfg, 0);
    for (const plc of ["PLC_1", "PLC_2"]) {
      await mkdir(join(root, "plc", plc, "blocks"), { recursive: true });
      const uri = (file: string) => pathToFileURL(join(root, "plc", plc, "blocks", file)).href;
      if (plc === "PLC_1") index.set(uri("Cfg.udt"), cfg, 0); // shadows the shared type
      index.set(uri("Motor.scl"), 'FUNCTION_BLOCK "Motor"\nVAR\n Cfg : "Cfg";\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', 0);
      index.set(uri("Plant.db"), 'DATA_BLOCK "Plant"\nVAR\n Cfg : "Cfg";\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n', 0);
      index.set(uri("Motor_DB.db"), 'DATA_BLOCK "Motor_DB"\n"Motor"\nBEGIN\nEND_DATA_BLOCK\n', 0);
      index.set(uri("Main.scl"), 'ORGANIZATION_BLOCK "Main"\nBEGIN\nEND_ORGANIZATION_BLOCK\n', 0);
      await mkdir(join(root, "tests", plc), { recursive: true });
      await writeFile(join(root, "tests", plc, "motor.test.yaml"), `block: Motor\ncases:\n  - name: local\n    steps:\n      - expect: { Cfg.Speed: 1 }\n`);
      await writeFile(join(root, "tests", plc, "main.test.yaml"), `block: Main\ncases:\n  - name: globals\n    steps:\n      - expect: { '"Plant".Cfg.Speed': 1, '"Motor_DB".Cfg.Speed': 1 }\n`);
    }
    const start = index.docs.get(shared)!.parsed!.blocks[0]!.vars[0]!.start;
    const edits = await nestedTestKeyEdits(root, index, { uri: shared, start }, "Target");
    expect([...edits.keys()].sort()).toEqual([join(root, "tests", "PLC_2", "main.test.yaml"), join(root, "tests", "PLC_2", "motor.test.yaml")]);
    expect([...edits.values()].map(e => e.length).sort()).toEqual([1, 2]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["UDT", "FB"])("renames test keys through a nested %s declaration", async kind => {
  const source = kind === "UDT"
    ? 'TYPE "Cfg"\nSTRUCT\n Speed : Int;\nEND_STRUCT;\nEND_TYPE\n'
    : 'FUNCTION_BLOCK "Cfg"\nVAR_OUTPUT\n Speed : Int;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n';
  const motor = 'FUNCTION_BLOCK "Motor"\nVAR\n Cfg : "Cfg";\n Items : Array[1..2] of "Cfg";\n Pid : Struct\n "idb_PI-Control" : "Cfg";\n END_STRUCT;\n Other : Struct\n Speed : Int;\n END_STRUCT;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n';
  const yaml = `block: Motor\nplc: PLC_1\nstubs:\n  Other: { Speed: 8 }\ncases:\n  - name: nested\n    steps:\n      - set: { Cfg.Speed: 1, 'Items[2].Speed': 2, 'Pid."idb_PI-Control".Speed': 3, Other.Speed: 4 }\n        expect: { Cfg.Speed: 1 }\n`;
  const s = await monitorServer(undefined, { setup: async root => {
    await writeFile(join(root, "plc", "PLC_1", "blocks", "Motor.scl"), motor);
    await writeFile(join(root, "plc", "PLC_1", "blocks", "Cfg.scl"), source);
    await mkdir(join(root, "plc", "PLC_2", "blocks"), { recursive: true });
    await writeFile(join(root, "plc", "PLC_2", "blocks", "Motor.scl"), motor);
    await writeFile(join(root, "plc", "PLC_2", "blocks", "Cfg.scl"), source);
    await mkdir(join(root, "tests", "PLC_2"), { recursive: true });
    await writeFile(join(root, "tests", "motor.test.yaml"), yaml);
    await writeFile(join(root, "tests", "other.test.yaml"), yaml.replace("plc: PLC_1", "plc: PLC_2"));
    await writeFile(join(root, "tests", "PLC_2", "motor.test.yaml"), yaml.replace("plc: PLC_1\n", ""));
  } });
  try {
    await s.open(s.uri, motor);
    const uri = pathToFileURL(join(s.root, "plc", "PLC_1", "blocks", "Cfg.scl")).href;
    await s.open(uri, source);
    const result = await s.client.sendRequest<{ changes: Record<string, KeyEdit[]> }>("textDocument/rename", {
      textDocument: { uri }, position: { line: 2, character: 2 }, newName: "Target-Speed",
    });
    const file = pathToFileURL(join(s.root, "tests", "motor.test.yaml")).href;
    const edits = result.changes[file] ?? [];
    expect(edits).toHaveLength(4);
    expect(Object.keys(result.changes).filter(u => u.endsWith(".yaml"))).toEqual([file]);
    const lines = yaml.split("\n");
    for (const e of [...edits].reverse()) {
      const n = e.range.start.line;
      lines[n] = lines[n]!.slice(0, e.range.start.character) + e.newText + lines[n]!.slice(e.range.end.character);
    }
    const model = testModel(lines.join("\n"));
    expect(model.errors).toEqual([]);
    expect(model.cases[0]!.steps[0]!.set!.entries.map(e => e.key)).toEqual([
      'Cfg."Target-Speed"', 'Items[2]."Target-Speed"', 'Pid."idb_PI-Control"."Target-Speed"', "Other.Speed",
    ]);
    expect(model.stubs[0]!.entries[0]!.key).toBe("Speed");
  } finally { await s.dispose(); }
});
