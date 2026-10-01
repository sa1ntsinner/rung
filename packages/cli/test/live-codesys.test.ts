// SPDX-License-Identifier: BUSL-1.1
// Live values of CODESYS, read-only: through a CODESYS bridge of its own, or through rung watch when that owns it.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OwnerServer } from "@rung/sync";
import { liveReader } from "../src/live.js";

const fakeScript = fileURLToPath(new URL("./fake-bridge.mjs", import.meta.url));
const PROJECT = "C:/fx/Cds/Cds.project";
const COUNT = "Application.PLC_PRG.count";

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rung-live-cds-"));
  writeFileSync(join(dir, "rung.toml"), `format = 1\n\n[project]\npath = "${PROJECT}"\ntiaVersion = "CODESYS"\n\n[plc.Device]\nmode = "simulation"\npc_interface = ""\n`);
  const blocks = join(dir, "plc", "Device", "blocks");
  mkdirSync(blocks, { recursive: true });
  const file = join(blocks, "FB_Motor.st");
  writeFileSync(file, "FUNCTION_BLOCK FB_Motor\nVAR\n    count : INT;\nEND_VAR\ncount := count + 1;\nEND_FUNCTION_BLOCK\n");
  const objects = join(dir, "..", `objects-${Date.now()}-${Math.random()}.json`);
  writeFileSync(objects, JSON.stringify({ project: { name: "Cds", path: PROJECT, tiaVersion: "CODESYS", devices: ["Device"], isLocalSession: true }, objects: [], values: { [COUNT]: 7 } }));
  const io = { cwd: dir, stdout: () => {}, stderr: () => {}, env: { RUNG_BRIDGE: process.execPath, RUNG_BRIDGE_ARGS: JSON.stringify([fakeScript]), FAKE_OBJECTS: objects, ...env } };
  const db = () => JSON.parse(readFileSync(objects, "utf8")) as { methods?: string[]; starts?: number; exits?: number; onlineTarget?: Record<string, unknown> };
  return { dir, uri: pathToFileURL(file).href, io, db };
}

describe("live values of CODESYS", () => {
  it("logs in through a bridge of its own, only reads, and ends that bridge on close", async () => {
    const t = setup();
    const reader = await liveReader(t.uri, t.io);
    expect(await reader.read([COUNT, "Application.PLC_PRG.nope"])).toEqual([
      { name: COUNT, value: 7 },
      { name: "Application.PLC_PRG.nope", error: "Application.PLC_PRG.nope is unknown" },
    ]);
    await reader.read([COUNT]);
    await reader.close();
    const db = t.db();
    // logging in is all it does to the PLC: no download, no import, no start, no write
    expect(db.methods).toEqual(["bridge.hello", "plc.online online", "plc.read", "plc.read"]);
    expect(db.onlineTarget).toMatchObject({ mode: "simulation" });
    expect(db.exits).toBe(1);
  });

  it("a login that fails ends its bridge and says why", async () => {
    const t = setup({ FAKE_ONLINE_ERROR: "CODESYS has no gateway configured" });
    await expect(liveReader(t.uri, t.io)).rejects.toThrow("CODESYS has no gateway configured");
    expect(t.db().methods).toEqual(["bridge.hello", "plc.online online"]);
    expect(t.db().exits).toBe(1);
  });

  it("while rung watch owns the bridge, asks it for reads and nothing else, and leaves it running", async () => {
    const t = setup();
    const asked: unknown[] = [];
    const server = await OwnerServer.start(t.dir, {
      read: async (p) => {
        asked.push(p);
        return [{ name: COUNT, value: 8 }];
      },
    });
    try {
      const reader = await liveReader(t.uri, t.io);
      expect(await reader.read([COUNT])).toEqual([{ name: COUNT, value: 8 }]);
      await reader.close();
      expect(asked).toEqual([{ device: "Device", expressions: [COUNT] }]);
      expect(t.db().starts).toBeUndefined(); // no bridge of its own
      // the owner still answers others
      const again = await liveReader(t.uri, t.io);
      expect(await again.read([COUNT])).toEqual([{ name: COUNT, value: 8 }]);
      await again.close();
    } finally {
      await server.close();
    }
  });
});
