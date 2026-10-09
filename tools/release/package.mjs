// SPDX-License-Identifier: MIT
// Builds the Windows release archive: rung.exe + bridge + editor packages + licences.
//   node tools/release/package.mjs [--skip-build]
// Output: dist/release/rung-<version>-win-x64.zip, the npm package rung-plc-cli-<version>.tgz and SHA256SUMS.txt. The programs are not code-signed: the checksums
// on the release page are how a download is checked. Publishing is a manual step.
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stageOnline, auditOnlineRelease } from "./online.mjs";

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
  run("dotnet publish bridge/src/Rung.Online -c Release -r win-x64 --self-contained true");
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "bridge"), { recursive: true });
cpSync(join(out, "rung.exe"), join(stage, "rung.exe"));
// the same CLI for any OS with Node.js 22+: CI runners on Linux run the language server checks and rung test with it
cpSync(join(out, "rung.cjs"), join(stage, "rung.cjs"));
const bridgeBin = join(root, "bridge", "src", "Rung.Bridge.V20", "bin", "Release", "net48");
for (const f of readdirSync(bridgeBin)) if (!f.endsWith(".pdb")) cpSync(join(bridgeBin, f), join(stage, "bridge", f));
stageOnline(root, stage, join(root, "bridge", "src", "Rung.Online", "bin", "Release", "net10.0", "win-x64", "publish"));
// the CODESYS bridge is a script that runs inside CODESYS (rung codesys-bridge starts it)
mkdirSync(join(stage, "bridge", "codesys"), { recursive: true });
cpSync(join(root, "bridge", "codesys", "rung_bridge_codesys.py"), join(stage, "bridge", "codesys", "rung_bridge_codesys.py"));
cpSync(join(root, "agents", "AGENTS.template.md"), join(stage, "AGENTS.template.md"));
// rung setup openness uses it to register the bridge in the Openness whitelist
cpSync(join(root, "tools", "openness", "Register-OpennessWhitelist.ps1"), join(stage, "tools", "Register-OpennessWhitelist.ps1"));
cpSync(join(root, "agents", "claude-plugin"), join(stage, "agents", "claude-plugin"), { recursive: true });
cpSync(join(root, "agents", ".claude-plugin"), join(stage, "agents", ".claude-plugin"), { recursive: true });
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
writeFileSync(join(stage, "THIRD_PARTY_NOTICES.txt"), readFileSync(join(stage, "THIRD_PARTY_NOTICES.txt"), "utf8") +
  "\nS7CommPlusDriver (upstream 5c84e77, modified): LGPL-3.0-or-later. Corresponding source and replacement/debugging permission: source/S7CommPlusDriver/REPLACEMENT.md. GNU LGPL and GPL texts: LICENSES/.\n" +
  "BouncyCastle.Cryptography 2.7.0: MIT, LICENSES/BouncyCastle-MIT.txt.\n" +
  "zlib.net-mutliplatform 1.1.0: BSD-3-Clause, Copyright 2006-2007 ComponentAce, 2022-2025 Sjofn LLC, LICENSES/zlib.net-BSD-3-Clause.txt.\n" +
  "Microsoft .NET 10 runtime and Microsoft.Extensions.*: MIT; runtime source https://github.com/dotnet/runtime; dependency source https://github.com/dotnet/dotnet.\n");
writeFileSync(
  join(stage, "README.txt"),
  `rung ${version} — PLC projects of TIA Portal and CODESYS as plain text\n\n1. Put this folder somewhere permanent and add it to PATH.\n2. Run rung check: it lists what is installed and what is missing (for TIA Portal: your Windows user in the group "Siemens TIA Openness").\n3. In an empty folder: rung init --project <your project>, rung pull, rung watch.\n4. Editors and agents: rung setup (asks first; rung setup --dry-run shows what it would change).\n\nrung.cjs is the same CLI for any OS with Node.js 22 or newer (node rung.cjs test on a Linux CI runner).\n\nLicence: see LICENSE.txt (core BUSL-1.1, free for individuals and organizations of up to 3 users; editor, grammar and file format MIT).\n`,
);

// Audit: no Siemens binaries may ever be redistributed.
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const siemens = walk(stage).filter((f) => /siemens.*\.(dll|exe|so|dylib)$/i.test(relative(stage, f)));
if (siemens.length) throw new Error(`Siemens files in the release: ${siemens.join(", ")}`);
auditOnlineRelease(stage);

