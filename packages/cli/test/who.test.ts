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
});
