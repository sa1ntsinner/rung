// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.js";

const fakeScript = fileURLToPath(new URL("./fake-bridge.mjs", import.meta.url));
const PROJECT = "C:\\fx\\RungFixture\\RungFixture.ap20";
const TARGET = '\n[plc.PLC_1]\nmode = "PN/IE"\npc_interface = "PLCSIM"\npc_interface_number = 1\ntarget_interface = "1 X1"\n';

function setup(answers: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "rung-plc-"));
  const objects = join(dir, "..", `objects-${Date.now()}-${Math.random()}.json`);
  writeFileSync(objects, JSON.stringify({ project: { name: "RungFixture", path: PROJECT, tiaVersion: "V20", devices: ["PLC_1"], isLocalSession: false }, objects: [{ address: "plc:PLC_1/blocks/Fx_Motor", content: 'FUNCTION_BLOCK "Fx_Motor"\nBEGIN\n  #a := 1;\nEND_FUNCTION_BLOCK\n' }] }));
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const env = { RUNG_BRIDGE: process.execPath, RUNG_BRIDGE_ARGS: JSON.stringify([fakeScript]), FAKE_OBJECTS: objects };
  const prompt = async (q: string) => {
    questions.push(q);
    return answers.shift() ?? "";
  };
  const run = (args: string[]) => main(args, { cwd: dir, stdout: (s) => out.push(s), stderr: (s) => err.push(s), env, prompt });
  const db = () => JSON.parse(readFileSync(objects, "utf8")) as { downloads?: { allow: string[]; hardware: boolean; software: boolean; onlyChanges: boolean; startAfter: boolean }[]; online?: string; onlineTarget?: Record<string, unknown> | null; scans?: number };
  const toml = join(dir, "rung.toml");
  const patch = (o: Record<string, unknown>) => writeFileSync(objects, JSON.stringify({ ...JSON.parse(readFileSync(objects, "utf8")), ...o }));
  return { dir, run, out, err, db, questions, toml, patch, objects };
}

describe("rung compare", () => {
  it("lists what differs from the PLC with the workspace file, and exits 2", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    appendFileSync(t.toml, TARGET);
    t.out.length = 0;
    expect(await t.run(["compare"])).toBe(2);
    const out = t.out.join("");
    expect(out).toMatch(/PLC_1: 1 differ, 0 only in the project, 0 only on the PLC; 7 identical/);
    expect(out).toMatch(/differs\s+plc\/PLC_1\/blocks\/Fx_Motor\.scl\n/); // no generic "Objects are different."
    expect((t.db() as { compareTarget?: Record<string, unknown> }).compareTarget).toMatchObject({ mode: "PN/IE", pcInterface: "PLCSIM", targetInterface: "1 X1" });
  });

  it("--json prints JSON only, also when it first finds the PLC and saves the connection", async () => {
    const t = setup();
    await t.run(["init"]);
    t.out.length = 0;
    expect(await t.run(["compare", "--json"])).toBe(2);
    expect(JSON.parse(t.out.join(""))).toMatchObject({ items: [{ address: "plc:PLC_1/blocks/Fx_Motor", state: "Different" }] });
    expect(t.err.join("")).toMatch(/PLC_1: .*; saved as \[plc\.PLC_1\] in rung\.toml/);
  });

  it("says so when the PLC runs the project, and exits 0; --json for tools", async () => {
    const t = setup();
    await t.run(["init"]);
    appendFileSync(t.toml, TARGET);
    t.patch({ compare: [] });
    t.out.length = 0;
    expect(await t.run(["compare"])).toBe(0);
    expect(t.out.join("")).toMatch(/the PLC runs what the project has \(7 objects compared\)/);
    t.out.length = 0;
    expect(await t.run(["compare", "--json"])).toBe(0);
    expect(JSON.parse(t.out.join(""))).toMatchObject({ identical: 7, items: [] });
  });
});

