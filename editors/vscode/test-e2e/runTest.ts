// SPDX-License-Identifier: MIT
// `npm run test:e2e`: runs the integration tests in a real VS Code (Extension Development Host), once per
// workspace: "fresh" (empty folder: initialize and pull, fake bridge), "fake" (a mirrored fake project) and
// "tia" (the TIA Portal probe workspace, skipped when the fixture project is not open). Throwaway user data and extensions folders; other extensions are off.
//
//   RUNG_E2E_SUITES=fresh,fake,tia      which suites (default all three)
//   RUNG_E2E_GREP=<text>                only tests whose title contains the text
//   RUNG_E2E_TIA_WS=<folder>            TIA workspace (default %TEMP%\rung-probe-ws)
//   VSCODE_EXE=<Code.exe>               VS Code to run (default: the installed one, else downloaded)
//   RUNG_E2E_KEEP=1                     keep the temp folders
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
      launchArgs: [folder, "--user-data-dir", userDir, "--extensions-dir", extensionsDir, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--new-window", "--disable-gpu"],
      extensionTestsEnv: { ...env, RUNG_E2E_SUITE: name, RUNG_E2E_REPO: repo, ...(process.env.RUNG_E2E_GREP ? { RUNG_E2E_GREP: process.env.RUNG_E2E_GREP } : {}) },
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

/** The TIA suite needs the fixture project open in TIA Portal; `rung online --state` answers only then. */
function tiaReady(folder: string): string | undefined {
  if (!existsSync(join(folder, "rung.toml"))) return `${folder} has no rung.toml`;
  const r = rungCli(repo, folder, {}, "online", "--state");
  return r.code === 0 ? undefined : `TIA Portal does not answer for ${folder}: ${r.output.trim().split(/\r?\n/)[0]}`;
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
    if (suites.includes("tia")) {
      const folder = process.env.RUNG_E2E_TIA_WS ?? join(tmpdir(), "rung-probe-ws");
      const why = tiaReady(folder);
      if (why) console.log(`\n=== suite "tia" skipped: ${why}`);
      else ok = (await runSuite("tia", folder, base, {})) && ok;
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
