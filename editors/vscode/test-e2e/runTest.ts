// SPDX-License-Identifier: MIT
// `npm run test:e2e`: runs the integration tests in a real VS Code (Extension Development Host), once per
// workspace: "fresh" (empty folder: initialize and pull, fake bridge), "fake" (a mirrored fake project) and
// "tia" (the fixture project mirrored from TIA Portal, skipped when it is not open or S7-PLCSIM runs). Throwaway user data and extensions folders; other extensions are off.
//
//   RUNG_E2E_SUITES=fresh,fake,tia      which suites (default all three)
//   RUNG_E2E_GREP=<text>                only tests whose title contains the text
//   RUNG_E2E_TIA_WS=<folder>            TIA workspace to use as is (default: a fresh mirror of the fixture)
//   RUNG_PROJECT=<.ap20>                the fixture (default %USERPROFILE%\rung-fixtures\RungFixture\RungFixture.ap20)
//   VSCODE_EXE=<Code.exe>               VS Code to run (default: the installed one, else downloaded)
//   RUNG_E2E_KEEP=1                     keep the temp folders
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";
import { createFakeWorkspace, createFreshFolder, FAKE_PROJECT, rungCli } from "./fixture";

const extensionDir = resolve(__dirname, "..", "..", "..");
const repo = resolve(extensionDir, "..", "..");

function installedCode(): string | undefined {
  if (process.env.VSCODE_EXE) return process.env.VSCODE_EXE;
  const candidates =
    process.platform === "win32"
      ? [join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"), join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft VS Code", "Code.exe")]
      : ["/usr/share/code/code", "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"];
  return candidates.find((c) => existsSync(c));
}

const USER_SETTINGS = {
  "security.workspace.trust.enabled": false,
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "telemetry.telemetryLevel": "off",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "window.restoreWindows": "none",
  "git.enabled": false,
  "terminal.integrated.enablePersistentSessions": false,
  "terminal.integrated.confirmOnExit": "never",
  "terminal.integrated.confirmOnKill": "never",
  "rung.output.verbosity": "verbose",
  // the suites start watch themselves where they test it (it starts on its own in a real workspace)
  "rung.watch.autoStart": false,
};

