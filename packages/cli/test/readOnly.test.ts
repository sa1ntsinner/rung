// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "@rung/bridge-client";
import { defaultConfig, grantWrites, saveConfig } from "@rung/core";
import { parseConfig } from "@rung/core";
import { OwnerClient } from "@rung/sync";
import { WebApiError } from "@rung/live";
import * as common from "../src/common.js";
import * as live from "../src/live.js";
import { saveTarget } from "../src/connect.js";
import { main } from "../src/main.js";
import { bridgeEnv, bridgeFor, decodeArgs } from "../src/common.js";
import { cmdConnect, cmdDownload, cmdUpload, closePlcLinks } from "../src/plc.js";
import { cmdSync, cmdWatch, cmdConfirmDelete, cmdRename, cmdWrites, renameInTia } from "../src/twoway.js";
import { cmdHardware } from "../src/hardware.js";
import { cmdLibrary } from "../src/library.js";
import { cmdProjectArtifact } from "../src/project-artifact.js";
import { liveMutations } from "../src/liveMutation.js";
import type { Io } from "../src/common.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const mutations = [
  ["download", "--yes"], ["writes", "on"], ["sync"],
  ["confirm-delete", "plc:PLC_1/blocks/Motor"], ["rename", "Motor", "Other"],
  ["hardware", "--apply", "--file", "patch.json"], ["library", "--apply"],
  ["alarms", "--apply"], ["technology", "--apply"],
  ["connect", "--address", "192.168.0.1"], ["doctor", "--fixture"],
  ["upload", "--ip", "192.168.0.1"],
  ["init", "--from-plc", "192.168.0.1", "--project", "new.ap20", "--rebind"],
  ["live", "modify", "Value", "1", "--confirm-stdin", "--json"],
  ["live", "run", "--confirm-stdin", "--json"], ["live", "stop"],
];

