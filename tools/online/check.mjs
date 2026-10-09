// SPDX-License-Identifier: MIT
// Offline acceptance: node tools/online/check.mjs <published-directory> [--replacement]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "../../packages/bridge-client/dist/index.js";
import { defaultConfig, saveConfig } from "../../packages/core/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const publish = resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? join(root, "bridge/src/Rung.Online/bin/Release/net10.0/win-x64/publish"));
async function check(dir, replacement = false) {
  const host = await BridgeClient.spawn({ command: join(dir, "rung-online.exe"), args: ["--stdio"], requestTimeoutMs: 5000 });
  try {
    assert(host.info.capabilities.includes("online.alarms"));
    assert(!host.info.capabilities.includes("online.commit"));
    await assert.rejects(host.request("online.commit", {}), { code: "UNSUPPORTED_CAPABILITY" });
    await assert.rejects(host.request("online.connect", { address: "192.168.1.1", device: "robot" }), { code: "TARGET_REFUSED" });
    await assert.rejects(host.request("online.connect", { address: "192.168.250.1", device: "PLC_1" }), { code: "CERTIFICATE_UNTRUSTED" });
    if (replacement) await assert.rejects(host.request("online.certificate", { address: "127.0.0.1" }));
  } finally { await host.close(); }
}
await check(publish);
console.log("Standalone host: handshake, read-only capabilities and pre-connection refusals passed.");
const installed = dirname(publish);
if (existsSync(join(installed, "rung.cjs"))) {
  const workspace = mkdtempSync(join(tmpdir(), "rung-installed-online-"));
  try {
    await saveConfig(workspace, defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]));
    const tables = join(workspace, "plc/PLC_1/watch"); mkdirSync(tables, { recursive: true });
    writeFileSync(join(tables, "Force.xml"), '<Document><SW.WatchAndForceTables.PlcForceTable ID="0"><AttributeList><Name>Denied</Name></AttributeList></SW.WatchAndForceTables.PlcForceTable></Document>');
    const env = { ...process.env }; delete env.RUNG_ONLINE_HOST; delete env.RUNG_HOME;
    let failure;
    try { execFileSync(process.execPath, [join(installed, "rung.cjs"), "live", "watch", "--table", "plc/PLC_1/watch/Force.xml", "--device", "PLC_1", "--json"], { cwd: workspace, env, windowsHide: true, timeout: 10_000, stdio: "pipe" }); }
    catch (error) { failure = error; }
    assert(failure?.status); assert.match(String(failure.stderr), /force table/i);
    console.log("Installed CLI discovered its bundled host and refused force-table XML before any PLC connection.");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}
if (process.argv.includes("--replacement")) {
  // An API-compatible test-only constructor leaves a marker when the real host loads it.
  // Its certificate probe contacts loopback only; it never reaches a PLC.
  const scratch = mkdtempSync(join(tmpdir(), "rung-driver-replacement-"));
  try {
    const source = join(scratch, "source"), marker = join(scratch, "loaded.txt");
    cpSync(join(root, "third_party/S7CommPlusDriver/src/S7CommPlusDriver"), source, { recursive: true,
      filter: path => !path.split(/[\\/]/).some(part => part === "bin" || part === "obj" || part === "runtimes") });
    const options = join(source, "S7CommPlusClientOptions.cs"), original = readFileSync(options, "utf8");
    const anchor = "public sealed class S7CommPlusClientOptions\n    {";
    const normalized = original.replaceAll("\r\n", "\n"); assert(normalized.includes(anchor));
    writeFileSync(options, normalized.replace(anchor, anchor + `\n        public S7CommPlusClientOptions() { System.IO.File.WriteAllText(@"${marker.replaceAll('"', '""')}", "replacement loaded"); }`));
    execFileSync("dotnet", ["build", source, "-c", "Release"], { stdio: "pipe", windowsHide: true });
    const hostDir = join(scratch, "host"); cpSync(publish, hostDir, { recursive: true });
    cpSync(join(source, "bin/Release/net10.0/S7CommPlusDriver.dll"), join(hostDir, "S7CommPlusDriver.dll"));
    assert.notDeepEqual(readFileSync(join(publish, "S7CommPlusDriver.dll")), readFileSync(join(hostDir, "S7CommPlusDriver.dll")));
    await check(hostDir, true); assert(existsSync(marker));
    console.log("Modified compatible DLL was loaded by the published host; no TIA or PLC was used.");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