async function runSuite(name: string, folder: string, base: string, env: Record<string, string>): Promise<boolean> {
  const userDir = join(base, `user-${name}`);
  mkdirSync(join(userDir, "User"), { recursive: true });
  writeFileSync(join(userDir, "User", "settings.json"), JSON.stringify(USER_SETTINGS, null, 2));
  const extensionsDir = join(base, "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  // The main process and the terminal host inherit this environment too (rung watch runs in a terminal).
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const code = installedCode();
  console.log(`\n=== suite "${name}" on ${folder} (${code ?? "downloaded VS Code"})`);
  try {
    await runTests({
      ...(code ? { vscodeExecutablePath: code } : {}),
      extensionDevelopmentPath: extensionDir,
      extensionTestsPath: join(__dirname, "suite", "index.js"),
      launchArgs: [folder, "--user-data-dir", userDir, "--extensions-dir", extensionsDir, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--new-window", "--disable-gpu",
        ...(name === "online" && process.env.RUNG_E2E_RENDERER_PORT ? [`--remote-debugging-port=${Number(process.env.RUNG_E2E_RENDERER_PORT)}`, "--remote-debugging-address=127.0.0.1"] : [])],
      extensionTestsEnv: { ...env, RUNG_E2E_SUITE: name, RUNG_E2E_REPO: repo, ...(process.env.RUNG_E2E_RENDERER_PORT ? { RUNG_E2E_RENDERER_PORT: process.env.RUNG_E2E_RENDERER_PORT } : {}), ...(process.env.RUNG_E2E_GREP ? { RUNG_E2E_GREP: process.env.RUNG_E2E_GREP } : {}) },
    });
    return true;
  } catch (e) {
    console.error(`suite "${name}" failed: ${(e as Error).message}`);
    return false;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const FIXTURE = process.env.RUNG_PROJECT ?? join(homedir(), "rung-fixtures", "RungFixture", "RungFixture.ap20");

/**
 * The TIA suite needs the fixture project open in TIA Portal and no PLC around: with S7-PLCSIM running TIA
 * offers only PLCSIM. Without RUNG_E2E_TIA_WS it mirrors the fixture into a fresh folder (init and pull).
 */
function tiaWorkspace(base: string): { folder?: string; why?: string } {
  const plcsim = spawnSync("tasklist", ["/FI", "IMAGENAME eq Siemens.Simatic.PlcSim*", "/NH"], { encoding: "utf8" }).stdout ?? "";
  if (/Siemens\.Simatic\.PlcSim/i.test(plcsim)) return { why: "S7-PLCSIM runs (this suite needs no PLC around; node tools/fixtures/plcsim.mjs stop)" };
  let folder = process.env.RUNG_E2E_TIA_WS;
  if (!folder) {
    folder = join(base, "tia");
    mkdirSync(folder, { recursive: true });
    const init = rungCli(repo, folder, {}, "init", "--project", FIXTURE, "--writes");
    if (init.code !== 0) return { why: `rung init on ${FIXTURE} failed: ${init.output.trim().split(/\r?\n/)[0]}` };
    const pull = rungCli(repo, folder, {}, "pull");
    if (pull.code !== 0 && pull.code !== 2) return { why: `rung pull failed: ${pull.output.trim().split(/\r?\n/).pop()}` };
  } else if (!existsSync(join(folder, "rung.toml"))) return { why: `${folder} has no rung.toml` };
  const r = rungCli(repo, folder, {}, "online", "--state");
  return r.code === 0 ? { folder } : { why: `TIA Portal does not answer for ${folder}: ${r.output.trim().split(/\r?\n/)[0]}` };
}

/** Devices that answer on this PC's networks (a VPN to a plant, a PLC on the desk); "" when none does. */
function answeringDevices(folder: string): string {
  const scan = rungCli(repo, folder, {}, "interfaces", "--scan", "--plc", "PLC_1");
  return [...new Set([...scan.output.matchAll(/^ {6}reachable: (.*)$/gm)].map((m) => m[1]!.trim()))].join(", ");
}

async function main(): Promise<void> {
  const suites = (process.env.RUNG_E2E_SUITES ?? "fresh,fake,tia").split(",").map((s) => s.trim());
  const base = mkdtempSync(join(tmpdir(), "rung-vscode-e2e-"));
  let ok = true;
  try {
    if (suites.includes("fresh")) {
      const fresh = createFreshFolder(repo, base);
      ok = (await runSuite("fresh", fresh.dir, base, { ...fresh.env, RUNG_E2E_OBJECTS: fresh.objects, RUNG_E2E_PROJECT: FAKE_PROJECT })) && ok;
    }
    if (suites.includes("fake")) {
      const fake = createFakeWorkspace(repo, base);
      ok = (await runSuite("fake", fake.dir, base, { ...fake.env, RUNG_E2E_OBJECTS: fake.objects })) && ok;
    }
    if (suites.includes("online")) {
      const pin = process.env.RUNG_TEST_CERT_SHA256;
      if (process.platform !== "win32" || !/^[a-fA-F0-9]{64}$/.test(pin ?? "")) throw new Error("online suite requires Windows and an explicitly approved RungProve pin");
      const gate = spawnSync("powershell.exe", ["-NoProfile", "-File", join(repo, "tools/online/plcsim-check.ps1")], { encoding: "utf8", windowsHide: true });
      if (gate.status !== 0) throw new Error(`Fixture identity refused: ${gate.stderr}`);
      const online = createFakeWorkspace(repo, base); // Project-tree fixture only; live values use the actual native host.
      const toml = join(online.dir, "rung.toml");
      writeFileSync(toml, readFileSync(toml, "utf8") + `\n[live.plc.PLC_1]\ntransport = "s7commplus"\naddress = "192.168.250.1"\ncertificate_sha256 = "${pin}"\nallow_writes = false\n`);
      ok = (await runSuite("online", online.dir, base, { ...online.env, RUNG_ONLINE_HOST: join(repo, "bridge/src/Rung.Online/bin/Release/net10.0/win-x64/publish/rung-online.exe") })) && ok;
    }
    if (suites.includes("tia")) {
      const { folder, why } = tiaWorkspace(base);
      if (!folder) console.log(`\n=== suite "tia" skipped: ${why}`);
      else {
        const answering = answeringDevices(folder);
        if (answering) console.log(`devices answer on the network (${answering}): the "no PLC" tests are skipped`);
        // the extension's own rung runs a copy of the bridge from a fresh profile's storage, at a path TIA Portal's
        // Openness whitelist cannot know: the built bridge (registered with rung setup openness) answers instead
        const bridge = join(repo, "bridge", "src", "Rung.Bridge.V20", "bin", "Release", "net48", "rung-bridge-v20.exe");
        const env: Record<string, string> = { ...(answering ? { RUNG_E2E_ANSWERING: answering } : {}), ...(existsSync(bridge) ? { RUNG_BRIDGE: bridge } : {}) };
        ok = (await runSuite("tia", folder, base, env)) && ok;
      }
    }
  } finally {
    if (process.env.RUNG_E2E_KEEP) console.log(`kept ${base}`);
    else
      try {
        rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (e) {
        console.log(`could not remove ${base} (${(e as NodeJS.ErrnoException).code}); a process of the test run still uses it`);
      }
  }
  process.exit(ok ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
