// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.js";
import { OwnerClient } from "@rung/sync";

const fakeScript = fileURLToPath(new URL("./fake-bridge.mjs", import.meta.url));
const PROJECT = "C:\\fx\\RungFixture\\RungFixture.ap20";
const MOTOR = "plc:PLC_1/blocks/Fx_Motor";
const motorFile = ["plc", "PLC_1", "blocks", "Fx_Motor.scl"];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rung-2way-"));
  const objects = join(dir, "..", `objects-${Date.now()}-${Math.random()}.json`);
  writeFileSync(objects, JSON.stringify({ project: { name: "RungFixture", path: PROJECT, tiaVersion: "V20", devices: ["PLC_1"], isLocalSession: false }, objects: [{ address: MOTOR, content: 'FUNCTION_BLOCK "Fx_Motor"\nbegin\n  #a := 1;\nEND_FUNCTION_BLOCK\n' }] }));
  const out: string[] = [];
  const err: string[] = [];
  const env = { RUNG_BRIDGE: process.execPath, RUNG_BRIDGE_ARGS: JSON.stringify([fakeScript]), FAKE_OBJECTS: objects };
  const run = (args: string[], extra: Partial<Parameters<typeof main>[1]> = {}) => main(args, { cwd: dir, stdout: (s) => out.push(s), stderr: (s) => err.push(s), env, ...extra });
  const db = () => JSON.parse(readFileSync(objects, "utf8")) as { objects: { address: string; content: string }[]; downloads?: unknown[] };
  const file = (...p: string[]) => join(dir, ...p);
  return { dir, run, out, err, db, file, objects };
}
const until = async (cond: () => boolean, ms = 15_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("two-way CLI", () => {
  it("sync imports a local edit and writes back TIA's canonical text", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nbegin\n  #a := 2;\nEND_FUNCTION_BLOCK\n');
    expect(await t.run(["sync"])).toBe(0);
    expect(t.db().objects[0]!.content).toContain("#a := 2;");
    expect(readFileSync(t.file(...motorFile), "utf8")).toContain("BEGIN"); // canonical form
    t.out.length = 0;
    expect(await t.run(["sync"])).toBe(0);
    expect(t.out.join("")).toMatch(/imported 0/);
  });

  it("sync refuses imports when sync.import is manual", async () => {
    const t = setup();
    await t.run(["init"]);
    const cfg = t.file("rung.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace('import = "auto"', 'import = "manual"'));
    await t.run(["pull"]);
    writeFileSync(t.file(...motorFile), "changed\n");
    expect(await t.run(["sync"])).toBe(2);
    expect(t.out.join("")).toMatch(/IMPORT_MANUAL/);
    expect(t.db().objects[0]!.content).not.toContain("changed");
  });

  it("sync reports compile errors as diagnostics", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nBEGIN\n  #undeclared := 1;\nEND_FUNCTION_BLOCK\n');
    expect(await t.run(["sync"])).toBe(2);
    expect(t.out.join("")).toMatch(/COMPILE .*Tag #undeclared not defined/);
  });

  it("delete needs confirmation, then confirm-delete removes the object in TIA", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    unlinkSync(t.file(...motorFile));
    await t.run(["sync"]);
    expect(t.out.join("")).toMatch(/DELETE_PENDING/);
    expect(t.db().objects).toHaveLength(1);
    expect(await t.run(["confirm-delete", MOTOR])).toBe(0);
    expect(t.db().objects).toHaveLength(0);
  });

  it("resolve --theirs ends a conflict with the TIA version", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nbegin\n  #a := 5;\nEND_FUNCTION_BLOCK\n');
    const db = t.db();
    db.objects[0]!.content = 'FUNCTION_BLOCK "Fx_Motor"\nbegin\n  #a := 7;\nEND_FUNCTION_BLOCK\n';
    writeFileSync(t.objects, JSON.stringify(db));
    expect(await t.run(["sync"])).toBe(2);
    expect(existsSync(t.file(...motorFile) + ".conflict")).toBe(true);
    expect(await t.run(["resolve", join(...motorFile), "--theirs"])).toBe(0);
    expect(readFileSync(t.file(...motorFile), "utf8")).toContain("#a := 7;");
    expect(existsSync(t.file(...motorFile) + ".conflict")).toBe(false);
  });

  it("watch owns the workspace: status and sync go through its IPC, file edits are imported", async () => {
    const t = setup();
    await t.run(["init"]);
    const cfg = t.file("rung.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("pollMs = 2000", "pollMs = 500"));
    let stop!: () => void;
    const stopSignal = new Promise<void>((r) => (stop = r));
    const watching = t.run(["watch"], { stopSignal });
    await until(() => existsSync(t.file(...motorFile)));
    t.out.length = 0;
    expect(await t.run(["status"])).toBe(0);
    expect(t.out.join("")).toMatch(/watching/);
    // a second writer is refused while watch holds the workspace, with what to do instead
    expect(await t.run(["pull"])).toBe(1);
    expect(t.err.join("")).toMatch(/rung watch runs in this workspace and already brings TIA Portal's changes in; rung pull is not needed while it runs/);
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nbegin\n  #a := 42;\nEND_FUNCTION_BLOCK\n');
    await until(() => t.db().objects[0]!.content.includes("#a := 42;"));
    t.out.length = 0;
    expect(await t.run(["sync"])).toBe(0); // via IPC
    // read-only lookups of the state must not need its lock while watch runs
    t.err.length = 0;
    expect(await t.run(["compile", "--file", join(...motorFile)])).toBe(0);
    expect(t.err.join("")).not.toMatch(/STATE_LOCKED/);
    // another client with the owner's token cannot download without the PLC a person confirmed
    const owner = (await OwnerClient.connect(t.dir))!;
    try {
      await expect(owner.request("download", { request: { device: "PLC_1", allow: ["stop-cpu"] } })).rejects.toThrow(/names the PLC a person confirmed/);
      expect(t.db().downloads).toBeUndefined();
    } finally {
      owner.close();
    }
    stop();
    expect(await watching).toBe(0);
    expect(existsSync(t.file(".rung", "owner.json"))).toBe(false);
  }, 60_000);

  it("watch prints what stays open once, not on every pass", async () => {
    const t = setup();
    await t.run(["init"]);
    const cfg = t.file("rung.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("pollMs = 2000", "pollMs = 250"));
    let stop!: () => void;
    const stopSignal = new Promise<void>((r) => (stop = r));
    const watching = t.run(["watch"], { stopSignal });
    await until(() => existsSync(t.file(...motorFile)));
    unlinkSync(t.file(...motorFile));
    await until(() => t.out.join("").includes("DELETE_PENDING"));
    await new Promise((r) => setTimeout(r, 2000)); // several passes
    stop();
    expect(await watching).toBe(0);
    expect(t.out.join("").match(/DELETE_PENDING/g)).toHaveLength(1);
  }, 60_000);
});

