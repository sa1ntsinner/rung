// SPDX-License-Identifier: BUSL-1.1
// rung check: what is installed on this PC, what each thing enables, and how to get what is missing.
// Used by the CLI (pretty or --json), the MCP tool rung_check (agents learn what they can use) and editors.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type CheckStatus = "ok" | "missing" | "warn" | "na";
export interface CheckItem {
  id: string;
  group: "plc" | "editor" | "agent" | "base";
  name: string;
  status: CheckStatus;
  /** version or what was found */
  detail?: string;
  /** what rung can do with it */
  enables: string;
  /** what to do when it is missing or needs attention */
  fix?: string;
  link?: string;
}

export interface WindowsInventory {
  installed: { name: string; version: string }[];
  opennessApis: string[];
  inOpennessGroup: boolean | null;
  twincatDir: string | null;
  codesys: string[];
}

export interface Probes {
  platform: NodeJS.Platform;
  nodeVersion: string;
  windows(): Promise<WindowsInventory | null>;
  which(cmd: string): string | null;
  vscodeExtensions(): Promise<string[] | null>;
  zedExtensions(): string[] | null;
  exists(path: string): boolean;
  home: string;
  bridgeWhitelisted(): Promise<"ok" | "missing" | "stale" | "unknown">;
}

export const LINKS = {
  tia: "https://www.siemens.com/tia-portal",
  siemensSupport: "https://support.industry.siemens.com",
  plcsimAdvanced: "https://www.siemens.com/en-us/products/simatic/s7-plcsim-advanced/",
  twincat: "https://www.beckhoff.com/en-en/support/download-finder/",
  codesys: "https://store.codesys.com/",
  vscode: "https://code.visualstudio.com/",
  zed: "https://zed.dev/download",
  neovim: "https://neovim.io/",
  node: "https://nodejs.org/",
  git: "https://git-scm.com/downloads",
  claude: "https://docs.claude.com/en/docs/claude-code/overview",
  codex: "https://github.com/openai/codex",
  cursor: "https://cursor.com/",
  gemini: "https://github.com/google-gemini/gemini-cli",
  opencode: "https://opencode.ai/",
  rungEditors: "https://github.com/sa1ntsinner/rung/tree/main/docs/editors",
};

const find = (inv: WindowsInventory | null, re: RegExp) => inv?.installed.filter((i) => re.test(i.name)) ?? [];
const versions = (xs: { name: string; version: string }[]) => [...new Set(xs.map((x) => /V\d{2}/.exec(x.name)?.[0] ?? x.version))].join(", ");

