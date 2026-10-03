// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.js";
import { OwnerClient } from "@rung/sync";
import { printReport, validateTags } from "../src/twoway.js";

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
  const db = () => JSON.parse(readFileSync(objects, "utf8")) as { project: { path: string }; objects: { address: string; content: string }[]; downloads?: unknown[] };
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
  it("status finds disk edits before sync, persists writes-off and refusal reasons, and clears them after sending", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nBEGIN\n  #a := 2;\nEND_FUNCTION_BLOCK\n');
    t.out.length = 0;
    expect(await t.run(["status"])).toBe(0);
    expect(t.out.join("")).toContain("1 object, 0 synced");
    expect(t.out.join("")).toContain("edited, not sent plc/PLC_1/blocks/Fx_Motor.scl — writes off (rung writes on)");
    await t.run(["sync"]);
    const state = JSON.parse(readFileSync(t.file(".rung", "state.json"), "utf8"));
    expect(state.objects[MOTOR]).toMatchObject({ status: "fileDirty", notSent: { code: "WRITES_OFF" } });
    t.out.length = 0;
    await t.run(["status"]);
    expect(t.out.join("")).toContain("WRITES_OFF");
    await t.run(["writes", "on"]);
    writeFileSync(t.objects, JSON.stringify({ ...t.db(), refuseImports: "source refused" }));
    await t.run(["sync"]);
    t.out.length = 0;
    await t.run(["status"]);
    expect(t.out.join("")).toContain("IMPORT_FAILED: source refused");
    writeFileSync(t.objects, JSON.stringify({ ...t.db(), refuseImports: null }));
    await t.run(["sync"]);
    t.out.length = 0;
    await t.run(["status"]);
    expect(t.out.join("")).toContain("1 object, 1 synced");
    expect(t.out.join("")).not.toContain("edited, not sent");
  });

  it("a manual backup counts for the day's next sync", async () => {
    const t = setup();
    await t.run(["init", "--writes"]);
    await t.run(["pull"]);
    await t.run(["backup"]);
    expect(JSON.parse(readFileSync(t.file(".rung", "backups.json"), "utf8"))).toMatchObject({ project: PROJECT });
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nBEGIN\n  #a := 2;\nEND_FUNCTION_BLOCK\n');
    expect(await t.run(["sync"])).toBe(0);
    expect((t.db() as unknown as { archives: string[] }).archives).toHaveLength(1);
  });

  it("init --writes announces the project and the exact command to stop writes", async () => {
    const t = setup();
    expect(await t.run(["init", "--writes"])).toBe(0);
    expect(t.out.join("")).toContain(`Writes to TIA Portal are on for ${PROJECT}; rung writes off stops them.\n`);
  });

  it("sync names files in each direction and keeps the full movement list in JSON", async () => {
    const t = setup();
    await t.run(["init", "--writes"]);
    t.out.length = 0;
    await t.run(["sync"]);
    expect(t.out.join("")).toContain("← TIA  plc/PLC_1/blocks/Fx_Motor.scl\n");
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nBEGIN\n  #a := 2;\nEND_FUNCTION_BLOCK\n');
    t.out.length = 0;
    await t.run(["sync"]);
    expect(t.out.join("")).toContain("→ TIA  plc/PLC_1/blocks/Fx_Motor.scl\n");
    writeFileSync(t.file("plc", "PLC_1", "blocks", "Fx_New.scl"), 'FUNCTION "Fx_New" : Void\nBEGIN\nEND_FUNCTION\n');
    t.out.length = 0;
    await t.run(["sync", "--json"]);
    expect(JSON.parse(t.out.join("")).changes).toContainEqual({ path: "plc/PLC_1/blocks/Fx_New.scl", action: "create" });
    const out: string[] = [];
    printReport({ cwd: t.dir, env: {}, stdout: (s) => out.push(s), stderr: () => {} }, { exported: 1000, imported: 0, created: 0, merged: 0, conflicts: 0, pendingDeletes: 0, removed: 0, unchanged: 0, warnings: [], diagnostics: [], changes: Array.from({ length: 1000 }, (_, i) => ({ path: `plc/PLC_1/blocks/F${i}.scl`, action: "export" as const })) });
    expect(out.join("").match(/← TIA/g)).toHaveLength(8);
    expect(out.join("")).toContain("992 more files (1000 moved");
  });

  it("sync refuses a tag table on its missing-address and address-size lines, before import", async () => {
    const t = setup();
    const address = "plc:PLC_1/tags/Inputs";
    const content = "VAR_GLOBAL\n    Start AT %I0.0 : Bool;\nEND_VAR\n";
    writeFileSync(t.objects, JSON.stringify({ ...t.db(), objects: [{ address, form: "tags.st", content }] }));
    await t.run(["init", "--writes"]);
    await t.run(["pull"]);
    const file = t.file("plc", "PLC_1", "tags", "Inputs.tags.st");
    writeFileSync(file, "VAR_GLOBAL\n    NoAddr : Bool;\n    BadType AT %I1.3 : Int;\nEND_VAR\n");
    t.out.length = 0;
    expect(await t.run(["sync"])).toBe(2);
    expect(t.out.join("")).toMatch(/NO_ADDRESS\s+plc\/PLC_1\/tags\/Inputs.tags.st:2 — NoAddr has no address/);
    expect(t.out.join("")).toMatch(/ADDRESS_SIZE\s+plc\/PLC_1\/tags\/Inputs.tags.st:3 — BadType is an Int/);
    expect(t.db().objects[0]!.content).toBe(content);
    expect(validateTags("Inputs.tags.st", "VAR_GLOBAL\n    Fine AT %IW2 : Int;\nEND_VAR\n")).toEqual([]);
    writeFileSync(file, "VAR_GLOBAL\n    Fine AT %IW2 : Int;\nEND_VAR\n");
    expect(await t.run(["sync"])).toBe(0);
  });

  it("sync drops compile summaries and keeps repeated PLC-wide warnings off files", async () => {
    const t = setup();
    await t.run(["init", "--writes"]);
    await t.run(["pull"]);
    const global = { address: MOTOR, severity: "warning", description: "Inputs or outputs are used that do not exist in the configured hardware." };
    writeFileSync(t.objects, JSON.stringify({ ...t.db(), compileMessages: [{ address: MOTOR, severity: "error", section: "body", bodyLine: 1, description: "Tag #undeclared not defined." }, { address: MOTOR, severity: "error", description: "Compiling finished (errors: 1; warnings: 1)" }, global, global] }));
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nBEGIN\n  #undeclared := 1;\nEND_FUNCTION_BLOCK\n');
    t.out.length = 0;
    expect(await t.run(["sync"])).toBe(2);
    expect(t.out.join("")).not.toContain("Compiling finished");
    expect(t.out.join("").match(/configured hardware/g)).toHaveLength(1);
    const items = JSON.parse(readFileSync(t.file(".rung", "diagnostics.json"), "utf8")).items;
    expect(items).toHaveLength(2);
    expect(items.find((d: { severity: string }) => d.severity === "warning")).toMatchObject({ address: "plc:PLC_1", path: "" });
    expect(items.find((d: { severity: string }) => d.severity === "warning")).not.toHaveProperty("line");
    expect(items.find((d: { severity: string }) => d.severity === "error")).toMatchObject({ path: "plc/PLC_1/blocks/Fx_Motor.scl", line: 3 });
  });

  it("delete and conflict hints include commands with files, and an unmatched path lists pending deletes", async () => {
    const t = setup();
    await t.run(["init", "--writes"]);
    await t.run(["pull"]);
    t.err.length = 0;
    expect(await t.run(["confirm-delete", "plc/PLC_1/blocks/Fx_Motr.scl"])).toBe(1);
    expect(t.err.join("")).toContain("did you mean plc/PLC_1/blocks/Fx_Motor.scl?");
    unlinkSync(t.file(...motorFile));
    await t.run(["sync"]);
    expect(t.out.join("")).toContain("rung confirm-delete plc/PLC_1/blocks/Fx_Motor.scl");
    t.err.length = 0;
    expect(await t.run(["confirm-delete", "plc/PLC_1/blocks/Nope.scl"])).toBe(1);
    expect(t.err.join("")).toContain("pending deletes: plc/PLC_1/blocks/Fx_Motor.scl");
    expect(t.err.join("")).not.toContain("rung pull");
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nBEGIN\n  #a := 2;\nEND_FUNCTION_BLOCK\n');
    const db = t.db();
    db.objects[0]!.content = db.objects[0]!.content.replace("#a := 1", "#a := 3");
    writeFileSync(t.objects, JSON.stringify(db));
    t.out.length = 0;
    await t.run(["sync"]);
    expect(t.out.join("")).toContain("markers in plc/PLC_1/blocks/Fx_Motor.scl.conflict; run rung resolve plc/PLC_1/blocks/Fx_Motor.scl --ours|--theirs|--merged");
    t.out.length = 0;
    await t.run(["status"]);
    expect(t.out.join("")).toContain("edited, not sent plc/PLC_1/blocks/Fx_Motor.scl — conflict");
    t.out.length = 0;
    await t.run(["sync"]);
    expect(t.out.join("").match(/run rung resolve plc\/PLC_1\/blocks\/Fx_Motor.scl --ours\|--theirs\|--merged/g)).toHaveLength(1);
  });

  it("sync imports a local edit and writes back TIA's canonical text", async () => {
    const t = setup();
    await t.run(["init", "--writes"]);
    await t.run(["pull"]);
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nbegin\n  #a := 2;\nEND_FUNCTION_BLOCK\n');
    expect(await t.run(["sync"])).toBe(0);
    expect(t.db().objects[0]!.content).toContain("#a := 2;");
    expect(readFileSync(t.file(...motorFile), "utf8")).toContain("BEGIN"); // canonical form
    t.out.length = 0;
    expect(await t.run(["sync"])).toBe(0);
    expect(t.out.join("")).toMatch(/imported 0/);
  });

  it("after init nothing is written into TIA Portal until rung writes on; a rebind to another project turns it off again", async () => {
    const t = setup();
    await t.run(["init"]);
    expect(t.out.join("")).toContain("Writes to TIA Portal are off");
    await t.run(["pull"]);
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nbegin\n  #a := 2;\nEND_FUNCTION_BLOCK\n');
    writeFileSync(t.file("plc", "PLC_1", "blocks", "Fx_New.scl"), 'FUNCTION "Fx_New" : Void\nBEGIN\nEND_FUNCTION\n');
    t.out.length = 0;
    expect(await t.run(["sync"])).toBe(0); // writes off is a state the person chose, not a failed run
    expect(t.out.join("")).toContain("WRITES_OFF");
    expect(t.out.join("")).toContain("local edit not sent to TIA Portal: writes are off in this workspace (rung writes on)");
    expect(t.out.join("")).toContain("new file not sent to TIA Portal");
    expect(t.db().objects.map((o) => o.address)).toEqual([MOTOR]);
    expect(t.db().objects[0]!.content).not.toContain("#a := 2;");
    expect(readFileSync(t.file(...motorFile), "utf8")).toContain("#a := 2;"); // the edit stays in the file
    t.out.length = 0;
    expect(await t.run(["status"])).toBe(0);
    expect(t.out.join("")).toContain("writes to TIA Portal: off (rung writes on)");

    t.out.length = 0;
    expect(await t.run(["writes", "on"])).toBe(0);
    expect(t.out.join("")).toContain(`writes to TIA Portal: on for ${PROJECT}`);
    expect(await t.run(["sync"])).toBe(0);
    expect(t.db().objects[0]!.content).toContain("#a := 2;");
    expect(t.db().objects.map((o) => o.address)).toContain("plc:PLC_1/blocks/Fx_New");

    // the right belongs to the project it was given for: another project starts without it
    const db = t.db() as { project: { path: string } };
    writeFileSync(t.objects, JSON.stringify({ ...db, project: { ...db.project, path: "C:\\fx\\Other\\Other.ap20" } }));
    expect(await t.run(["init", "--rebind"])).toBe(0);
    t.out.length = 0;
    expect(await t.run(["writes"])).toBe(0);
    expect(t.out.join("")).toContain("writes to TIA Portal: off.");
    expect(await t.run(["writes", "maybe"])).toBe(1);
    expect(await t.run(["writes", "off"])).toBe(0);
  });

  it("sync --preview shows the edit and its lines, sends nothing, and says writes are off", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nbegin\n  #a := 2;\nEND_FUNCTION_BLOCK\n');
    t.out.length = 0;
    expect(await t.run(["sync", "--preview"])).toBe(0);
    const text = t.out.join("");
    expect(text).toContain("What rung sync would do now (nothing is sent, written or recorded):");
    expect(text).toMatch(/update\s+plc\/PLC_1\/blocks\/Fx_Motor\.scl → TIA Portal/);
    expect(text).toContain("-  #a := 1;");
    expect(text).toContain("+  #a := 2;");
    expect(text).toContain("writes to TIA Portal are off in this workspace");
    expect(t.db().objects[0]!.content).toContain("#a := 1;");
    t.out.length = 0;
    expect(await t.run(["sync", "--preview", "--json"])).toBe(0);
    const json = JSON.parse(t.out.join("")) as { plan: { entries: { action: string; path: string }[] }; writesOff: boolean };
    expect(json.plan.entries).toEqual([expect.objectContaining({ action: "update", path: "plc/PLC_1/blocks/Fx_Motor.scl" })]);
    expect(json.writesOff).toBe(true);
  });

  it("sync refuses imports when sync.import is manual", async () => {
    const t = setup();
    await t.run(["init", "--writes"]);
    const cfg = t.file("rung.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace('import = "auto"', 'import = "manual"'));
    await t.run(["pull"]);
    writeFileSync(t.file(...motorFile), "changed\n");
    expect(await t.run(["sync"])).toBe(0);
    expect(t.out.join("")).toMatch(/IMPORT_MANUAL/);
    expect(t.db().objects[0]!.content).not.toContain("changed");
  });

  it("sync reports compile errors as diagnostics", async () => {
    const t = setup();
    await t.run(["init", "--writes"]);
    await t.run(["pull"]);
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nBEGIN\n  #undeclared := 1;\nEND_FUNCTION_BLOCK\n');
    expect(await t.run(["sync"])).toBe(2);
    expect(t.out.join("")).toMatch(/COMPILE .*Tag #undeclared not defined/);
  });

  it("delete needs confirmation, then confirm-delete removes the object in TIA", async () => {
    const t = setup();
    await t.run(["init", "--writes"]);
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
    await t.run(["init", "--writes"]);
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
    await t.run(["init", "--writes"]);
    const cfg = t.file("rung.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("pollMs = 2000", "pollMs = 500"));
    let stop!: () => void;
    const stopSignal = new Promise<void>((r) => (stop = r));
    const watching = t.run(["watch"], { stopSignal });
    await until(() => existsSync(t.file(...motorFile)));
    await until(() => t.out.join("").includes("← TIA  plc/PLC_1/blocks/Fx_Motor.scl"));
    expect(await t.run(["backup"])).toBe(0); // through the owner, before this watch's first send
    t.out.length = 0;
    expect(await t.run(["status"])).toBe(0);
    expect(t.out.join("")).toMatch(/watching/);
    // a second writer is refused while watch holds the workspace, with what to do instead
    expect(await t.run(["pull"])).toBe(1);
    expect(t.err.join("")).toMatch(/rung watch runs in this workspace and already brings TIA Portal's changes in; rung pull is not needed while it runs/);
    writeFileSync(t.file(...motorFile), 'FUNCTION_BLOCK "Fx_Motor"\nbegin\n  #a := 42;\nEND_FUNCTION_BLOCK\n');
    await until(() => t.db().objects[0]!.content.includes("#a := 42;"));
    await until(() => t.out.join("").includes("→ TIA  plc/PLC_1/blocks/Fx_Motor.scl"));
    expect((t.db() as unknown as { archives: string[] }).archives).toHaveLength(1);
    t.out.length = 0;
    expect(await t.run(["sync"])).toBe(0); // via IPC
    const json: string[] = [];
    expect(await t.run(["sync", "--json"], { stdout: (s) => json.push(s) })).toBe(0);
    expect(JSON.parse(json.join(""))).toHaveProperty("changes");
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
    await t.run(["init", "--writes"]);
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
