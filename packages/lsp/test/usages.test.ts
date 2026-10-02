// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, usagesAt } from "../src/index.js";

const u = (p: string) => `file:///w/plc/PLC_1/blocks/${p}`;
const DB = 'DATA_BLOCK "Line_DB"\nVERSION : 0.1\n   VAR\n      Speed : Real;\n      Running : Bool;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n';
const SETTER = 'FUNCTION "Set_Speed" : Void\n   VAR_INPUT\n      v : Real;\n   END_VAR\nBEGIN\n   "Line_DB".Speed := #v;\nEND_FUNCTION\n';
const READER = 'FUNCTION_BLOCK "Fx_Drive"\n   VAR_OUTPUT\n      Out : Real;\n   END_VAR\nBEGIN\n   #Out := "Line_DB".Speed * 2.0;\n   "Line_DB".Running := #Out > 0.0;\nEND_FUNCTION_BLOCK\n';
const MAIN = 'ORGANIZATION_BLOCK "Main"\nBEGIN\n   "Set_Speed"(v := 1500.0);\nEND_ORGANIZATION_BLOCK\n';

describe("usagesAt: who writes and who reads it", () => {
  const index = new WorkspaceIndex();
  index.set(u("Line_DB.db"), DB, 0);
  index.set(u("Set_Speed.scl"), SETTER, 0);
  index.set(u("Fx_Drive.scl"), READER, 0);
  index.set(u("Main.scl"), MAIN, 0);

  it("splits the uses of a DB member into writes and reads, with the block and where a writer is called from", () => {
    const at = READER.indexOf("Speed * 2.0");
    const r = usagesAt(index, u("Fx_Drive.scl"), at);
    expect(r.writes.map((w) => [w.uri, w.block])).toEqual([[u("Set_Speed.scl"), "Set_Speed"]]);
    expect(r.writes[0]!.calledFrom).toEqual([{ block: "Main", uri: u("Main.scl"), start: MAIN.indexOf('"Set_Speed"') }]);
    expect(r.reads.map((x) => [x.uri, x.block])).toEqual([[u("Fx_Drive.scl"), "Fx_Drive"]]);
  });

  it("knows a member written in the same block it is read in", () => {
    const r = usagesAt(index, u("Fx_Drive.scl"), READER.indexOf("Running :="));
    expect(r.writes.map((w) => w.block)).toEqual(["Fx_Drive"]);
    expect(r.reads).toEqual([]);
  });
});