describe("PLC commands", () => {
  it("compile drops the summary and shows a repeated hardware warning once at PLC level", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    const warning = { address: "plc:PLC_1/blocks/Fx_Motor", severity: "warning", description: "Inputs or outputs are used that do not exist in the configured hardware." };
    t.patch({ compileMessages: [warning, warning, { address: warning.address, severity: "warning", description: "Compiling finished (errors: 0; warnings: 1)" }] });
    t.out.length = 0;
    expect(await t.run(["compile", "--file", "plc/PLC_1/blocks/Fx_Motor.scl"])).toBe(0);
    expect(t.out.join("")).toContain("warning  PLC PLC_1 — Inputs or outputs");
    expect(t.out.join("").match(/configured hardware/g)).toHaveLength(1);
    expect(t.out.join("")).not.toContain("Compiling finished");
    expect(t.out.join("")).not.toContain("Fx_Motor.scl");
  });
  it("stops at options that leave nothing to do, before looking for the PLC", async () => {
    const t = setup(["1"]);
    await t.run(["init"]);
    expect(await t.run(["download", "--no-sw", "--yes"])).toBe(1);
    expect(t.err.join("")).toMatch(/rung: BAD_ARGUMENT: --no-sw leaves nothing to download: add --hw to download the hardware configuration/);
    expect([t.db().downloads, t.db().scans]).toEqual([undefined, undefined]);
    t.err.length = 0;
    expect(await t.run(["compile", "--hw", "--file", "plc/PLC_1/blocks/Fx_Motor.scl"])).toBe(1);
    expect(t.err.join("")).toMatch(/--hw and --file exclude each other/);
    t.err.length = 0;
    expect(await t.run(["live", "watch", "--file", "plc/PLC_1/blocks/Fx_Motor.scl", "--interval", "1s"])).toBe(1);
    expect(t.err.join("")).toMatch(/rung: BAD_ARGUMENT: --interval is a number of milliseconds \(--interval 500\); got 1s/);
  });

  it("a PG/PC interface number that is no number never reaches rung.toml", async () => {
    const t = setup();
    await t.run(["init"]);
    const before = readFileSync(t.toml, "utf8");
    expect(await t.run(["connect", "--use", "PLCSIM", "--number", "one"])).toBe(1);
    expect(t.err.join("")).toMatch(/rung: BAD_ARGUMENT: --number is the number of the PG\/PC interface \(1 or more; rung interfaces lists them\), not one/);
    expect(readFileSync(t.toml, "utf8")).toBe(before);
    expect(await t.run(["upload", "--ip", "192.168.0.1", "--use", "PLCSIM", "--number", "0"])).toBe(1);
    expect(await t.run(["status"])).toBe(0);
  });

  it("download never picks the PLC by itself: it asks, even when one device answers at the project address", async () => {
    const t = setup([""]);
    await t.run(["init"]);
    expect(await t.run(["download", "--yes"])).toBe(1);
    expect(t.out.join("")).toMatch(/Which PLC should PLC_1 be downloaded to\? Check name and address; rung never picks one by itself\./);
    expect(t.questions[0]).toMatch(/^Number \(1-1\): $/);
    expect(t.db().downloads).toBeUndefined();
    expect(readFileSync(t.toml, "utf8")).not.toContain("[plc.PLC_1]");

    const chosen = setup(["1"]);
    await chosen.run(["init"]);
    expect(await chosen.run(["download", "--yes", "--allow", "stop-cpu"])).toBe(0);
    expect(chosen.db().downloads).toHaveLength(1);
    // only rung download's own bridge may download: the others are started without --allow-download
    const starts = (chosen.db() as unknown as { startArgs: string[][] }).startArgs;
    expect(starts.at(-1)).toContain("--allow-download");
    expect(starts.slice(0, -1).every((a) => !a.includes("--allow-download"))).toBe(true);
    expect(readFileSync(chosen.toml, "utf8")).toContain('pc_interface = "Ethernet"');
  });

  it("without a terminal a download with no saved connection explains instead of choosing", async () => {
    const t = setup();
    await t.run(["init"]);
    const err: string[] = [];
    const code = await main(["download", "--yes"], { cwd: t.dir, stdout: () => {}, stderr: (s) => err.push(s), env: { RUNG_BRIDGE: process.execPath, RUNG_BRIDGE_ARGS: JSON.stringify([fakeScript]), FAKE_OBJECTS: t.objects } });
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/NO_TARGET: rung never picks a PLC to download to by itself/);
  });

  it("download asks for the PLC name and does nothing on a wrong answer", async () => {
    const t = setup(["PLC_2"]);
    await t.run(["init"]);
    appendFileSync(t.toml, TARGET);
    expect(await t.run(["download"])).toBe(1);
    expect(t.questions[0]).toMatch(/Type the PLC name \(PLC_1\)/);
    expect(t.db().downloads).toBeUndefined();
    expect(t.out.join("")).toMatch(/Nothing was downloaded/);
  });

  it("download is cancelled when TIA asks to stop the CPU, and names the --allow that would continue", async () => {
    const t = setup(["PLC_1"]);
    await t.run(["init"]);
    appendFileSync(t.toml, TARGET);
    expect(await t.run(["download"])).toBe(3);
    const out = t.out.join("");
    expect(out).toMatch(/✗ pre\s+stop-cpu/);
    expect(out).toMatch(/--allow stop-cpu/);
    const req = t.db().downloads![0]!;
    expect(req).toMatchObject({ software: true, hardware: false, onlyChanges: true, startAfter: true, allow: [] });
  });

  it("--allow and --yes let a download through; flags map onto the request", async () => {
    const t = setup();
    await t.run(["init"]);
    appendFileSync(t.toml, TARGET);
    expect(await t.run(["download", "--yes", "--allow", "stop-cpu", "--hw", "--all-blocks", "--no-start"])).toBe(0);
    expect(t.questions).toEqual([]);
    expect(t.db().downloads![0]).toMatchObject({ allow: ["stop-cpu"], hardware: true, onlyChanges: false, startAfter: false });
    expect(t.out.join("")).toMatch(/download: Success/);
  });

  it("download settings in rung.toml apply and can switch downloads off", async () => {
    const t = setup();
    await t.run(["init"]);
    const cfg = readFileSync(t.toml, "utf8").replace("allow = []", 'allow = ["stop-cpu"]');
    writeFileSync(t.toml, cfg + TARGET);
    expect(await t.run(["download", "--yes"])).toBe(0);
    expect(t.db().downloads![0]!.allow).toEqual(["stop-cpu"]);
    writeFileSync(t.toml, cfg.replace("enabled = true", "enabled = false") + TARGET);
    expect(await t.run(["download", "--yes"])).toBe(1);
    expect(t.err.join("")).toMatch(/downloads are turned off/);
  });


  it("interfaces prints the options and a ready rung.toml snippet", async () => {
    const t = setup();
    await t.run(["init"]);
    expect(await t.run(["interfaces", "--scan"])).toBe(0);
    const out = t.out.join("");
    expect(out).toContain('pc_interface "Ethernet" (number 1)');
    expect(out).toContain("reachable: plc_1 192.168.0.1");
  });

  it("going online without any setup finds the PLC by its project address and remembers it", async () => {
    const t = setup();
    await t.run(["init"]);
    expect(await t.run(["online"])).toBe(0);
    const out = t.out.join("");
    expect(out).toContain("PLC_1: plc_1 at 192.168.0.1 (S7-1500) via Ethernet → 1 X1; saved");
    expect(out).toMatch(/PLC_1: Online/);
    expect(t.db().onlineTarget).toMatchObject({ mode: "PN/IE", pcInterface: "Ethernet", targetInterface: "1 X1" });
    expect(readFileSync(t.toml, "utf8")).toMatch(/\[plc\.PLC_1\][\s\S]*pc_interface = "Ethernet"[\s\S]*target_interface = "1 X1"/);
    // the second time nothing is scanned
    expect(await t.run(["online"])).toBe(0);
    expect(t.db().scans).toBe(1);
  });

  it("uses the connection TIA Portal remembers when there is one", async () => {
    const t = setup();
    await t.run(["init"]);
    t.patch({ tiaConfigured: true });
    expect(await t.run(["online"])).toBe(0);
    expect(t.db().scans ?? 0).toBe(0);
    expect(t.db().onlineTarget).toBeNull();
  });

  it("maps the second PROFINET address to X2 and asks when several interfaces reach the PLC", async () => {
    const t = setup(["2"]);
    await t.run(["init"]);
    t.patch({ reach: [{ pc: "Ethernet", address: "192.168.1.1" }, { pc: "USB-LAN", address: "192.168.0.1" }] });
    expect(await t.run(["online"])).toBe(0);
    expect(t.questions[0]).toContain("Number (1-2)");
    expect(t.out.join("")).toContain("1) plc_1 at 192.168.1.1 (S7-1500) via Ethernet → 1 X2");
    expect(t.db().onlineTarget).toMatchObject({ pcInterface: "USB-LAN", targetInterface: "1 X1" });
  });

  it("explains what it looked for when the PLC is not on the network", async () => {
    const t = setup();
    await t.run(["init"]);
    t.patch({ reach: [] });
    expect(await t.run(["online"])).toBe(1);
    const err = t.err.join("");
    expect(err).toMatch(/PLC_1 was not found on the network/);
    expect(err).toContain("192.168.0.1 (PROFINET interface_1)");
    expect(err).toMatch(/rung looked on: Ethernet, Wi-Fi/);
    expect(err).toContain("192.168.0.100/24");
  });

  it("offers a device that answers under another address, and connect --json lists everything for editors", async () => {
    const t = setup(["1"]);
    await t.run(["init"]);
    t.patch({ reach: [{ pc: "Wi-Fi", address: "10.0.0.7" }] });
    t.out.length = 0;
    expect(await t.run(["connect", "--json"])).toBe(0);
    const j = JSON.parse(t.out.join(""));
    expect(j.candidates).toEqual([]);
    expect(j.reachable[0].label).toContain("10.0.0.7");
    expect(j.notFound).toMatch(/Found there instead/);
    expect(await t.run(["online"])).toBe(0);
    expect(t.db().onlineTarget).toMatchObject({ pcInterface: "Wi-Fi" });
  });

  it("connect --use saves a hand-picked connection", async () => {
    const t = setup();
    await t.run(["init"]);
    expect(await t.run(["connect", "--use", "PLCSIM", "--target", "1 X1"])).toBe(0);
    expect(readFileSync(t.toml, "utf8")).toMatch(/pc_interface = "PLCSIM"/);
    expect(await t.run(["connect", "--use", "Ethernet", "--target", "1 X2"])).toBe(0);
    const toml = readFileSync(t.toml, "utf8");
    expect(toml.match(/\[plc\.PLC_1\]/g)).toHaveLength(1); // replaced, not duplicated
    expect(toml).toMatch(/pc_interface = "Ethernet"/);
  });

  it("connect --use replaces a hand-written table with a comment instead of adding a second one", async () => {
    const t = setup();
    await t.run(["init"]);
    appendFileSync(t.toml, '\n[ plc.PLC_1 ]  # our test rig\nmode = "PN/IE"\npc_interface = "Old"\n');
    expect(await t.run(["connect", "--use", "Ethernet", "--target", "1 X1"])).toBe(0);
    const toml = readFileSync(t.toml, "utf8");
    expect(toml.match(/plc\.PLC_1/g)).toHaveLength(1);
    expect(toml).not.toContain('"Old"');
    expect(await t.run(["status"])).toBe(0); // still a valid rung.toml
  });

  it("online goes online and offline", async () => {
    const t = setup();
    await t.run(["init"]);
    appendFileSync(t.toml, TARGET);
    expect(await t.run(["online"])).toBe(0);
    expect(t.out.join("")).toMatch(/PLC_1: Online/);
    expect(await t.run(["online", "--off"])).toBe(0);
    expect(t.db().online).toBe("Offline");
  });

  it("compile --hw compiles the hardware; open explains a headless TIA", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    expect(await t.run(["compile", "--hw"])).toBe(0);
    expect(t.out.join("")).toMatch(/Hardware compiled/);
    expect(await t.run(["open", "plc/PLC_1/blocks/Fx_Motor.scl"])).toBe(1);
    expect(t.err.join("")).toMatch(/without user interface/);
  });
});
