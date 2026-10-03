// SPDX-License-Identifier: BUSL-1.1
// rung who: JSON for addresses, and an instance DB's uses without the other instances'.
import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdWho } from "../src/who.js";

it.each(["%I0.2", "%M10.0"])("who %s --json emits parseable JSON", async (name) => {
  const root = await mkdtemp(join(tmpdir(), "rung-edges-who-"));
  try {
    await mkdir(join(root, "plc", "P", "blocks"), { recursive: true });
    await mkdir(join(root, "plc", "P", "tags"), { recursive: true });
    await writeFile(join(root, "rung.toml"), 'format = 1\n[project]\npath = "C:/x.ap20"\ntiaVersion = "V20"\n');
    await writeFile(join(root, "plc", "P", "blocks", "Main.scl"), 'FUNCTION "Main" : Void\nBEGIN\n%M10.0 := %I0.2;\nEND_FUNCTION\n');
    await writeFile(join(root, "plc", "P", "tags", "IO.tags.st"), "VAR_GLOBAL\nReset AT %I0.2 : Bool;\nEND_VAR\n");
    const output: string[] = [];
    expect(await cmdWho(root, name, { json: true }, { cwd: root, stdout: (s) => output.push(s), stderr: () => {}, env: {} })).toBe(0);
    expect(() => JSON.parse(output.join(""))).not.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("who keeps explicit writes to other instances out of the requested instance DB", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-edges-instance-"));
  try {
    const blocks = join(root, "plc", "P", "blocks");
    await mkdir(blocks, { recursive: true });
    await writeFile(join(root, "rung.toml"), 'format = 1\n[project]\npath = "C:/x.ap20"\ntiaVersion = "V20"\n');
    await writeFile(join(blocks, "Belt.scl"), 'FUNCTION_BLOCK "Belt"\nVAR\nJam : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n');
    for (const name of ["Belt1_DB", "Belt2_DB"])
      await writeFile(join(blocks, name + ".db"), 'DATA_BLOCK "' + name + '"\n"Belt"\nBEGIN\nEND_DATA_BLOCK\n');
    await writeFile(join(blocks, "Write.scl"), 'FUNCTION "Write" : Void\nBEGIN\n"Belt2_DB".Jam := TRUE;\nEND_FUNCTION\n');
    const output: string[] = [];
    await cmdWho(root, "Belt1_DB.Jam", { json: true }, { cwd: root, stdout: (s) => output.push(s), stderr: () => {}, env: {} });
    expect(JSON.parse(output.join("")).writes).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
