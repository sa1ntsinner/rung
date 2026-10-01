// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, handover, risks } from "../src/handover.js";

describe("download handover", () => {
  it("names what TIA Portal will ask for DB, UDT, interface and hardware changes", () => {
    const r = risks(["plc/PLC_1/blocks/DB_Recipe.db", "plc/PLC_1/types/UDT_Axis.udt", "plc/PLC_1/hardware/x.yaml"], ["FB_Valve"]);
    expect(r.join("\n")).toMatch(/reinit-db/);
    expect(r.join("\n")).toMatch(/UDT_Axis/);
    expect(r.join("\n")).toMatch(/FB_Valve.*stop-cpu/);
    expect(r.join("\n")).toMatch(/--hw/);
    expect(risks(["plc/PLC_1/blocks/FC_Scale.scl"])).toEqual([]);
  });

  it("lists uncommitted changes under plc/ from git and refuses to recommend a download with compile errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-handover-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root });
    git("init", "-q");
    mkdirSync(join(root, "plc", "PLC_1", "blocks"), { recursive: true });
    mkdirSync(join(root, ".rung"));
    writeFileSync(join(root, "plc", "PLC_1", "blocks", "FC_A.scl"), "a\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(join(root, "plc", "PLC_1", "blocks", "FC_A.scl"), "b\n");
    writeFileSync(join(root, "plc", "PLC_1", "blocks", "DB_New.db"), "db\n");
    expect((await changedFiles(root))!.sort()).toEqual(["plc/PLC_1/blocks/DB_New.db", "plc/PLC_1/blocks/FC_A.scl"]);
    const md = await handover({ root, device: "PLC_1", compileErrors: [{ path: "plc/PLC_1/blocks/FC_A.scl", line: 3, message: "Tag #x not defined." }] });
    expect(md).toMatch(/1 compile error\(s\): do not download/);
    expect(md).toMatch(/DB_New\.db/);
    expect(readFileSync(join(root, ".rung", "download-request.md"), "utf8")).toBe(md);
  }, 60_000); // starts git: slow on a busy Windows runner

  it("says so when the workspace is not a git repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-handover-"));
    expect(await changedFiles(root)).toBeNull();
  });
});
