// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.js";

const fakeScript = fileURLToPath(new URL("./fake-bridge.mjs", import.meta.url));
const PROJECT = "C:\\fx\\RungFixture\\RungFixture.ap20";

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rung-cli-"));
  const objects = join(dir, "..", `objects-${Date.now()}-${Math.random()}.json`);
  writeFileSync(
    objects,
    JSON.stringify({
      project: { name: "RungFixture", path: PROJECT, tiaVersion: "V20", devices: ["PLC_1"], isLocalSession: false },
      objects: [
        { address: "plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor", content: 'FUNCTION_BLOCK "Fx_Motor"\r\nEND_FUNCTION_BLOCK\r\n' },
        { address: "plc:PLC_1/blocks/Motor%2FValve 1", content: "// valve\n" },
      ],
    }),
  );
  const out: string[] = [];
  const err: string[] = [];
  const run = (...args: string[]) =>
    main(args, {
      cwd: dir,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: { RUNG_BRIDGE: process.execPath, RUNG_BRIDGE_ARGS: JSON.stringify([fakeScript]), FAKE_OBJECTS: objects, ...env },
    });
  return { dir, run, out, err, objects };
}

describe("rung CLI from inside a workspace", () => {
  it("pull, status and sync find rung.toml in a parent folder", async () => {
    const t = setup();
    expect(await t.run("init")).toBe(0);
    const sub = join(t.dir, "plc");
    mkdirSync(sub, { recursive: true });
    const io = { cwd: sub, stdout: (s: string) => t.out.push(s), stderr: (s: string) => t.err.push(s), env: { RUNG_BRIDGE: process.execPath, RUNG_BRIDGE_ARGS: JSON.stringify([fakeScript]), FAKE_OBJECTS: t.objects } };
    expect(await main(["pull"], io)).toBe(0);
    expect(existsSync(join(t.dir, "plc", "PLC_1", "blocks", "10_Drives", "Motors", "Fx_Motor.scl"))).toBe(true);
    expect(existsSync(join(sub, "rung.toml"))).toBe(false);
    expect(await main(["status"], io)).toBe(0);
  });
});

describe("rung CLI", () => {
  it("prints help and version", async () => {
    const t = setup();
    expect(await t.run("--help")).toBe(0);
    expect(t.out.join("")).toMatch(/rung init/);
    expect(await t.run("--version")).toBe(0);
  });

  it("init binds the single open project and writes config, gitignore and AGENTS.md", async () => {
    const t = setup();
    expect(await t.run("init")).toBe(0);
    const toml = readFileSync(join(t.dir, "rung.toml"), "utf8");
    expect(toml).toContain("RungFixture.ap20");
    expect(readFileSync(join(t.dir, ".gitignore"), "utf8")).toContain(".rung/");
    expect(existsSync(join(t.dir, "AGENTS.md"))).toBe(true);
  });

  it("init refuses to overwrite an existing workspace without --rebind", async () => {
    const t = setup();
    await t.run("init");
    expect(await t.run("init")).toBe(1);
    expect(t.err.join("")).toMatch(/already/);
    expect(await t.run("init", "--rebind")).toBe(0);
  });

  it("stops at options and arguments a command does not take", async () => {
    const t = setup();
    expect(await t.run("pull", "--yes")).toBe(1);
    expect(t.err.join("")).toMatch(/rung pull has no --yes/);
    expect(await t.run("status", "a", "b")).toBe(1);
    expect(t.err.join("")).toMatch(/rung status takes one argument; unexpected: b/);
    expect(await t.run("resolve", "x.scl", "--ours", "--theirs")).toBe(1);
    expect(t.err.join("")).toMatch(/--ours and --theirs exclude each other/);
  });

  it("test says so when there are no tests instead of 0/0 passed", async () => {
    const t = setup();
    expect(await t.run("test")).toBe(1);
    expect(t.out.join("")).toMatch(/^no tests: rung test runs tests\/\*\*\/\*\.test\.yaml/);
  });

  it("init --tia must match the TIA Portal that has the project open", async () => {
    const t = setup();
    expect(await t.run("init", "--tia", "V21")).toBe(1);
    expect(t.err.join("")).toMatch(/BAD_ARGUMENT: --tia V21 does not match: .*RungFixture\.ap20 is open in TIA Portal V20/);
    expect(existsSync(join(t.dir, "rung.toml"))).toBe(false);
  });

  it("init with --project fails clearly when that project is not open", async () => {
    const t = setup();
    expect(await t.run("init", "--project", "C:\\nope\\Nope.ap20")).toBe(1);
    expect(t.err.join("")).toMatch(/NO_PROJECT/);
  });

  it("pull mirrors the project and a second pull is a no-op", async () => {
    const t = setup();
    await t.run("init");
    expect(await t.run("pull")).toBe(0);
    expect(readFileSync(join(t.dir, "plc", "PLC_1", "blocks", "10_Drives", "Motors", "Fx_Motor.scl"), "utf8")).toBe('FUNCTION_BLOCK "Fx_Motor"\nEND_FUNCTION_BLOCK\n');
    expect(t.out.join("")).toMatch(/exported\s+2/);
    t.out.length = 0;
    expect(await t.run("pull")).toBe(0);
    expect(t.out.join("")).toMatch(/unchanged\s+2/);
  });

  it("keeps working after a PLC is added to the project (devices = all)", async () => {
    const t = setup();
    await t.run("init");
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    db.project.devices.push("PLC_2");
    writeFileSync(t.objects, JSON.stringify(db));
    expect(await t.run("pull")).toBe(0);
  });

  it("init --rebind keeps the user's sync settings", async () => {
    const t = setup();
    await t.run("init");
    const cfg = join(t.dir, "rung.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("pollMs = 2000", "pollMs = 5000"));
    expect(await t.run("init", "--rebind")).toBe(0);
    expect(readFileSync(cfg, "utf8")).toContain("pollMs = 5000");
  });

  it("pull exits 2 when there are warnings", async () => {
    const t = setup();
    await t.run("init");
    await t.run("pull");
    writeFileSync(join(t.dir, "plc", "PLC_1", "blocks", "Motor%2FValve 1.scl"), "// my edit\n");
    expect(await t.run("pull")).toBe(2);
    expect(t.out.join("")).toMatch(/LOCAL_CHANGES/);
  });

  it("explains ACCESS_DENIED", async () => {
    const t = setup();
    await t.run("init");
    const denied = setup({ FAKE_ACCESS_DENIED: "1" });
    writeFileSync(join(denied.dir, "rung.toml"), readFileSync(join(t.dir, "rung.toml")));
    expect(await denied.run("pull")).toBe(1);
    expect(denied.err.join("")).toMatch(/Siemens TIA Openness/);
  });

  it("pull outside a workspace fails with a hint", async () => {
    const t = setup();
    expect(await t.run("pull")).toBe(1);
    expect(t.err.join("")).toMatch(/rung init/);
  });

  it("doctor requires --fixture", async () => {
    const t = setup();
    await t.run("init");
    expect(await t.run("doctor")).toBe(1);
    expect(t.err.join("")).toMatch(/--fixture/);
    expect(await t.run("doctor", "--fixture")).toBe(0);
    expect(t.out.join("")).toMatch(/scl/);
  });

  it("status lists objects needing attention", async () => {
    const t = setup();
    await t.run("init");
    await t.run("pull");
    expect(await t.run("status")).toBe(0);
    expect(t.out.join("")).toMatch(/2 objects, 2 synced/);
  });
});
