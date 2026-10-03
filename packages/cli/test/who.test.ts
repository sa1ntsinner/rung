// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.js";

const files: Record<string, string> = {
  "Line_DB.db": 'DATA_BLOCK "Line_DB"\nVERSION : 0.1\n   VAR\n      Speed : Real;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n',
  "Set_Speed.scl": 'FUNCTION "Set_Speed" : Void\n   VAR_INPUT\n      v : Real;\n   END_VAR\nBEGIN\n   "Line_DB".Speed := #v;\nEND_FUNCTION\n',
  "Fx_Drive.scl": 'FUNCTION_BLOCK "Fx_Drive"\n   VAR_OUTPUT\n      Out : Real;\n   END_VAR\nBEGIN\n   #Out := "Line_DB".Speed * 2.0;\nEND_FUNCTION_BLOCK\n',
  "Main.scl": 'ORGANIZATION_BLOCK "Main"\nBEGIN\n   "Set_Speed"(v := 1500.0);\nEND_ORGANIZATION_BLOCK\n',
};

describe("rung who", () => {
  const ws = mkdtempSync(join(tmpdir(), "rung-who-"));
  writeFileSync(join(ws, "rung.toml"), 'format = 1\ndevices = []\n[project]\npath = "C:\\\\x.ap20"\ntiaVersion = "V20"\n');
  mkdirSync(join(ws, "plc", "PLC_1", "blocks"), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(ws, "plc", "PLC_1", "blocks", f), text);
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const code = await main(args, { cwd: ws, stdout: (s) => out.push(s), stderr: (s) => out.push(s), env: {} });
    return { code, text: out.join("") };
  };

  it("lists the writers with where they are called from, then the readers", async () => {
    const r = await run("who", '"Line_DB".Speed');
    expect(r.code).toBe(0);
    expect(r.text).toContain('"Line_DB".Speed: 1 write, 1 read');
    expect(r.text).toMatch(/Set_Speed\s+plc\/PLC_1\/blocks\/Set_Speed\.scl:6 {2}"Line_DB"\.Speed := #v;/);
    expect(r.text).toMatch(/called from Main \(plc\/PLC_1\/blocks\/Main\.scl:3\)/);
    expect(r.text).toMatch(/Fx_Drive\s+plc\/PLC_1\/blocks\/Fx_Drive\.scl:6/);
    expect(r.text).toContain("not seen: HMI");
  });

  it("answers in JSON and says when a name is used nowhere", async () => {
    const r = await run("who", "Line_DB.Speed", "--json");
    const j = JSON.parse(r.text) as { writes: { block: string; calledFrom: { block: string }[] }[]; reads: unknown[] };
    expect(j.writes).toEqual([expect.objectContaining({ block: "Set_Speed", calledFrom: [expect.objectContaining({ block: "Main" })] })]);
    expect(j.reads).toHaveLength(1);
    expect((await run("who", "Nowhere")).code).toBe(1);
  });

  it("an instance DB's member is written by its FB's code, called through that DB", async () => {
    const dir = join(ws, "plc", "PLC_1", "blocks");
    writeFileSync(join(dir, "Fx_Belt.scl"), 'FUNCTION_BLOCK "Fx_Belt"\n   VAR_OUTPUT\n      Jam : Bool;\n   END_VAR\nBEGIN\n   #Jam := TRUE;\nEND_FUNCTION_BLOCK\n');
    writeFileSync(join(dir, "Belt_DB.db"), 'DATA_BLOCK "Belt_DB"\n"Fx_Belt"\nBEGIN\nEND_DATA_BLOCK\n');
    writeFileSync(join(dir, "Cell.scl"), 'ORGANIZATION_BLOCK "Cell"\nBEGIN\n   "Belt_DB"();\n   "Lamp" := "Belt_DB".Jam;\nEND_ORGANIZATION_BLOCK\n');
    const r = await run("who", '"Belt_DB".Jam');
    expect(r.text).toMatch(/Fx_Belt\s+plc\/PLC_1\/blocks\/Fx_Belt\.scl:6 {2}#Jam := TRUE;/);
    expect(r.text).toMatch(/called from Cell \(plc\/PLC_1\/blocks\/Cell\.scl:3\)/);
    expect(r.text).toMatch(/Cell\s+plc\/PLC_1\/blocks\/Cell\.scl:4/);
  });

  it("a tag used by its address in a file TIA Portal has not rewritten yet is used; an address without a tag has its uses", async () => {
    mkdirSync(join(ws, "plc", "PLC_1", "tags"), { recursive: true });
    writeFileSync(join(ws, "plc", "PLC_1", "tags", "IO.tags.st"), "VAR_GLOBAL\n    Reset_PB AT %I0.2 : Bool;\nEND_VAR\n");
    writeFileSync(join(ws, "plc", "PLC_1", "blocks", "Reset.scl"), 'FUNCTION "Reset" : Void\nBEGIN\n   "Line_DB".Speed := 0.0;\n   %M10.0 := %I0.2;\nEND_FUNCTION\n');
    const tag = await run("who", "Reset_PB");
    expect(tag.text).toContain("Reset_PB: 0 writes, 1 read");
    expect(tag.text).toMatch(/Reset\s+plc\/PLC_1\/blocks\/Reset\.scl:4 {2}%M10\.0 := %I0\.2;/);
    const raw = await run("who", "%M10.0");
    expect(raw.code).toBe(0);
    expect(raw.text).toContain("no PLC tag is at %M10.0");
    expect(raw.text).toContain("%M10.0: 1 write, 0 reads");
    expect((await run("who", "%M99.0")).code).toBe(1);
  });

  it("a call that hands a value to an in/out is listed as handed on; the block that writes it is the writer", async () => {
    const dir = join(ws, "plc", "PLC_1", "blocks");
    writeFileSync(join(dir, "Count_DB.db"), 'DATA_BLOCK "Count_DB"\n   VAR\n      Parts : DInt;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n');
    writeFileSync(join(dir, "FC_Inc.scl"), 'FUNCTION "FC_Inc" : Void\n   VAR_IN_OUT\n      N : DInt;\n   END_VAR\nBEGIN\n   #N := #N + 1;\nEND_FUNCTION\n');
    writeFileSync(join(dir, "Count.scl"), 'FUNCTION "Count" : Void\nBEGIN\n   "FC_Inc"(N := "Count_DB".Parts);\nEND_FUNCTION\n');
    const r = await run("who", '"Count_DB".Parts');
    expect(r.text).toContain('"Count_DB".Parts: 1 write, 1 read');
    expect(r.text).toMatch(/FC_Inc\s+plc\/PLC_1\/blocks\/FC_Inc\.scl:6 {2}#N := #N \+ 1;/);
    expect(r.text).toMatch(/handed on\n {2}Count\s+plc\/PLC_1\/blocks\/Count\.scl:3 .*\n\s+to FC_Inc as N\n/);
  });
});
