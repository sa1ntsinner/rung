// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.js";
import { retrievePlan, retrievedProject } from "../src/upgrade.js";

// a bridge that answers --retrieve like the real one: the project in a folder under --target, or an error
const FAKE = `const a = process.argv.slice(2), at = (k) => a[a.indexOf(k) + 1];
require("node:fs").writeFileSync(process.env.RUNG_FAKE_LOG, JSON.stringify(a));
if (process.env.RUNG_FAKE_FAIL) { console.log(JSON.stringify({ error: "the archive is damaged" })); process.exit(1); }
const dir = require("node:path").join(at("--target"), "Line"); require("node:fs").mkdirSync(dir);
const ap = require("node:path").join(dir, "Line.ap20"); require("node:fs").writeFileSync(ap, "");
console.log(JSON.stringify({ tiaPid: 0 })); console.log(JSON.stringify({ path: ap }));`;

function fixture(fail = false) {
  const cwd = mkdtempSync(join(tmpdir(), "rung-archive-"));
  writeFileSync(join(cwd, "fake.cjs"), FAKE);
  writeFileSync(join(cwd, "Line.zap20"), "archive");
  let out = "", err = "";
  const env = { RUNG_BRIDGE: process.execPath, RUNG_BRIDGE_ARGS: JSON.stringify([join(cwd, "fake.cjs")]), RUNG_FAKE_LOG: join(cwd, "args.json"), ...(fail ? { RUNG_FAKE_FAIL: "1" } : {}) };
  const io = { cwd, env, stdout: (s: string) => { out += s; }, stderr: (s: string) => { err += s; } };
  return { cwd, io, out: () => out, err: () => err };
}

describe("archives: rung retrieve, and rung init on an archive", () => {
  it("retrieves an archive into a folder named after it, by the TIA Portal of its version", async () => {
    const t = fixture();
    expect(await main(["retrieve", "Line.zap20"], t.io)).toBe(0);
    const args = JSON.parse(readFileSync(join(t.cwd, "args.json"), "utf8"));
    expect(args.slice(0, 3)).toEqual(["--retrieve", "--project", join(t.cwd, "Line.zap20")]);
    expect(args[4]).toMatch(/\.rung-retrieve-\d+$/);
    expect(t.out()).toContain(`retrieved: ${join(t.cwd, "Line", "Line.ap20")}`);
    expect(existsSync(args[4])).toBe(false); // the staging folder is gone
    // again: the earlier retrieve is used, the bridge does not start
    writeFileSync(join(t.cwd, "args.json"), "untouched");
    expect(await main(["retrieve", "Line.zap20"], t.io)).toBe(0);
    expect(readFileSync(join(t.cwd, "args.json"), "utf8")).toBe("untouched");
    expect(t.err()).toMatch(/retrieved before/);
  });

  it("rung init on an archive retrieves it first; a refused retrieve leaves no folder and no workspace", async () => {
    const t = fixture(true);
    expect(await main(["init", "--project", "Line.zap20"], t.io)).toBe(1);
    expect(JSON.parse(readFileSync(join(t.cwd, "args.json"), "utf8"))[0]).toBe("--retrieve");
    expect(t.err()).toMatch(/did not retrieve Line\.zap20: the archive is damaged/);
    expect(existsSync(join(t.cwd, "Line"))).toBe(false);
    expect(existsSync(join(t.cwd, "rung.toml"))).toBe(false);
  });

  it("plans the version: an archive of V19-V21 by its own TIA Portal, an older one upgraded by V20", () => {
    expect(retrievePlan(join("D:", "a", "Line.ZAP21"), undefined)).toEqual({ from: 21, to: "V21", upgrade: false, target: join("D:", "a", "Line") });
    expect(retrievePlan("Line.zap17", undefined)).toMatchObject({ to: "V20", upgrade: true });
    expect(() => retrievePlan("Line.zap22", undefined)).toThrow(/V19, V20 and V21/);
    expect(() => retrievePlan("Line.zap21", "V20")).toThrow(/cannot retrieve/);
    expect(() => retrievePlan("Line.ap20", undefined)).toThrow(/archive/);
  });

  it("finds the one project an earlier retrieve left, and nothing in a folder of several", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-retrieved-"));
    mkdirSync(join(root, "Line"));
    writeFileSync(join(root, "Line", "Line.ap20"), "");
    expect(await retrievedProject(root)).toBe(join(root, "Line", "Line.ap20"));
    writeFileSync(join(root, "Other.ap20"), "");
    expect(await retrievedProject(root)).toBeUndefined();
  });
});
