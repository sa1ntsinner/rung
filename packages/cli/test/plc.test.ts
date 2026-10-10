// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
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
  return { dir, run, out, err, db, questions, toml, patch, objects, env: env as Record<string, string> };
}

describe("rung session", () => {
  it("older bridges refuse discard without saving or closing", async () => {
    const t = setup();
    await t.run(["init"]);
    t.env.FAKE_OLD_BRIDGE = "1";
    t.patch({ sessionModified: true });
    expect(await t.run(["session", "--release", "--discard"])).toBe(1);
    expect(t.err.join("")).toContain("METHOD_NOT_FOUND");
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    expect(db.sessionReleased).not.toBe(true);
    expect(db.sessionSaved).not.toBe(true);
  });
  it("explicitly discards unsaved keeper changes even with auto-save enabled", async () => {
    const t = setup();
    await t.run(["init"]);
    expect(readFileSync(t.toml, "utf8")).toContain('save = "after-import"');
    t.patch({ sessionModified: true });
    expect(await t.run(["session", "--release", "--discard"])).toBe(0);
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    expect(db.sessionReleased).toBe(true);
    expect(db.sessionSaved).toBe(false);
  });
  it.each([["--discard"], ["--release", "--save", "--discard"]])("rejects invalid discard flags before connecting: %s", async (...flags) => {
    const t = setup();
    expect(await t.run(["session", ...flags])).toBe(1);
    expect(t.err.join("")).toMatch(/--discard requires --release|--save and --discard/);
    expect(JSON.parse(readFileSync(t.objects, "utf8")).startArgs).toBeUndefined();
  });
  it("prints the custom download destination before asking for confirmation", async () => {
    const t = setup(["no"]);
    t.patch({ project: { name: "RungFixture", path: PROJECT.replace("ap20", "ap21"), tiaVersion: "V21", devices: ["PLC_1"], isLocalSession: false } });
    await t.run(["init"]);
    appendFileSync(t.toml, TARGET + 'address = "10.0.0.7"\n');
    t.out.length = 0;
    expect(await t.run(["download"])).toBe(1);
    expect(t.out.join("")).toContain("PLC_1 at 10.0.0.7 via");
    expect(t.questions).toHaveLength(1);
  });
  it("refuses release while another workspace watches the keeper", async () => {
    const t = setup();
    await t.run(["init"]);
    t.patch({ sessionAttachedSessions: 3 });
    expect(await t.run(["session", "--release", "--save"])).not.toBe(0);
    expect(t.err.join("")).toContain("PROJECT_IN_USE");
    expect(JSON.parse(readFileSync(t.objects, "utf8")).sessionReleased).not.toBe(true);
  });
  it.each(["NO_PROJECT", "TIA_NOT_RUNNING"])("reports a closed project for %s", async (code) => {
    const t = setup();
    await t.run(["init"]);
    t.env.FAKE_SESSION_ERROR = code;
    t.out.length = 0;
    expect(await t.run(["session", "--json"])).toBe(0);
    expect(JSON.parse(t.out.join(""))).toEqual({ projectPath: PROJECT, open: false });
    t.out.length = 0;
    expect(await t.run(["session"])).toBe(0);
    expect(t.out.join("")).toMatch(/no TIA Portal has the project open/i);
    expect(t.out.join("")).toMatch(/no keeper record/i);
    expect(JSON.parse(readFileSync(t.objects, "utf8")).startArgs.at(-1)).not.toContain("--open-headless");
  });
  it("reports a closed project with a keeper record", async () => {
    const t = setup();
    await t.run(["init"]);
    t.env.FAKE_NO_PROJECT = "1";
    t.patch({ closedKeeperPid: 7 });
    t.out.length = 0;
    expect(await t.run(["session"])).toBe(0);
    expect(t.out.join("")).toMatch(/no TIA Portal has the project open/i);
    expect(t.out.join("")).toContain("keeper record exists (7)");
  });
  it("documents release and rejects unrelated options before connecting", async () => {
    const t = setup();
    expect(await t.run(["session", "--help"])).toBe(0);
    expect(t.out.join("")).toContain("--release");
    expect(await t.run(["session", "--plc", "PLC_1"])).not.toBe(0);
    expect(t.err.join("")).toContain("has no --plc");
  });
  it("prints the state without asking its bridge to open TIA", async () => {
    const t = setup();
    await t.run(["init"]);
    t.out.length = 0;
    expect(await t.run(["session", t.dir, "--json"])).toBe(0);
    expect(JSON.parse(t.out.join(""))).toMatchObject({ projectPath: PROJECT, tiaPid: 42, mode: "headless", heldBy: "keeper", keeperPid: 7, attachedSessions: 1 });
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    expect(db.startArgs.at(-1)).not.toContain("--open-headless");
    t.out.length = 0;
    expect(await t.run(["session"])).toBe(0);
    expect(t.out.join("")).toContain("keeper");
  });

  it("requires save for unsaved changes and passes it through on release", async () => {
    const t = setup();
    await t.run(["init"]);
    t.patch({ sessionModified: true });
    expect(await t.run(["session", "--release"])).not.toBe(0);
    expect(t.err.join("")).toContain("PROJECT_UNSAVED");
    expect(await t.run(["session", "--release", "--save"])).toBe(0);
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    expect(db.sessionReleased).toBe(true);
    expect(db.sessionSaved).toBe(true);
    expect(db.startArgs.at(-1)).not.toContain("--open-headless");
  });

  it("never releases a portal held by another program", async () => {
    const t = setup();
    await t.run(["init"]);
    t.patch({ sessionHeldBy: "other" });
    expect(await t.run(["session", "--release", "--save"])).not.toBe(0);
    expect(t.err.join("")).toContain("PROJECT_BUSY");
    expect(JSON.parse(readFileSync(t.objects, "utf8")).sessionReleased).not.toBe(true);
  });
});

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

  it("what the download says about the PLC follows the phase: before the transfer, after it, or unknown", async () => {
    const t = setup();
    await t.run(["init"]);
    appendFileSync(t.toml, TARGET);
    // refused before the transfer: nothing went
    expect(await t.run(["download", "--yes"])).toBe(3);
    expect(t.out.join("")).toMatch(/Nothing was downloaded: before the transfer/);
    // refused after it (start the CPU): the program is there, the CPU may be in STOP
    t.out.length = 0;
    t.patch({ downloadOutcome: { state: "Cancelled", decisions: [{ phase: "pre", kind: "StopModules", name: "stop-cpu", choice: "StopAll", allowed: true, blocks: false }, { phase: "post", kind: "StartModules", name: "start-cpu", choice: "NoAction", allowed: false, blocks: true }], needsAllow: ["start-cpu"] } });
    expect(await t.run(["download", "--yes", "--allow", "stop-cpu"])).toBe(4);
    expect(t.out.join("")).toMatch(/The download reached PLC_1\. .* may be in STOP/);
    expect(t.out.join("")).not.toMatch(/Nothing was downloaded/);
    // an error once the transfer had started
    t.out.length = 0;
    t.patch({ downloadOutcome: { state: "Error", errors: 1, decisions: [{ phase: "post", kind: "StartModules", name: "start-cpu", choice: "StartModule", allowed: true, blocks: false }] } });
    expect(await t.run(["download", "--yes", "--allow", "stop-cpu"])).toBe(2);
    expect(t.out.join("")).toMatch(/The transfer had started: PLC_1 may hold part of the download/);
    // lost during the download
    t.err.length = 0;
    t.patch({ downloadOutcome: "throw" });
    expect(await t.run(["download", "--yes", "--allow", "stop-cpu"])).toBe(5);
    expect(t.err.join("")).toMatch(/cannot tell how far the download to PLC_1 got/);
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
    expect(j.reachable[0].addressChange).toEqual({ interface: "PROFINET interface_1", from: "192.168.0.1", to: "10.0.0.7" });
    expect(j.notFound).toMatch(/Found there instead/);
    expect(await t.run(["online"])).toBe(0);
    expect(t.db().onlineTarget).toMatchObject({ pcInterface: "Wi-Fi" });
    // TIA Portal goes online at the project's address only: rung says so and how to change it
    expect(t.out.join("")).toMatch(/The project gives PLC_1 192\.168\.0\.1 \(PROFINET interface_1\), and it answered at 10\.0\.0\.7.*\n.*rung connect --address 10\.0\.0\.7/s);
  });

  it("connect --address puts the address the PLC answers at into network.yaml, leaving the rest of the file", async () => {
    const t = setup();
    await t.run(["init"]);
    const dir = join(t.dir, "plc", "PLC_1", "hardware");
    mkdirSync(dir, { recursive: true });
    const yaml = `"PLC_1 / PROFINET interface_1":\n  ip: 192.168.0.1  # X1\n  subnetMask: 255.255.255.0\n\n"PLC_1 / PROFINET interface_2":\n  ip: 192.168.1.1\n`;
    writeFileSync(join(dir, "network.yaml"), yaml);
    expect(await t.run(["connect", "--address", "192.168.0.50"])).toBe(0);
    expect(readFileSync(join(dir, "network.yaml"), "utf8")).toBe(yaml.replace("ip: 192.168.0.1", "ip: 192.168.0.50"));
    expect(t.out.join("")).toMatch(/PROFINET interface_1 192\.168\.0\.1 → 192\.168\.0\.50/);
    expect(await t.run(["connect", "--address", "192.168.1.1"])).toBe(0);
    expect(t.out.join("")).toMatch(/already has 192\.168\.1\.1/);
    expect(await t.run(["connect", "--address", "999.168.0.2"])).toBe(1);
    expect(readFileSync(join(dir, "network.yaml"), "utf8")).toContain("ip: 192.168.0.50");
  });

  it("saves a V21 online address without changing the project", async () => {
    const t = setup();
    await t.run(["init"]);
    writeFileSync(t.toml, readFileSync(t.toml, "utf8").replace('tiaVersion = "V20"', 'tiaVersion = "V21"') + TARGET);
    const dir = join(t.dir, "plc", "PLC_1", "hardware");
    mkdirSync(dir, { recursive: true });
    const yaml = '"PLC_1 / PROFINET interface_1":\n  ip: 192.168.0.1\n';
    writeFileSync(join(dir, "network.yaml"), yaml);
    expect(await t.run(["connect", "--address", "10.0.0.7"])).toBe(0);
    expect(readFileSync(t.toml, "utf8")).toContain('address = "10.0.0.7"');
    expect(readFileSync(join(dir, "network.yaml"), "utf8")).toBe(yaml);
    expect(await t.run(["online"])).toBe(0);
    expect(t.db().onlineTarget).toMatchObject({ address: "10.0.0.7", pcInterface: "PLCSIM" });
  });

  it("offers the V21 address in the pick flow", async () => {
    const t = setup(["1", "y"]);
    await t.run(["init"]);
    writeFileSync(t.toml, readFileSync(t.toml, "utf8").replace('tiaVersion = "V20"', 'tiaVersion = "V21"'));
    t.patch({ reach: [{ pc: "Wi-Fi", address: "10.0.0.7" }] });
    expect(await t.run(["connect", "--pick"])).toBe(0);
    expect(t.questions.join("\n")).toMatch(/go online at 10.0.0.7/i);
    expect(readFileSync(t.toml, "utf8")).toContain('address = "10.0.0.7"');
    expect(t.out.join("")).toMatch(/project stays unchanged/i);
  });

  it("can still edit the V21 project address explicitly", async () => {
    const t = setup();
    await t.run(["init"]);
    writeFileSync(t.toml, readFileSync(t.toml, "utf8").replace('tiaVersion = "V20"', 'tiaVersion = "V21"'));
    const dir = join(t.dir, "plc", "PLC_1", "hardware");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "network.yaml"), '"PLC_1 / PROFINET interface_1":\n  ip: 192.168.0.1\n');
    expect(await t.run(["connect", "--address", "10.0.0.7", "--project-address"])).toBe(0);
    expect(readFileSync(join(dir, "network.yaml"), "utf8")).toContain("ip: 10.0.0.7");
    expect(readFileSync(t.toml, "utf8")).not.toContain('address = "10.0.0.7"');
  });

  it("connect --use saves a hand-picked connection TIA Portal offers, in its spelling; one it does not offer is refused", async () => {
    const t = setup();
    await t.run(["init"]);
    expect(await t.run(["connect", "--use", "PLCSIM", "--target", "1 X1"])).toBe(1);
    expect(t.err.join("")).toContain('TIA Portal has no PG/PC interface "PLCSIM" (1) in mode "PN/IE" for PLC_1; it has "Ethernet" (1), "Wi-Fi" (1)');
    expect(await t.run(["connect", "--use", "Ethernet", "--target", "1 X3"])).toBe(1);
    expect(t.err.join("")).toContain('it has "1 X1", "1 X2"');
    expect(readFileSync(t.toml, "utf8")).not.toMatch(/pc_interface/);
    expect(await t.run(["connect", "--use", "wi-fi", "--target", "1 x1"])).toBe(0);
    expect(readFileSync(t.toml, "utf8")).toMatch(/pc_interface = "Wi-Fi"[\s\S]*target_interface = "1 X1"/);
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

  it("online passes the PLC password from RUNG_PLC_PASSWORD and says how when the PLC asks for one", async () => {
    const t = setup();
    await t.run(["init"]);
    appendFileSync(t.toml, TARGET);
    t.patch({ plcPassword: "s3cret" });
    expect(await t.run(["online"])).toBe(1);
    expect(t.err.join("")).toMatch(/PASSWORD_REQUIRED: PLC_1 asks for a password to go online[\s\S]*RUNG_PLC_PASSWORD/);
    t.env.RUNG_PLC_PASSWORD = "s3cret";
    expect(await t.run(["online"])).toBe(0);
    expect(t.db().online).toBe("Online");
  });
  it.each(["online", "compare"])("%s trusts an unknown certificate only for an explicit run, without a password", async (command) => {
    const t = setup();
    await t.run(["init"]);
    appendFileSync(t.toml, TARGET);
    t.patch({ plcCertificate: "PLC_1 certificate: SHA256 AA:BB:CC", compare: [] });
    const config = readFileSync(t.toml, "utf8");
    expect(await t.run([command])).toBe(1);
    expect(t.err.join("")).toMatch(/TLS_UNTRUSTED:.*SHA256 AA:BB:CC/);
    expect(t.err.join("")).toMatch(/--trust-certificate/);
    expect(await t.run([command, "--trust-certificate"])).toBe(0);
    expect(readFileSync(t.toml, "utf8")).toBe(config);
    if (command === "online") await t.run(["online", "--off"]);
    expect(await t.run([command])).toBe(1);
  });
  it("trusting a certificate still requires the PLC password", async () => {
    const t = setup();
    await t.run(["init"]);
    appendFileSync(t.toml, TARGET);
    t.patch({ plcCertificate: "PLC_1 certificate: AA:BB", plcPassword: "s3cret", plcUser: "eng" });
    expect(await t.run(["online", "--trust-certificate"])).toBe(1);
    expect(t.err.join("")).toContain("PASSWORD_REQUIRED");
    t.env.RUNG_PLC_PASSWORD = "s3cret";
    t.env.RUNG_PLC_USER = "eng";
    expect(await t.run(["online", "--trust-certificate"])).toBe(0);
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

  it("compile --hw compiles the hardware; open opens the block in a TIA Portal window, never one without", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    expect(await t.run(["compile", "--hw"])).toBe(0);
    expect(t.out.join("")).toMatch(/Hardware compiled/);
    expect(await t.run(["open", "plc/PLC_1/blocks/Fx_Motor.scl"])).toBe(0);
    expect(t.db().shown).toEqual([{ address: "plc:PLC_1/blocks/Fx_Motor", save: false, window: true }]);
    expect(t.db().startArgs.at(-1)).not.toContain("--open-headless");
  });

  it("open asks before a project with unsaved changes moves into a TIA Portal window; --save lets it", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    t.patch({ unsavedProject: true });
    expect(await t.run(["open", "plc/PLC_1/blocks/Fx_Motor.scl"])).toBe(1);
    expect(t.err.join("")).toMatch(/PROJECT_UNSAVED: .*rung open plc\/PLC_1\/blocks\/Fx_Motor\.scl --save/);
    expect(await t.run(["open", "plc/PLC_1/blocks/Fx_Motor.scl", "--save"])).toBe(0);
    expect(t.db().shown.at(-1)).toMatchObject({ save: true });
  });
});