export async function runChecks(p: Probes): Promise<CheckItem[]> {
  const win = p.platform === "win32" ? await p.windows() : null;
  const out: CheckItem[] = [];

  // ---------------------------------------------------------------- base
  const [major] = p.nodeVersion.replace(/^v/, "").split(".").map(Number);
  out.push({ id: "node", group: "base", name: "Node.js", status: (major ?? 0) >= 22 ? "ok" : "warn", detail: p.nodeVersion, enables: "runs rung from npm (@rung-plc/cli) or from source; rung.exe brings its own", ...((major ?? 0) >= 22 ? {} : { fix: "Install Node.js 22 or newer", link: LINKS.node }) });
  const git = p.which("git");
  out.push({ id: "git", group: "base", name: "Git", status: git ? "ok" : "missing", ...(git ? { detail: git } : {}), enables: "history, review and rollback of PLC changes; download handovers list what changed", ...(git ? {} : { fix: "Install Git", link: LINKS.git }) });

  // ---------------------------------------------------------------- PLC platforms
  if (p.platform !== "win32") {
    out.push({ id: "tia", group: "plc", name: "TIA Portal + Openness", status: "na", detail: `not available on ${p.platform}`, enables: "two-way sync, compile, online and download for Siemens PLCs", fix: "TIA Portal runs on Windows only. From here rung works with the TIA Portal of a Windows PC or VM over ssh: rung init --host <user@windows-pc> --project <project path there> (that PC needs OpenSSH Server and rung). The editor, language server and tests work here as they are." });
  } else {
    const tia = find(win, /Totally Integrated Automation Portal V\d+(?!.*(Update|Upd))/i).filter((x) => /STEP 7|Portal V\d+ *$|Portal V\d+ -/.test(x.name));
    const openness = win?.opennessApis ?? [];
    out.push({
      id: "tia",
      group: "plc",
      name: "TIA Portal (STEP 7)",
      status: tia.length ? "ok" : "missing",
      ...(tia.length ? { detail: versions(tia) } : {}),
      enables: "two-way sync, compile, online and download for Siemens S7 PLCs",
      ...(tia.length ? {} : { fix: "Install TIA Portal V20 (or V21) with STEP 7 Professional; a 21-day trial is available from Siemens.", link: LINKS.tia }),
    });
    out.push({
      id: "openness",
      group: "plc",
      name: "TIA Portal Openness",
      status: openness.length ? "ok" : tia.length ? "missing" : "na",
      ...(openness.length ? { detail: openness.join(", ") } : {}),
      enables: "the API rung talks to TIA Portal through",
      ...(openness.length ? {} : { fix: "Select the option \"TIA Openness\" in the TIA Portal setup (Modify installation)." }),
    });
    if (tia.length) {
      out.push({
        id: "openness-group",
        group: "plc",
        name: "Windows group \"Siemens TIA Openness\"",
        status: win?.inOpennessGroup ? "ok" : win?.inOpennessGroup === false ? "missing" : "warn",
        enables: "permission to use Openness at all",
        ...(win?.inOpennessGroup ? {} : { fix: 'As administrator: net localgroup "Siemens TIA Openness" %USERNAME% /add, then sign out and in again.' }),
      });
      const wl = await p.bridgeWhitelisted();
      out.push({
        id: "whitelist",
        group: "plc",
        name: "rung bridge in the Openness whitelist",
        status: wl === "ok" ? "ok" : wl === "unknown" ? "warn" : "missing",
        // unknown on Windows: there is no bridge file to look up (rung setup openness would fail the same way)
        ...(wl === "stale" ? { detail: "registered, but the bridge changed since" } : wl === "unknown" ? { detail: "rung's bridge (bridge\\rung-bridge-v20.exe) was not found, so rung cannot tell" } : {}),
        enables: "no \"Openness access\" prompt; a TIA Portal without window never hangs on it",
        ...(wl === "ok" ? {} : { fix: wl === "unknown" ? "Keep the bridge folder of the release next to rung.exe, then run rung setup openness" : "rung setup openness" }),
      });
    }
    const plcsim = find(win, /S7-PLCSIM V\d+/i).filter((x) => !/Advanced/i.test(x.name));
    const plcsimAdv = find(win, /PLCSIM Advanced/i);
    out.push({
      id: "plcsim",
      group: "plc",
      name: "S7-PLCSIM",
      status: plcsim.length ? "ok" : "missing",
      ...(plcsim.length ? { detail: versions(plcsim) } : {}),
      enables: "going online and downloading without hardware (TIA Portal's own simulator)",
      ...(plcsim.length ? {} : { fix: "Install \"SIMATIC S7-PLCSIM\" for your TIA version (comes with STEP 7 Professional, separate download from Siemens Industry Online Support).", link: LINKS.siemensSupport }),
    });
    out.push({
      id: "plcsim-advanced",
      group: "plc",
      name: "S7-PLCSIM Advanced",
      status: plcsimAdv.length ? "ok" : "missing",
      ...(plcsimAdv.length ? { detail: plcsimAdv[0]!.version } : {}),
      enables: "a virtual S7-1500 with its own IP address and web server (online, download, rung live)",
      ...(plcsimAdv.length ? {} : { fix: "Optional, licensed (21-day trial).", link: LINKS.plcsimAdvanced }),
    });
    const tc = find(win, /TwinCAT.*(XAE|Engineering|3\.1)/i);
    out.push({
      id: "twincat",
      group: "plc",
      name: "Beckhoff TwinCAT 3 XAE",
      status: tc.length || win?.twincatDir ? "ok" : "missing",
      ...(tc.length ? { detail: tc[0]!.version } : win?.twincatDir ? { detail: win.twincatDir } : {}),
      enables: "building and activating TwinCAT projects (rung already edits and tests TwinCAT sources without it)",
      ...(tc.length || win?.twincatDir ? {} : { fix: "Download \"TwinCAT 3 XAE\" (TE1000, free) from the Beckhoff download finder; install XAE, the runtime is not needed for engineering.", link: LINKS.twincat }),
    });
    const cs = win?.codesys ?? [];
    out.push({
      id: "codesys",
      group: "plc",
      name: "CODESYS Development System",
      status: cs.length ? "ok" : "missing",
      ...(cs.length ? { detail: cs.join(", ") } : {}),
      enables: "CODESYS projects (rung edits and tests IEC ST sources without it)",
      ...(cs.length ? {} : { fix: "Download CODESYS V3.5 (free) from the CODESYS Store.", link: LINKS.codesys }),
    });
  }

  // ---------------------------------------------------------------- editors
  const code = p.which("code");
  const vsExt = code ? await p.vscodeExtensions() : null;
  out.push({
    id: "vscode",
    group: "editor",
    name: "VS Code",
    status: code ? (vsExt?.some((e) => /\.rung-scl$/i.test(e)) ? "ok" : "warn") : "missing",
    ...(code ? { detail: vsExt?.some((e) => /\.rung-scl$/i.test(e)) ? "rung extension installed" : "rung extension not installed" } : {}),
    enables: "rung sidebar, PLC actions, SCL language server",
    ...(code ? (vsExt?.some((e) => /\.rung-scl$/i.test(e)) ? {} : { fix: "rung setup (installs the extension), or: code --install-extension rung-scl.vsix" }) : { link: LINKS.vscode }),
  });
  const zedCmd = p.which("zed") ?? (p.exists(join(p.home, "AppData", "Local", "Programs", "Zed", "Zed.exe")) ? "Zed.exe" : null);
  // the Siemens SCL extension (rung-scl before it was in Zed's registry)
  const zedHas = p.zedExtensions()?.some((e) => /^siemens-scl$|rung/i.test(e)) ?? false;
  out.push({
    id: "zed",
    group: "editor",
    name: "Zed",
    status: zedCmd ? (zedHas ? "ok" : "warn") : "missing",
    ...(zedCmd ? { detail: zedHas ? "Siemens SCL extension installed" : "Siemens SCL extension not installed" } : {}),
    enables: "SCL language server, run buttons and tasks for compile, test, online, download",
    ...(zedCmd ? (zedHas ? {} : { fix: "Zed → Extensions → install Siemens SCL (until it is listed: Install Dev Extension → editors/zed, see the editors guide)", link: LINKS.rungEditors }) : { link: LINKS.zed }),
  });
  const nvim = p.which("nvim");
  out.push({ id: "neovim", group: "editor", name: "Neovim", status: nvim ? "ok" : "missing", enables: "SCL language server via its built-in LSP client", link: nvim ? LINKS.rungEditors : LINKS.neovim });

  // ---------------------------------------------------------------- AI agents
  const agent = (id: string, name: string, cmd: string | null, dir: string, link: string) => {
    const found = cmd ?? (p.exists(join(p.home, dir)) ? join("~", dir) : null);
    out.push({ id, group: "agent", name, status: found ? "ok" : "missing", ...(found ? { detail: found } : {}), enables: "rung MCP tools and PLC engineering skills", ...(found ? { fix: "rung setup wires rung into it" } : {}), link });
  };
  agent("claude", "Claude Code", p.which("claude"), ".claude", LINKS.claude);
  agent("codex", "Codex CLI", p.which("codex"), ".codex", LINKS.codex);
  agent("cursor", "Cursor", p.which("cursor"), ".cursor", LINKS.cursor);
  agent("gemini", "Gemini CLI", p.which("gemini"), ".gemini", LINKS.gemini);
  agent("opencode", "OpenCode", p.which("opencode"), join(".config", "opencode"), LINKS.opencode);
  return out;
}