it.each(mutations)("refuses %j before connecting or spawning under the environment lock", async (...args) => {
  const root = await mkdtemp(join(tmpdir(), "rung-readonly-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]);
  await saveConfig(root, config); await grantWrites(root, config);
  const spawn = vi.spyOn(BridgeClient, "spawn").mockRejectedValue(new Error("must not spawn"));
  const owner = vi.spyOn(OwnerClient, "connect").mockResolvedValue(null);
  const io = { cwd: root, env: { RUNG_READ_ONLY: "1" }, stdout: vi.fn(), stderr: vi.fn() };
  try {
    expect(await main(args, io)).toBe(2);
    expect(io.stderr.mock.calls.flat().join("")).toMatch(/^rung: PLC_READ_ONLY: .*RUNG_READ_ONLY.*\n$/);
    expect(spawn).not.toHaveBeenCalled(); expect(owner).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("process-wide lock dominates a supplied unlocked environment", async () => {
  vi.stubEnv("RUNG_READ_ONLY", "1");
  expect(bridgeEnv({ RUNG_READ_ONLY: "0" }, { RUNG_READ_ONLY: "0" }, true).RUNG_READ_ONLY).toBe("1");
});

const directMutations: ((root: string, io: Io) => Promise<unknown>)[] = [
  (root, io) => cmdDownload(root, { yes: true }, io),
  (root, io) => cmdUpload(root, { ip: "192.168.0.1" }, io),
  (root, io) => cmdConnect(root, { address: "192.168.0.1" }, io),
  (root, io) => cmdSync(root, io),
  (root, io) => cmdConfirmDelete(root, "Motor", io),
  (root, io) => cmdRename(root, "Motor", "Other", io),
  (root, io) => renameInTia(root, "plc:PLC_1/blocks/Motor", "Other", io),
  (root, io) => cmdWrites(root, "on", io),
  (root, io) => cmdHardware(root, ["patch.json"], false, io, true),
  (root, io) => cmdLibrary(root, undefined, false, io, { apply: true }),
  (root, io) => cmdProjectArtifact("alarms", root, io, { apply: true }),
];
it.each(directMutations)("module guard refuses before connecting or spawning", async invoke => {
  const root = await mkdtemp(join(tmpdir(), "rung-module-readonly-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]);
  await saveConfig(root, config); await grantWrites(root, config);
  const spawn = vi.spyOn(BridgeClient, "spawn").mockRejectedValue(new Error("must not spawn"));
  const owner = vi.spyOn(OwnerClient, "connect").mockResolvedValue(null);
  const io = { cwd: root, env: { RUNG_READ_ONLY: "1" }, stdout: vi.fn(), stderr: vi.fn() };
  try {
    await expect(invoke(root, io)).rejects.toMatchObject({ code: "PLC_READ_ONLY" });
    expect(spawn).not.toHaveBeenCalled(); expect(owner).not.toHaveBeenCalled();
  } finally { await closePlcLinks(); await rm(root, { recursive: true, force: true }); }
});

it("broker preparation refuses the lock before selecting a target or creating a host", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-mutation-readonly-"));
  await saveConfig(root, defaultConfig("fixture.ap20", "V20"));
  const select = vi.fn().mockRejectedValue(new Error("must not select"));
  const mutations = liveMutations(root, { RUNG_READ_ONLY: "1" }, select);
  try {
    await expect(mutations.prepare("client", {}, { kind: "run" }, {})).rejects.toMatchObject({ code: "PLC_READ_ONLY" });
    expect(select).not.toHaveBeenCalled();
  } finally { await mutations.close(); await rm(root, { recursive: true, force: true }); }
});

it("reports a Web API lock refusal with the same one-line exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-webapi-readonly-"));
  await saveConfig(root, defaultConfig("fixture.ap20", "V20"));
  vi.spyOn(common, "bridgeFor").mockRejectedValue(new WebApiError("PLC_READ_ONLY", "RUNG_READ_ONLY=1 forbids insecure TLS"));
  const io = { cwd: root, env: {}, stdout: vi.fn(), stderr: vi.fn() };
  try {
    expect(await main(["pull"], io)).toBe(2);
    expect(io.stderr.mock.calls.flat().join("")).toBe("rung: PLC_READ_ONLY: RUNG_READ_ONLY=1 forbids insecure TLS\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([true, false])("saving a discovered connection preserves read_only=%s", async readOnly => {
  const root = await mkdtemp(join(tmpdir(), "rung-connection-readonly-"));
  const config = defaultConfig("fixture.ap20", "V20");
  config.plc.PLC_1 = { mode: "PN/IE", pcInterface: "old", pcInterfaceNumber: 1, readOnly };
  await saveConfig(root, config);
  try {
    await saveTarget(root, "PLC_1", { mode: "PN/IE", pcInterface: "new", pcInterfaceNumber: 1 });
    expect(parseConfig(await readFile(join(root, "rung.toml"), "utf8")).plc.PLC_1?.readOnly).toBe(readOnly);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("forwards explicit native capture to the live monitor", async () => {
  const command = vi.spyOn(live, "cmdLive").mockResolvedValue(0);
  const io = { cwd: ".", env: {}, stdout: vi.fn(), stderr: vi.fn() };
  expect(await main(["live", "watch", "Motor", "--native-capture"], io)).toBe(0);
  expect(command.mock.calls[0]?.[4]).toMatchObject({ nativeCapture: true });
});

it.each(["env", "config"])("watch exports and previews under the %s lock without importing disk edits", async mode => {
  const root = await mkdtemp(join(tmpdir(), "rung-watch-readonly-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]);
  config.sync.pollMs = 250; config.sync.backup = "off";
  if (mode === "config") config.plc.PLC_1 = { mode: "PN/IE", pcInterface: "Ethernet", pcInterfaceNumber: 1, readOnly: true };
  await saveConfig(root, config); await grantWrites(root, config);
  const original = 'FUNCTION_BLOCK "Motor"\nBEGIN\n  #a := 1;\nEND_FUNCTION_BLOCK\n';
  const objects = join(root, "objects.json");
  await writeFile(objects, JSON.stringify({ project: { path: "fixture.ap20", name: "Fixture", tiaVersion: "V20", devices: ["PLC_1"] }, objects: [{ address: "plc:PLC_1/blocks/Motor", content: original }] }));
  const env = { RUNG_BRIDGE: process.execPath, RUNG_BRIDGE_ARGS: JSON.stringify([fileURLToPath(new URL("./fake-bridge.mjs", import.meta.url))]), FAKE_OBJECTS: objects, ...(mode === "env" ? { RUNG_READ_ONLY: "1" } : {}) };
  let stop!: () => void;
  const io = { cwd: root, env, stdout: vi.fn(), stderr: vi.fn(), stopSignal: new Promise<void>(r => { stop = r; }) };
  const watching = cmdWatch(root, io);
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (!await check()) { if (Date.now() > deadline) throw new Error("watch did not reach expected state"); await new Promise(r => setTimeout(r, 20)); }
  };
  let owner: OwnerClient | null = null;
  try {
    const file = join(root, "plc", "PLC_1", "blocks", "Motor.scl");
    await until(async () => readFile(file, "utf8").then(() => true, () => false));
    await until(async () => readFile(join(root, ".rung", "state.json"), "utf8").then(() => true, () => false));
    await writeFile(file, original.replace("1", "2"));
    await until(async () => {
      const state = JSON.parse(await readFile(join(root, ".rung", "state.json"), "utf8"));
      return state.objects["plc:PLC_1/blocks/Motor"]?.notSent?.code === "WRITES_OFF";
    });
    owner = await OwnerClient.connect(root); expect(owner).not.toBeNull();
    await expect(owner!.request("syncNow")).rejects.toMatchObject({ code: "PLC_READ_ONLY" });
    await expect(owner!.request("download", { request: { device: "PLC_1" }, confirmed: "PLC_1" })).rejects.toMatchObject({ code: "PLC_READ_ONLY" });
    await expect(owner!.request("preview")).resolves.toMatchObject({ writesOff: true });
    expect(await cmdSync(root, io, { preview: true })).toBe(0);
    const database = JSON.parse(await readFile(objects, "utf8"));
    expect(database.objects[0].content).toBe(original);
    expect(database.startArgs.flat()).not.toContain("--allow-import");
    expect(database.startArgs.flat()).not.toContain("--allow-download");
  } finally { owner?.close(); stop(); await watching; await rm(root, { recursive: true, force: true }); }
});

it("forwards a PLC config lock to local and SSH bridges without granting download rights", async () => {
  const config = defaultConfig("fixture.ap20", "V20", "fake", ["PLC_1"]);
  config.plc.PLC_1 = { mode: "PN/IE", pcInterface: "Ethernet", pcInterfaceNumber: 1, readOnly: true };
  const spawn = vi.spyOn(BridgeClient, "spawn").mockResolvedValue({ onEvent() {} } as never);
  const io = { cwd: ".", env: {}, stdout: vi.fn(), stderr: vi.fn() };
  await bridgeFor(config, io);
  expect(spawn.mock.calls[0]?.[0].env?.RUNG_READ_ONLY).toBe("1");
  expect(spawn.mock.calls[0]?.[0].env?.RUNG_CODESYS_ALLOW_DOWNLOAD).toBe("");
  config.bridge.host = "user@pc";
  await bridgeFor(config, io);
  const remote = spawn.mock.calls[1]![0];
  expect(remote.env?.RUNG_READ_ONLY).toBe("1");
  const word = remote.args?.at(-1)?.split(" --args ")[1];
  expect(decodeArgs(word!)).toContain("--read-only");
});

it("names the PLC config lock even when existing write permission was granted", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-config-readonly-"));
  const config = defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]);
  await saveConfig(root, config); await grantWrites(root, config);
  await writeFile(join(root, "rung.toml"), await readFile(join(root, "rung.toml"), "utf8") + '\n[plc.PLC_1]\nmode = "PN/IE"\npc_interface = "Ethernet"\nread_only = true\n');
  const spawn = vi.spyOn(BridgeClient, "spawn").mockRejectedValue(new Error("must not spawn"));
  const io = { cwd: root, env: {}, stdout: vi.fn(), stderr: vi.fn() };
  try {
    expect(await main(["download", "--yes"], io)).toBe(2);
    expect(io.stderr.mock.calls.flat().join("")).toContain("PLC_1");
    expect(spawn).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
