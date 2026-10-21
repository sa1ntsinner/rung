// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceIndex, diagnostics, uriOf } from "@rung/lsp";
import { main } from "../src/main.js";

const MANY = `// a library as one source
TYPE "udt_timer"
VERSION : 0.1
   STRUCT
      running : Bool;
   END_STRUCT;
END_TYPE

DATA_BLOCK "TimerDB"
VERSION : 0.1
   VAR
      timers : Array[0..3] of "udt_timer";
   END_VAR
BEGIN
END_DATA_BLOCK

// starts a timer
FUNCTION "TimerStart" : Void
VERSION : 0.1
BEGIN
   "TimerDB".timers[0].running := TRUE;
END_FUNCTION
`;

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "rung-split-"));
  mkdirSync(join(dir, "plc", "PLC_1", "blocks", "Lib"), { recursive: true });
  writeFileSync(join(dir, "rung.toml"), 'format = 1\ndevices = ["PLC_1"]\n[project]\npath = "x.ap20"\ntiaVersion = "V20"\n');
  writeFileSync(join(dir, "plc", "PLC_1", "blocks", "Lib", "timer.scl"), MANY);
  writeFileSync(join(dir, "plc", "PLC_1", "blocks", "estop.scl"), 'FUNCTION "EStop" : Void\nBEGIN\nEND_FUNCTION\n');
  let out = "", err = "";
  const io = { cwd: dir, env: {}, stdout: (s: string) => { out += s; }, stderr: (s: string) => { err += s; } };
  return { dir, io, out: () => out, err: () => err };
}

describe("rung split", () => {
  it("lint names the problem, split puts each object where rung keeps it, with its comments, and renames a misnamed file", async () => {
    const t = workspace();
    const idx = new WorkspaceIndex();
    await idx.load(t.dir);
    const codes = (f: string) => diagnostics(idx, uriOf(join(t.dir, f))).map((d) => d.code);
    expect(codes("plc/PLC_1/blocks/Lib/timer.scl").filter((c) => c === "MULTIPLE_OBJECTS")).toHaveLength(2);
    expect(codes("plc/PLC_1/blocks/estop.scl")).toContain("FILE_NAME");

    expect(await main(["split"], t.io)).toBe(0);
    const at = (p: string) => join(t.dir, "plc", "PLC_1", p);
    expect(existsSync(at("blocks/Lib/timer.scl"))).toBe(false);
    expect(readFileSync(at("types/Lib/udt_timer.udt"), "utf8")).toMatch(/^\/\/ a library as one source\nTYPE "udt_timer"[\s\S]*END_TYPE\n$/);
    expect(readFileSync(at("blocks/Lib/TimerDB.db"), "utf8")).toMatch(/^DATA_BLOCK "TimerDB"[\s\S]*END_DATA_BLOCK\n$/);
    expect(readFileSync(at("blocks/Lib/TimerStart.scl"), "utf8")).toMatch(/^\/\/ starts a timer\nFUNCTION "TimerStart"[\s\S]*END_FUNCTION\n$/);
    expect(readdirSync(at("blocks"))).toEqual(expect.arrayContaining(["EStop.scl"]));
    expect(readdirSync(at("blocks"))).not.toContain("estop.scl");

    expect(await main(["split"], t.io)).toBe(0);
    expect(t.out()).toContain("nothing to split");
  });

  it("leaves a file alone when one of its objects already has a file", async () => {
    const t = workspace();
    writeFileSync(join(t.dir, "plc", "PLC_1", "blocks", "Lib", "TimerStart.scl"), 'FUNCTION "TimerStart" : Void\nBEGIN\nEND_FUNCTION\n');
    expect(await main(["split", "plc/PLC_1/blocks/Lib/timer.scl"], t.io)).toBe(0);
    expect(t.err()).toContain("not split, plc/PLC_1/blocks/Lib/TimerStart.scl is already there");
    expect(existsSync(join(t.dir, "plc", "PLC_1", "blocks", "Lib", "timer.scl"))).toBe(true);
  });
});