// ------------------------------------------------------------------ real probes

function whichSync(cmd: string, env: Record<string, string | undefined>): string | null {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const f = join(dir, cmd + e.toLowerCase());
      if (existsSync(f)) return f;
      const g = join(dir, cmd + e);
      if (existsSync(g)) return g;
    }
  }
  return null;
}

const INVENTORY_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$keys = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$apps = Get-ItemProperty $keys | Where-Object { $_.DisplayName -match 'Totally Integrated Automation|PLCSIM|TwinCAT|Beckhoff|CODESYS' } | ForEach-Object { @{ name = [string]$_.DisplayName; version = [string]$_.DisplayVersion } }
$api = @(Get-ChildItem 'C:\\Program Files\\Siemens\\Automation\\Portal V*\\PublicAPI\\V*\\Siemens.Engineering.dll' | ForEach-Object { $_.Directory.Name } | Sort-Object -Unique)
$groups = & "$env:SystemRoot\\System32\\whoami.exe" /groups 2>$null | Out-String
$tc = $null; foreach ($d in 'C:\\TwinCAT\\3.1','C:\\Program Files (x86)\\Beckhoff\\TwinCAT\\3.1') { if (Test-Path $d) { $tc = $d; break } }
$cs = @(Get-ChildItem 'C:\\Program Files\\CODESYS*\\CODESYS\\Common\\CODESYS.exe','C:\\Program Files (x86)\\CODESYS*\\CODESYS\\Common\\CODESYS.exe' | ForEach-Object { $_.Directory.Parent.Parent.Name })
@{ installed = @($apps); opennessApis = $api; inOpennessGroup = ($groups -match 'Siemens TIA Openness'); twincatDir = $tc; codesys = $cs } | ConvertTo-Json -Depth 4 -Compress
`;

export function realProbes(env: Record<string, string | undefined>, bridge: () => Promise<"ok" | "missing" | "stale" | "unknown">): Probes {
  const home = homedir();
  return {
    platform: process.platform,
    nodeVersion: process.version,
    home,
    exists: existsSync,
    which: (c) => whichSync(c, env),
    bridgeWhitelisted: bridge,
    windows: async () => {
      try {
        const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", INVENTORY_PS], { windowsHide: true, timeout: 30_000, maxBuffer: 4 << 20 });
        const j = JSON.parse(stdout) as Partial<WindowsInventory>;
        return { installed: j.installed ?? [], opennessApis: j.opennessApis ?? [], inOpennessGroup: j.inOpennessGroup ?? null, twincatDir: j.twincatDir ?? null, codesys: j.codesys ?? [] };
      } catch {
        return null;
      }
    },
    vscodeExtensions: async () => {
      try {
        const { stdout } = await run(process.platform === "win32" ? "cmd.exe" : "code", process.platform === "win32" ? ["/d", "/c", "code", "--list-extensions"] : ["--list-extensions"], { windowsHide: true, timeout: 30_000 });
        return stdout.split(/\r?\n/).filter(Boolean);
      } catch {
        return null;
      }
    },
    zedExtensions: () => {
      const dirs = [join(home, "AppData", "Local", "Zed", "extensions", "installed"), join(home, ".local", "share", "zed", "extensions", "installed"), join(home, "Library", "Application Support", "Zed", "extensions", "installed")];
      for (const d of dirs) if (existsSync(d)) return readdirSync(d);
      return null;
    },
  };
}

// ------------------------------------------------------------------ printing

export function formatChecks(items: CheckItem[], color: boolean): string {
  const c = (code: number, s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const mark: Record<CheckStatus, string> = { ok: c(32, "✓"), missing: c(90, "·"), warn: c(33, "!"), na: c(90, "–") };
  const titles = { base: "Basics", plc: "PLC platforms", editor: "Editors", agent: "AI agents" } as const;
  const lines: string[] = [];
  for (const g of ["plc", "editor", "agent", "base"] as const) {
    const xs = items.filter((i) => i.group === g);
    if (!xs.length) continue;
    lines.push(c(1, titles[g]));
    for (const i of xs) {
      lines.push(`  ${mark[i.status]} ${i.name}${i.detail ? c(90, `  ${i.detail}`) : ""}`);
      if (i.status !== "ok") {
        lines.push(c(90, `      ${i.enables}`));
        if (i.fix) lines.push(`      → ${i.fix}`);
        if (i.link) lines.push(c(36, `      ${i.link}`));
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