describe("rung xref", () => {
  it("lists TIA Portal's cross-reference by relation, with the workspace file of each object", async () => {
    const t = setup();
    await t.run(["init"]);
    await t.run(["pull"]);
    t.patch({
      xref: {
        "plc:PLC_1/blocks/Fx_Motor": [
          { source: "plc:PLC_1/blocks/Fx_Motor", sourceName: "Fx_Motor", target: "plc:PLC_1/blocks/Fx_Motor", targetName: "Main", targetType: "OB", access: "Call", referenceType: "UsedBy", location: "@Main ▶ NW1" },
          { source: "plc:PLC_1/blocks/Fx_Motor", sourceName: "Fx_Motor", targetName: "Screen_1", targetType: "HMI screen", access: "Read", referenceType: "UsedBy", location: "@Screen_1 ▶ Button" },
          { source: "plc:PLC_1/blocks/Fx_Motor", sourceName: "Fx_Motor", targetName: "LIMIT [V1.0]", targetType: "Instruction", access: "Call", referenceType: "Uses", location: "@Fx_Motor ▶ Program code" },
        ],
      },
    });
    t.out.length = 0;
    expect(await t.run(["xref", "plc/PLC_1/blocks/Fx_Motor.scl"])).toBe(0);
    const text = t.out.join("");
    expect(text).toMatch(/used by:\n  Main +Call +OB  @Main ▶ NW1/);
    expect(text).toMatch(/  Screen_1 +Read +HMI screen/);
    expect(text).toMatch(/uses:\n  LIMIT \[V1\.0\] +Call/);
    t.out.length = 0;
    expect(await t.run(["xref", "plc/PLC_1/blocks/Fx_Motor.scl", "--json"])).toBe(0);
    const j = JSON.parse(t.out.join("")) as { rows: { relation: string; name: string; path?: string }[] };
    expect(j.rows.map((r) => [r.relation, r.name])).toEqual([["used by", "Main"], ["used by", "Screen_1"], ["uses", "LIMIT [V1.0]"]]);
    // kept while nothing mirrored changed: TIA Portal is not asked again, unless --fresh
    t.patch({ xref: {} });
    t.out.length = 0;
    expect(await t.run(["xref", "plc/PLC_1/blocks/Fx_Motor.scl"])).toBe(0);
    expect(t.out.join("")).toMatch(/used by:\n  Main[\s\S]*\(TIA Portal's answer of .*: nothing mirrored changed since/);
    t.out.length = 0;
    expect(await t.run(["xref", "plc/PLC_1/blocks/Fx_Motor.scl", "--fresh"])).toBe(0);
    expect(t.out.join("")).toBe("TIA Portal knows no cross references of plc:PLC_1/blocks/Fx_Motor\n");
  });
});
