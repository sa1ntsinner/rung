// SPDX-License-Identifier: MIT
// Builds the Windows release archive: rung.exe + bridge + editor packages + licences.
//   node tools/release/package.mjs [--skip-build]
// Output: dist/release/rung-<version>-win-x64.zip (unsigned; signing and publishing are manual steps).
import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = join(root, "dist", "release");
const version = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8")).version;
const stage = join(out, `rung-${version}-win-x64`);
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

if (!process.argv.includes("--skip-build")) {
  run("pnpm build");
  run(`"${process.execPath}" tools/release/bundle.mjs`);
  run(`"${process.execPath}" tools/release/sea.mjs`);
  run("dotnet build bridge/src/Rung.Bridge.V20 -c Release");
  run("npm run package", join(root, "editors", "vscode"));
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "bridge"), { recursive: true });
cpSync(join(out, "rung.exe"), join(stage, "rung.exe"));
const bridgeBin = join(root, "bridge", "src", "Rung.Bridge.V20", "bin", "Release", "net48");
for (const f of readdirSync(bridgeBin)) if (!f.endsWith(".pdb")) cpSync(join(bridgeBin, f), join(stage, "bridge", f));
cpSync(join(root, "agents", "AGENTS.template.md"), join(stage, "AGENTS.template.md"));
cpSync(join(root, "agents", "claude-plugin"), join(stage, "agents", "claude-plugin"), { recursive: true });
cpSync(join(root, "agents", ".claude-plugin"), join(stage, "agents", ".claude-plugin"), { recursive: true });
const vsix = join(root, "editors", "vscode", "rung-scl.vsix");
if (existsSync(vsix)) cpSync(vsix, join(stage, "editors", "rung-scl.vsix"));
cpSync(join(root, "LICENSE"), join(stage, "LICENSE.txt"));
cpSync(join(root, "LICENSES"), join(stage, "LICENSES"), { recursive: true });
cpSync(join(out, "THIRD_PARTY_NOTICES.txt"), join(stage, "THIRD_PARTY_NOTICES.txt"));
writeFileSync(
  join(stage, "THIRD_PARTY_NOTICES.txt"),
  readFileSync(join(stage, "THIRD_PARTY_NOTICES.txt"), "utf8") +
    "\nThe bridge folder contains Microsoft .NET libraries (System.Text.Json and dependencies, MIT licence, https://github.com/dotnet/runtime).\n" +
    "rung.exe embeds the Node.js runtime (MIT licence, https://github.com/nodejs/node/blob/main/LICENSE).\n" +
    "Siemens TIA Portal Openness libraries are NOT included; rung uses the ones installed with TIA Portal.\n",
);
writeFileSync(
  join(stage, "README.txt"),
  `rung ${version} — PLC-as-code for Siemens TIA Portal\n\n1. Put this folder somewhere permanent and add it to PATH.\n2. Make sure your Windows user is in the group "Siemens TIA Openness".\n3. Open your project in TIA Portal, then in an empty folder: rung init, rung pull, rung watch.\n4. Editors: install editors/rung-scl.vsix in VS Code; Zed and Neovim: see https://github.com/sa1ntsinner/rung/tree/main/docs/editors\n5. Agents: claude mcp add rung -- rung mcp (or the plugin in agents/).\n\nLicence: see LICENSE.txt (core BUSL-1.1 with free use for individuals and teams up to 3 users; editor/grammar parts MIT).\n`,
);

// Audit: no Siemens binaries may ever be redistributed.
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const siemens = walk(stage).filter((f) => /siemens/i.test(relative(stage, f)));
if (siemens.length) throw new Error(`Siemens files in the release: ${siemens.join(", ")}`);

const zip = join(out, `rung-${version}-win-x64.zip`);
rmSync(zip, { force: true });
// Windows ships bsdtar (zip-capable); GNU tar from Git is not.
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
execFileSync(tar, ["-a", "-c", "-f", zip, "-C", out, `rung-${version}-win-x64`], { stdio: "inherit" });
console.log(`release: ${relative(root, zip)} (${(statSync(zip).size / 1024 / 1024).toFixed(1)} MiB), ${walk(stage).length} files, Siemens audit clean`);
