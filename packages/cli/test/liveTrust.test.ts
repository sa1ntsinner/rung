// SPDX-License-Identifier: BUSL-1.1
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { defaultConfig, loadConfig, saveConfig } from "@rung/core";
import { trustLiveCertificate } from "../src/liveTrust.js";
import type { Io } from "../src/common.js";
import { main } from "../src/main.js";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "rung-trust-"));
  const config = defaultConfig("p", "V20", "", ["P"]);
  config.live = { plc: { P: { transport: "s7commplus", address: "192.168.250.1", allowWrites: false } } };
  await saveConfig(root, config);
  return { root, config };
}
const fingerprint = "AB".repeat(32);
const inspect = async () => ({ address: "192.168.250.1", certificateSha256: fingerprint, details: "Subject: CPU\nSHA-256: " + fingerprint });

describe("explicit PLC certificate trust", () => {
  it("accepts the device option and reaches the explicit trust flow", async () => {
    const { root } = await workspace();
    let error = "";
    const io: Io = { cwd: root, env: {}, stdout: () => {}, stderr: text => error += text };
    expect(await main(["live", "trust", "--device", "P", "--dir", root], io)).toBe(1);
    expect(error).toContain("interactive terminal");
  });
  it("shows certificate and asks before persisting the per-PLC pin", async () => {
    const { root } = await workspace();
    let output = "";
    const io: Io = { cwd: root, env: {}, stdout: text => output += text, stderr: () => {}, prompt: async question => {
      expect(output).toContain(fingerprint);
      expect(question).toContain("P");
      expect(question).toContain("192.168.250.1");
      expect((await loadConfig(root, { raw: true })).live?.plc?.P?.certificateSha256).toBeUndefined();
      return "P";
    } };
    expect(await trustLiveCertificate(root, io, "P", inspect)).toBe(0);
    expect((await loadConfig(root, { raw: true })).live?.plc?.P?.certificateSha256).toBe(fingerprint);
  });
  it("cancellation never stores a pin", async () => {
    const { root } = await workspace();
    const io: Io = { cwd: root, env: {}, stdout: () => {}, stderr: () => {}, prompt: async () => "no" };
    expect(await trustLiveCertificate(root, io, "P", inspect)).toBe(1);
    expect((await loadConfig(root, { raw: true })).live?.plc?.P?.certificateSha256).toBeUndefined();
  });
  it("refuses unattended trust and a changed target during confirmation", async () => {
    const { root, config } = await workspace();
    const io: Io = { cwd: root, env: {}, stdout: () => {}, stderr: () => {} };
    await expect(trustLiveCertificate(root, io, "P", inspect)).rejects.toThrow(/interactive/);
    io.prompt = async () => { config.live!.plc!.P!.address = "192.168.250.2"; await saveConfig(root, config); return "P"; };
    await expect(trustLiveCertificate(root, io, "P", inspect)).rejects.toThrow(/changed/);
    expect((await loadConfig(root, { raw: true })).live?.plc?.P?.certificateSha256).toBeUndefined();
  });
});
