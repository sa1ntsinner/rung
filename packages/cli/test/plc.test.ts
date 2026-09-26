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
  const db = () => JSON.parse(readFileSync(objects, "utf8")) as { downloads?: { allow: string[]; hardware: boolean; software: boolean; onlyChanges: boolean; startAfter: boolean }[]; online?: string };
  const toml = join(dir, "rung.toml");
  return { dir, run, out, err, db, questions, toml };
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

  it("download without a connection points at rung interfaces", async () => {
    const t = setup();
    await t.run(["init"]);
    expect(await t.run(["download", "--yes"])).toBe(1);
    expect(t.err.join("")).toMatch(/run rung interfaces/);
  });

  it("interfaces prints the options and a ready rung.toml snippet", async () => {
    const t = setup();
    await t.run(["init"]);
    expect(await t.run(["interfaces", "--scan"])).toBe(0);
    const out = t.out.join("");
    expect(out).toMatch(/pc_interface "PLCSIM" \(number 1\)/);
    expect(out).toMatch(/reachable: plc_1 192\.168\.0\.1/);
    expect(out).toContain('[plc.PLC_1]\nmode = "PN/IE"\npc_interface = "PLCSIM"');
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
