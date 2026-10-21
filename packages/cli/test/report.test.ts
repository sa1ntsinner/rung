// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig, type CheckItem } from "@rung/core";
import { buildReport } from "../src/report.js";

const checks: CheckItem[] = [
  { id: "tia", group: "plc", name: "TIA Portal", status: "ok", detail: "V20 Update 3 at C:\\Users\\elmir\\Siemens", enables: "sync" },
  { id: "git", group: "base", name: "Git", status: "ok", detail: "C:\\Program Files\\Git\\bin\\git.exe", enables: "history" },
  { id: "whitelist", group: "plc", name: "Openness allow list", status: "missing", enables: "TIA without a prompt", fix: "rung setup openness" },
];

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "rung-report-"));
  const config = defaultConfig("D:\\Secret\\LineSecret.ap20", "V20", "", ["PLC_Secret"]);
  config.live = { plc: { PLC_Secret: { transport: "s7commplus", address: "10.20.30.40", allowWrites: false, readOnly: true, certificateSha256: "AB".repeat(32) } } };
  await saveConfig(root, config);
  await mkdir(join(root, ".rung"), { recursive: true });
  const obj = (address: string, form: string, status: string, readOnly = false) => ({ address, path: `plc/PLC_Secret/blocks/${address}.scl`, form, fileHash: "", files: [], tiaFingerprint: "", baseId: "", readOnly, warnings: [], status });
  await writeFile(join(root, ".rung", "state.json"), JSON.stringify({
    format: 1, workspaceId: "w", binding: { projectPath: "D:\\Secret\\LineSecret.ap20", tiaVersion: "V20", devices: ["PLC_Secret"] },
    objects: {
      a: obj("FB_SecretMotor", "scl", "synced"),
      b: obj("FB_SecretValve", "scl", "conflicted"),
      c: obj("Main", "sd", "synced", true),
    },
  }));
  return root;
}

describe("rung report", () => {
  it("says what an issue needs and nothing of the project's names, paths or addresses", async () => {
    const root = await workspace();
    const text = await buildReport({ dir: root, checks, platform: "win32", release: "10.0.26200", node: "v22.1.0", home: "C:\\Users\\elmir" });
    expect(text).toMatch(/rung \d+\.\d+\.\d+/);
    expect(text).toContain("win32 10.0.26200");
    expect(text).toContain("V20");
    expect(text).toMatch(/objects\s*\|?\s*3/);
    expect(text).toMatch(/conflicted\s*\|?\s*1/);
    expect(text).toContain("| scl files | 2 |");
    expect(text).toContain("missing");
    expect(text).toContain("rung setup openness");
    expect(text).toContain("s7commplus");
    expect(text).toMatch(/read-only/);
    for (const secret of ["Program Files", "Secret", "10.20.30.40", "elmir", "ABAB"]) expect(text).not.toContain(secret);
  });

  it("works outside a workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rung-report-none-"));
    const text = await buildReport({ dir, checks, platform: "linux", release: "6.8", node: "v22.1.0", home: "/home/x" });
    expect(text).toContain("no rung workspace");
  });
});
