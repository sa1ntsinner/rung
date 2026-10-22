// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newObject, type NewKind } from "@rung/lsp";
import { main } from "../src/main.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function workspace(plcs = ["PLC_1"]) {
  const dir = mkdtempSync(join(tmpdir(), "rung-new-"));
  dirs.push(dir);
  writeFileSync(join(dir, "rung.toml"), `format = 1\ndevices = ${JSON.stringify(plcs)}\n[project]\npath = "unused.ap20"\ntiaVersion = "V20"\n`);
  for (const plc of plcs) mkdirSync(join(dir, "plc", plc, "blocks"), { recursive: true });
  let out = "", err = "";
  const io = { cwd: dir, env: {}, stdout: (s: string) => { out += s; }, stderr: (s: string) => { err += s; } };
  return { dir, io, out: () => out, err: () => err };
}
const empty = () => ({ names: new Set<string>(), types: new Set<string>(), tables: new Set<string>(), paths: [] });
describe("rung new", () => {
  it.each(["fb", "fc", "ob", "db", "udt", "tags"])("creates %s with the wizard text and path", async (kind) => {
    const t = workspace();
    const expected = newObject({ kind: kind.toUpperCase() as NewKind, name: "New Object", plc: "PLC_1", groups: ["Line", "Drive"] }, empty());
    if ("reason" in expected) throw new Error(expected.reason);
    expect(await main(["new", kind, "New Object", "--folder", "Line/Drive", "--json"], t.io)).toBe(0);
    expect(JSON.parse(t.out())).toEqual({ path: expected.path, kind: kind.toUpperCase() });
    expect(readFileSync(join(t.dir, expected.path), "utf8")).toBe(expected.text);
  });
  it("selects a PLC explicitly and resolves --dir from the caller", async () => {
    const t = workspace(["PLC_1", "PLC_2"]);
    expect(await main(["new", "fc", "Scale", "--plc", "PLC_2", "--returns", "Real", "--dir", t.dir], { ...t.io, cwd: tmpdir() })).toBe(0);
    expect(t.out().trim()).toBe("plc/PLC_2/blocks/Scale.scl");
    expect(readFileSync(join(t.dir, t.out().trim()), "utf8")).toContain('FUNCTION "Scale" : Real');
  });
  it("requires a PLC when several exist and lists them without writing", async () => {
    const t = workspace(["PLC_1", "PLC_2"]);
    expect(await main(["new", "fb", "Motor"], t.io)).toBe(1);
    expect(t.err()).toMatch(/PLC_1.*PLC_2/);
    expect(readdirSync(join(t.dir, "plc/PLC_1/blocks"))).toEqual([]);
  });
  it("creates an instance DB using the selected FB memory layout", async () => {
    const t = workspace(["PLC_1", "PLC_2"]);
    writeFileSync(join(t.dir, "plc/PLC_1/blocks/Motor.scl"), `FUNCTION_BLOCK "Motor"\n{ S7_Optimized_Access := 'FALSE' }\nBEGIN\nEND_FUNCTION_BLOCK\n`);
    writeFileSync(join(t.dir, "plc/PLC_2/blocks/Motor.scl"), 'FUNCTION_BLOCK "Motor"\nBEGIN\nEND_FUNCTION_BLOCK\n');
    expect(await main(["new", "db", "Motor_DB", "--of", "motor", "--plc", "PLC_1"], t.io)).toBe(0);
    expect(readFileSync(join(t.dir, t.out().trim()), "utf8")).toBe(`DATA_BLOCK "Motor_DB"\n{ S7_Optimized_Access := 'FALSE' }\nVERSION : 0.1\nNON_RETAIN\n"Motor"\n\nBEGIN\n\nEND_DATA_BLOCK\n`);
  });
  it("refuses an FB in another PLC and suggests the closest local FB", async () => {
    const t = workspace(["PLC_1", "PLC_2"]);
    writeFileSync(join(t.dir, "plc/PLC_1/blocks/Motor.scl"), 'FUNCTION_BLOCK "Motor"\nBEGIN\nEND_FUNCTION_BLOCK');
    writeFileSync(join(t.dir, "plc/PLC_2/blocks/Moter.scl"), 'FUNCTION_BLOCK "Moter"\nBEGIN\nEND_FUNCTION_BLOCK');
    expect(await main(["new", "db", "Drive", "--of", "Moter", "--plc", "PLC_1"], t.io)).toBe(1);
    expect(t.err()).toContain("Motor");
    expect(readdirSync(join(t.dir, "plc/PLC_1/blocks"))).toEqual(["Motor.scl"]);
  });
  it.each([["fb", "Name", "--returns", "Int"], ["fc", "Name", "--of", "Motor"], ["other", "Name"], ["fb"], ["fb", 'Bad"Name'], ["fb", "Name", "--plc", "Missing"]])("refuses invalid arguments %j", async (...args) => {
    const t = workspace();
    expect(await main(["new", ...args], t.io)).toBe(1);
    expect(t.err()).not.toBe("");
    expect(readdirSync(join(t.dir, "plc/PLC_1/blocks"))).toEqual([]);
  });
  it("refuses duplicate names across folders without replacing files", async () => {
    const t = workspace();
    expect(await main(["new", "fb", "Motor"], t.io)).toBe(0);
    expect(await main(["new", "fc", "motor", "--folder", "Other"], t.io)).toBe(1);
    expect(t.err()).toContain("already");
    expect(readdirSync(join(t.dir, "plc/PLC_1/blocks"))).toEqual(["Motor.scl"]);
  });
  it("documents every new command option in command help", async () => {
    const t = workspace();
    expect(await main(["new", "--help"], t.io)).toBe(0);
    for (const flag of ["plc", "folder", "returns", "of", "dir", "json"]) expect(t.out()).toContain(`--${flag}`);
  });
});
