// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig } from "@rung/core";
import { cmdBackupDiff, cmdBackupVerify, cmdPlcBackup, type PlcBackupSteps } from "../src/plcBackup.js";
import type { Io } from "../src/common.js";

const SHA = "AB".repeat(32);
const DB = 'DATA_BLOCK "G"\n   VAR \n      n : Int;\n      on : Bool;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n';

function fakes(over: Partial<PlcBackupSteps> = {}, value = 7) {
  const calls: string[] = [];
  const steps: PlcBackupSteps = {
    init: async (dir, v) => {
      calls.push("init");
      const project = String(v.project);
      await mkdir(join(project, ".."), { recursive: true }); await writeFile(project, "project");
      await saveConfig(dir, defaultConfig(project, "V20", "", []));
      return 0;
    },
    pull: async dir => { calls.push("pull"); await mkdir(join(dir, "plc", "P", "blocks"), { recursive: true }); await writeFile(join(dir, "plc", "P", "blocks", "G.db"), DB); return 0; },
    compare: async (_dir, _v, io) => { calls.push("compare"); io.stdout(JSON.stringify({ items: [], identical: 3 })); return 0; },
    compile: async () => { calls.push("compile"); return 0; },
    release: async () => { calls.push("release"); return 0; },
    open: async () => false,
    archive: async (_dir, out) => { calls.push("archive"); await writeFile(join(out, "upload.zap20"), "zap"); return join(out, "upload.zap20"); },
    certificate: async () => ({ certificateSha256: SHA, details: "SHA-256: " + SHA }),
    reader: async () => ({
      read: async names => names.map(name => ({ name, value: name.endsWith(".n") ? value : true })),
      state: async () => ({ at: 1, scope: { device: "P", address: "192.168.250.1", transport: "s7commplus", epoch: 1 }, identity: { cpu: "CPU 1516", firmware: "2.9", serial: "S1", plcName: "P" }, state: { mode: "Run", cycleMs: 3 } }),
      alarms: async () => ({ at: 1, scope: { device: "P", address: "192.168.250.1", transport: "s7commplus", epoch: 1 }, lcid: 1033, alarms: [] }),
      close: async () => {},
    }) as never,
    ...over,
  };
  return { steps, calls };
}

async function run(steps: PlcBackupSteps, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "rung-plcbackup-")), out: string[] = [];
  const io: Io = { cwd: root, env: {}, stdout: s => { out.push(s); }, stderr: () => {} };
  // upload.log tells the device the upload brought, as rung init prints it
  const init = steps.init;
  steps.init = async (dir, v, sink) => { const code = await init(dir, v, sink); sink.stdout(`Bound ${dir} to x (V20, devices: P).\n`); return code; };
  const code = await cmdPlcBackup({ "from-plc": "192.168.250.1", out: "b", "expect-sha256": SHA, ...extra }, io, steps);
  return { code, dir: join(root, "b"), root, out: out.join(""), io };
}

describe("rung backup --from-plc", () => {
  it("runs every step in order and writes a complete, hashed bundle", async () => {
    const { steps, calls } = fakes();
    const r = await run(steps);
    expect(r.code).toBe(0);
    expect(calls).toEqual(["init", "compare", "archive", "compile", "pull", "release"]);
    const manifest = JSON.parse(await readFile(join(r.dir, "manifest.json"), "utf8"));
    expect(manifest.complete).toBe(true);
    expect(manifest.results.values).toMatchObject({ blocks: 1, values: 2, failed: 0 });
    expect(JSON.parse(await readFile(join(r.dir, "values", "G.json"), "utf8"))).toMatchObject({ n: { value: 7 }, on: { value: true } });
    expect((await loadConfig(join(r.dir, "program"), { raw: true })).live?.plc?.P).toMatchObject({ address: "192.168.250.1", readOnly: true, certificateSha256: SHA });
    expect(await cmdBackupVerify(r.dir, r.io)).toBe(0);
    await writeFile(join(r.dir, "cpu.json"), "{}");
    expect(await cmdBackupVerify(r.dir, r.io)).toBe(1);
  });
  it("refuses a folder that is not empty before reading anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "rung-plcbackup-"));
    await mkdir(join(root, "b")); await writeFile(join(root, "b", "x"), "");
    const { steps, calls } = fakes();
    await expect(cmdPlcBackup({ "from-plc": "192.168.250.1", out: "b" }, { cwd: root, env: {}, stdout: () => {}, stderr: () => {} }, steps)).rejects.toThrow(/not empty/);
    expect(calls).toEqual([]);
  });
  it("fails without a bundle worth keeping when the upload fails", async () => {
    const { steps, calls } = fakes({ init: async (_d, _v, io) => { io.stderr("rung: TLS_UNTRUSTED: not trusted\n"); return 1; } });
    const r = await run(steps);
    expect(r.code).toBe(1);
    expect(calls).toEqual([]);
    expect(JSON.parse(await readFile(join(r.dir, "manifest.json"), "utf8")).steps[0]).toMatchObject({ name: "upload", status: "failed", detail: "TLS_UNTRUSTED: not trusted" });
  });
  it("keeps the program but reads nothing live from a CPU whose certificate is not the expected one", async () => {
    const reader = vi.fn();
    const { steps } = fakes({ certificate: async () => ({ certificateSha256: "CD".repeat(32), details: "" }), reader });
    const r = await run(steps);
    expect(r.code).toBe(2);
    expect(reader).not.toHaveBeenCalled();
    expect(r.out).toMatch(/partial backup/);
  });
  it("waits for the bridges of the steps before to detach before closing the project", async () => {
    let tries = 0;
    const { steps } = fakes({ release: async (_d, io) => { if (++tries < 3) { io.stderr("rung: PROJECT_IN_USE: rung watch of another workspace uses it\n"); return 1; } return 0; } });
    expect((await run(steps)).code).toBe(0);
    expect(tries).toBe(3);
  });
  it("diff names the values that changed and no program files when the PLC kept its program", async () => {
    const a = await run(fakes({}, 7).steps), b = await run(fakes({}, 9).steps);
    const out: string[] = [];
    expect(await cmdBackupDiff(a.dir, b.dir, { ...a.io, stdout: s => { out.push(s); } })).toBe(0);
    expect(out.join("")).toMatch(/G\.n: 7 → 9/);
    expect(out.join("")).toMatch(/0 program files and 1 values differ/);
  });
});
