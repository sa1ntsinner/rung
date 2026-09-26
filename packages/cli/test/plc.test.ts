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
  return { dir, run, out, err, db, questions, toml, patch };
}

describe("PLC commands", () => {
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
