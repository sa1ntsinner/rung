// SPDX-License-Identifier: MIT
// Explicit local fixture acceptance. Never accepts a different PLC endpoint.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, saveConfig } from "../../packages/core/dist/index.js";
import { startLiveServer, brokerReader } from "../../packages/cli/dist/liveServer.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pin = process.env.RUNG_TEST_CERT_SHA256;
assert(process.argv.includes("--fixture"), "Pass --fixture to contact local RungProve");
assert(/^[A-Fa-f0-9]{64}$/.test(pin ?? ""), "Supply an explicitly approved fixture pin in RUNG_TEST_CERT_SHA256");
const mutate = process.argv.includes("--mutate");
const restart = process.argv.includes("--restart");
assert(!restart || mutate, "--restart requires --mutate for fixture control");
const observe = (samples = true) => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-File", join(repo, "tools/online/plcsim-check.ps1"), ...(samples ? ["-Samples"] : [])], { encoding: "utf8", windowsHide: true }));
const before = observe(); // Local identity is checked before any host or writer is created.
const workspace = mkdtempSync(join(tmpdir(), "rung-online-acceptance-"));
const config = defaultConfig("RungProve.ap20", "V20", "", ["PLC_1"]);
config.live = { plc: { PLC_1: { transport: "s7commplus", address: "192.168.250.1", certificateSha256: pin, allowWrites: mutate } } };
await saveConfig(workspace, config);
const env = { RUNG_ONLINE_HOST: process.env.RUNG_ONLINE_HOST ?? join(repo, "bridge/src/Rung.Online/bin/Release/net10.0/win-x64/publish/rung-online.exe") };
const server = await startLiveServer(workspace, env, { idleMs: 60_000 });
let reader, lease, alarmLease;
const frames = [], alarmFrames = [];
let checkingRecovery = false, observedStale = false;
const names = Object.keys(before.values);
const wait = async (predicate, timeout = 10_000) => { const end = Date.now() + timeout; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 50)); assert(predicate(), "Expected observation did not arrive"); };
const literal = value => typeof value === "string" ? "'" + value.replaceAll("$", () => "$$").replaceAll("'", () => "$'") + "'" : String(value);
async function operation(action) {
  assert(mutate, "Mutation flag is required"); observe(false);
  const prepared = await reader.prepare(action); console.log(JSON.stringify({ prepared, action }));
  const result = await reader.commit(prepared.operationId, prepared.preview, true);
  console.log(JSON.stringify({ result })); assert.equal(result.outcome, "acknowledged");
}
try {
  reader = await brokerReader(workspace, env, { device: "PLC_1" });
  const rows = await reader.read(names);
  for (const row of rows) { assert(!row.error, `${row.name}: ${row.error}`); assert.equal(row.value, before.values[row.name], row.name); }
  const aliases = await reader.read(["%I0.0", "%Q0.0", '"Fx_Global".Station.Mode', "%MW2", "%ID0", "%QB4"]);
  for (const [index, name] of [[0, "IArea.Fx_Inputs_0"], [1, "QArea.Fx_Outputs_0"], [2, names[1]]]) {
    assert(!aliases[index].error, aliases[index].error); assert.equal(aliases[index].value, before.values[name]);
  }
  for (const row of aliases.slice(3)) assert(row.error, "Aliases without catalogue-backed scalar tags must remain unsupported");
  console.log(JSON.stringify({ watchAliases: aliases }));
  console.log(JSON.stringify({ apiComparison: before, rows, cpu: await reader.state() }));
  lease = await reader.subscribe(Object.fromEntries(names.map(name => [name, name])), 250, frame => { frames.push(frame); if (frames.length > 256) frames.shift(); if (frame.state !== "live") { if (checkingRecovery) observedStale = true; console.log(JSON.stringify({ transportFrame: frame })); } });
  alarmLease = await reader.subscribeAlarms(1033, frame => { alarmFrames.push(frame); if (alarmFrames.length > 256) alarmFrames.shift(); console.log(JSON.stringify({ alarmFrame: frame })); });
  if (mutate) {
    for (const [name, text, value] of [[names[0], "BOOL#TRUE", true], [names[1], "INT#17", 17], [names[2], "REAL#1.5", 1.5], [names[3], "'Rung acceptance'", "Rung acceptance"]]) {
      let attempted = false;
      try {
        attempted = true; await operation({ action: "modify", name, literal: text });
        assert.equal(observe().values[name], value);
        await wait(() => frames.some(frame => frame.values[name] === value));
      } finally {
        // An unknown first outcome is observed before a distinct restoration operation; never replay it.
        if (attempted && observe().values[name] !== before.values[name]) {
          await operation({ action: "modify", name, literal: literal(before.values[name]) });
          assert.equal(observe().values[name], before.values[name]);
        }
      }
    }
    await operation({ action: "stop" }); await wait(() => observe(false).mode === "Stop");
    await operation({ action: "run" }); await wait(() => observe(false).mode === "Run");
  }
  await new Promise(r => setTimeout(r, 20_000));
  assert(frames.length > 0 && frames.at(-1).state === "live", "Subscription must survive CPU health checks");
  assert(alarmFrames.length > 0, "Initial alarm snapshot is required");
  if (restart) {
    const epoch = frames.at(-1).scope.epoch; checkingRecovery = true;
    console.log(execFileSync("powershell.exe", ["-NoProfile", "-File", join(repo, "tools/online/plcsim-cycle.ps1"), "-Fixture"], { encoding: "utf8", windowsHide: true }));
    await wait(() => frames.at(-1)?.state === "live" && frames.at(-1).scope.epoch > epoch, 60_000);
    assert(observedStale, "Power loss must emit stale/recovery state");
    assert.equal(observe().mode, before.mode);
    console.log(JSON.stringify({ recoveredEpoch: frames.at(-1).scope.epoch }));
  }
  const warmFirstValues = [];
  for (let n = 0; n < 10; n++) {
    const started = performance.now(); let first;
    const monitor = await reader.subscribe({ mode: names[1] }, 250, frame => { if (frame.state === "live" && first === undefined) first = performance.now() - started; });
    try { await wait(() => first !== undefined); warmFirstValues.push(first); }
    finally { await monitor.close(); }
  }
  console.log(JSON.stringify({ warmFirstValuesMs: warmFirstValues }));
  console.log(JSON.stringify({ final: observe(), frames: frames.length, alarmFrames, alarms: await reader.alarms(1033) }));
} finally {
  try { if (reader && mutate && observe(false).mode !== before.mode) await operation({ action: before.mode === "Run" ? "run" : "stop" }); }
  finally {
    try { await alarmLease?.close(); await lease?.close(); }
    finally { try { await reader?.close(); } finally { await server.close(); rmSync(workspace, { recursive: true, force: true }); } }
  }
}