// The VS Code extension carries the same rung without rung.exe (VS Code's own Node.js runs rung.cjs), so installing
// the extension is enough. VERSION changes with the content: the extension copies a new one into place.
const inExt = join(root, "editors", "vscode", "rung");
rmSync(inExt, { recursive: true, force: true });
cpSync(stage, inExt, { recursive: true, filter: (src) => relative(stage, src) !== "rung.exe" });
const digest = createHash("sha256");
for (const f of walk(inExt).sort()) digest.update(relative(inExt, f)).update(readFileSync(f));
writeFileSync(join(inExt, "VERSION"), `${version}+${digest.digest("hex").slice(0, 12)}\n`);
if (!process.argv.includes("--skip-build")) run("npm run package", join(root, "editors", "vscode"));
const vsix = join(root, "editors", "vscode", "rung-scl.vsix");
if (existsSync(vsix)) cpSync(vsix, join(stage, "editors", "rung-scl.vsix"));

// npm: @rung-plc/cli is the same folder without rung.exe and the editor packages, for Linux and macOS (the language
// server, rung test, the bridge over ssh) and for CI. npm links bin entries straight to the file there, so it needs a #!.
const npmStage = join(out, "npm");
rmSync(npmStage, { recursive: true, force: true });
cpSync(stage, npmStage, { recursive: true, filter: (src) => !["rung.exe", "editors", "README.txt"].includes(relative(stage, src)) });
writeFileSync(join(npmStage, "rung.cjs"), "#!/usr/bin/env node\n" + readFileSync(join(stage, "rung.cjs"), "utf8"));
writeFileSync(
  join(npmStage, "package.json"),
  JSON.stringify(
    {
      name: "@rung-plc/cli",
      version,
      description: "TIA Portal and CODESYS projects as plain text: two-way sync, an SCL language server, PLC tests without a PLC and tools for coding agents.",
      license: "SEE LICENSE IN LICENSE.txt",
      homepage: "https://sa1ntsinner.github.io/rung/",
      repository: { type: "git", url: "git+https://github.com/sa1ntsinner/rung.git" },
      bugs: "https://github.com/sa1ntsinner/rung/issues",
      bin: { rung: "rung.cjs" },
      engines: { node: ">=22" },
      keywords: ["plc", "tia-portal", "siemens", "simatic", "scl", "s7-1500", "codesys", "structured-text", "iec-61131-3", "language-server", "mcp"],
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(npmStage, "README.md"),
  `# rung\n\nTIA Portal and CODESYS projects as plain text: two-way sync, an SCL language server for VS Code, Zed and Neovim, tests without a PLC (\`rung test\`) and tools for coding agents.\n\n\`\`\`sh\nnpm install -g @rung-plc/cli\nrung check\n\`\`\`\n\nOn Windows next to TIA Portal V20 everything works; on Linux and macOS the language server, \`rung test\` and \`rung mcp\`, and sync through a Windows PC [over ssh](https://github.com/sa1ntsinner/rung/blob/main/docs/remote.md). In CI: \`npx -y @rung-plc/cli test\`.\n\n[Website](https://sa1ntsinner.github.io/rung/) · [Quickstart](https://github.com/sa1ntsinner/rung/blob/main/docs/quickstart.md) · [Docs](https://github.com/sa1ntsinner/rung/tree/main/docs)\n\nLicence: the core is BUSL-1.1, free for individuals, education, non-commercial open source and organizations of up to 3 users; see LICENSE.txt. Not affiliated with Siemens AG.\n`,
);
const [{ filename: packed }] = JSON.parse(execSync(`npm pack --json --pack-destination "${out}"`, { cwd: npmStage, encoding: "utf8" }));
const tarball = join(out, packed);

const zip = join(out, `rung-${version}-win-x64.zip`);
rmSync(zip, { force: true });
// Windows ships bsdtar (zip-capable); GNU tar from Git is not.
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
execFileSync(tar, ["-a", "-c", "-f", zip, "-C", out, `rung-${version}-win-x64`], { stdio: "inherit" });
// what the release page lists, in the format of sha256sum (Get-FileHash on Windows shows the same hex)
const sums = [zip, join(out, "rung.cjs"), join(out, "rung.exe"), join(stage, "editors", "rung-scl.vsix"), tarball]
  .filter((f) => existsSync(f))
  .map((f) => `${createHash("sha256").update(readFileSync(f)).digest("hex")}  ${f.split(/[\\/]/).pop()}`);
writeFileSync(join(out, "SHA256SUMS.txt"), sums.join("\n") + "\n");
console.log(`release: ${relative(root, zip)} (${(statSync(zip).size / 1024 / 1024).toFixed(1)} MiB), ${walk(stage).length} files, Siemens audit clean; SHA256SUMS.txt`);
