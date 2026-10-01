// SPDX-License-Identifier: BUSL-1.1
// F2 on a block's name renames it in TIA Portal (rung rename), so its uses there follow; locals stay the editor's.
import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startServer, type Renamer } from "../src/server.js";
import { monitorServer } from "./monitorHarness.js";

const CALLER = 'FUNCTION_BLOCK "Line"\nVAR\n   m : "Motor";\nEND_VAR\nBEGIN\n   #m();\n   "Motor_DB"();\nEND_FUNCTION_BLOCK\n';
const DB = 'DATA_BLOCK "Motor_DB"\n"Motor"\nBEGIN\nEND_DATA_BLOCK\n';

const servers: Awaited<ReturnType<typeof monitorServer>>[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.dispose(); });

async function boot(renamer?: Renamer) {
  const s = await monitorServer(undefined, {
    start: (reader, writer) => startServer(reader, writer, renamer ? { renamer } : {}),
    setup: async (root) => {
      await writeFile(join(root, "plc", "PLC_1", "blocks", "Line.scl"), CALLER);
      await writeFile(join(root, "plc", "PLC_1", "blocks", "Motor_DB.db"), DB);
    },
  });
  servers.push(s);
  return s;
}
const rename = (s: Awaited<ReturnType<typeof boot>>, uri: string, line: number, character: number, newName: string) =>
  s.client.sendRequest("textDocument/rename", { textDocument: { uri }, position: { line, character }, newName });

describe("rename through TIA Portal", () => {
  it("renames a block from its header and from a use of it, and opens its new file", async () => {
    const calls: [string, string][] = [];
    const s = await boot({
      rename: async (fileUri, newName) => {
        calls.push([fileUri, newName]);
        return { newUri: fileUri.replace("Motor.scl", `${newName}.scl`), users: 2 };
      },
    });
    const shown: string[] = [];
    s.client.onRequest("window/showDocument", (p: { uri: string }) => {
      shown.push(p.uri);
      return { success: true };
    });
    expect(await rename(s, s.uri, 0, 18, "Drive")).toEqual({ changes: {} });
    const line = s.uri.replace("Motor.scl", "Line.scl");
    await s.open(line, CALLER);
    await rename(s, line, 6, 5, "Drive_DB");
    expect(calls).toEqual([
      [s.uri, "Drive"],
      [pathToFileURL(join(s.root, "plc", "PLC_1", "blocks", "Motor_DB.db")).href, "Drive_DB"],
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.messages.map((m) => m.message)).toContain('Renamed "Motor" to "Drive" in TIA Portal; 2 files that use it follow');
    expect(shown[0]).toBe(s.uri.replace("Motor.scl", "Drive.scl"));
  });

  it("renames a local variable in the editor, and says how to rename a block without TIA Portal at hand", async () => {
    const s = await boot();
    const local = (await rename(s, s.uri, 2, 4, "total")) as { changes: Record<string, unknown[]> };
    expect(local.changes[s.uri]).toHaveLength(3); // the declaration and its two uses
    await expect(rename(s, s.uri, 0, 18, "Drive")).rejects.toThrow('"Motor" is renamed in TIA Portal: rung rename "Motor" Drive');
  });

  it("renames the object of the file whose header it is, and nothing while an open file has unsaved changes", async () => {
    const calls: [string, string][] = [];
    const s = await boot({
      rename: async (fileUri, newName) => {
        calls.push([fileUri, newName]);
        return { users: 0 };
      },
    });
    const line = s.uri.replace("Motor.scl", "Line.scl");
    // the header of Line.scl edited, unsaved, to name another block: F2 there must never rename Motor
    await s.open(line, CALLER);
    await s.client.sendNotification("textDocument/didChange", { textDocument: { uri: line, version: 2 }, contentChanges: [{ text: CALLER.replace('"Line"', '"Motor"') }] });
    await expect(rename(s, line, 0, 18, "Drive")).rejects.toThrow(/Save .*Line\.scl.* first/);
    // a caller with unsaved changes would lose them when rung rewrites it
    await expect(rename(s, s.uri, 0, 18, "Drive")).rejects.toThrow(/Save .*Line\.scl.* first/);
    expect(calls).toEqual([]);
    // saved again: the header names this file's own block
    await s.client.sendNotification("textDocument/didChange", { textDocument: { uri: line, version: 3 }, contentChanges: [{ text: CALLER }] });
    await rename(s, line, 0, 18, "Conveyor");
    expect(calls).toEqual([[line, "Conveyor"]]);
  });

  it("reports what TIA Portal refused", async () => {
    const s = await boot({ rename: async () => { throw new Error("Drive already exists at plc:PLC_1/blocks/Drive"); } });
    await expect(rename(s, s.uri, 0, 18, "Drive")).rejects.toThrow("Drive already exists");
  });
});
