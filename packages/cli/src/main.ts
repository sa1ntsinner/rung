// SPDX-License-Identifier: BUSL-1.1
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FILE,
  ENGINEERING_VERSIONS,
  StateStore,
  WorkspaceError,
  defaultConfig,
  loadConfig,
  saveConfig,
  writeFileAtomic,
  type EngineeringVersion,
  type RungConfig,
} from "@rung/core";
import { BridgeClient, BridgeError } from "@rung/bridge-client";
import { OwnerClient, OwnerError, doctor, pull, summarize, writeModelViews, writeTagViews } from "@rung/sync";
import { HINTS, bridgeEnv, bridgeFor, decodeArgs, defaultBridge, exists, findWorkspace, importFlags, isNotice, openState, printWarnings, remoteBridge, type Io } from "./common.js";
import { startServer } from "@rung/lsp";
import { serveStdio } from "@rung/mcp";
import { writeAgentsFile } from "./agents.js";
import { cmdLive } from "./live.js";
import { agentsTemplatePath, bridgeExecutable } from "./paths.js";
import { runTests, toJUnit } from "@rung/sim";
import { githubAnnotations } from "./annotate.js";
import { WorkspaceIndex, assignmentList, nearest } from "@rung/lsp";
import { cmdConfirmDelete, cmdRename, cmdResolve, cmdStatus, cmdSync, cmdWatch } from "./twoway.js";
import { closePlcLinks, cmdCompare, cmdCompile, cmdConnect, cmdDownload, cmdInterfaces, cmdOnline, cmdOpen, cmdUpload, reportUpload, uploadRequest } from "./plc.js";
import { WHITELIST_HINT, cmdSetup, whitelistStatus } from "./setup.js";
import { cmdSimulate } from "./simulate.js";
import { cmdCheck } from "./check.js";
import { cmdCodesysBridge, codesysBridgeCommand } from "./codesys.js";
import { cmdSetupWizard } from "./wizard.js";

export type { Io } from "./common.js";

export const VERSION = "0.1.0-dev";

export const HELP = `rung ${VERSION} — PLC-as-code for Siemens TIA Portal

Usage:
  rung setup [dir] [--dry-run] [-y] [--agents claude,codex,...] [--skills all|a,b] [--editors vscode,zed] [--scope project|global]
             [--platforms tia,twincat,codesys]
                                       set up rung for your agents and editors (asks, shows the plan, then writes)
  rung check [--json]                  what is installed (TIA, PLCSIM, TwinCAT, CODESYS, editors, agents) and how to get the rest
  rung init [dir] [--project <file.ap20>] [--tia V20] [--device <name>]... [--rebind]
  rung init [dir] --from-plc <ip> --project <dir>/<name>/<name>.ap20 [--use <PG/PC interface>] [--mode <mode>] [--number <n>]
                                       a new project from a running PLC (TIA's "Upload device as new station")
  rung init [dir] --host <user@windows-pc> --project <path there>   on Linux or macOS: TIA Portal on another PC, over ssh
  rung bridge [--tia V21] ...          on that Windows PC: the bridge itself (rung starts it over ssh)
  rung pull [dir] [--force]            TIA → files (never overwrites local edits without --force)
  rung sync [dir]                      one two-way pass (imports need sync.import = "auto")
  rung watch [dir]                     keep syncing; serves CLI, editors and agents (Ctrl+C to stop)
  rung status [dir]
  rung resolve <file> --ours|--theirs|--merged
  rung confirm-delete <file|address> [--dir <workspace>]
  rung rename <file|name> <new-name> [--dir <workspace>]  rename in TIA Portal; the files that use it follow
  rung test [dir] [--junit <file>] [--filter <text>] [--json]  run tests/**/*.test.yaml on the offline simulator (SCL, LAD, FBD, STL)
  rung live read <var>... [--dir <ws>] read live values from the PLC Web API (read-only)
  rung live watch --file <block> [--instance <DB>] [--interval 500] [--json]
                                       monitor a block like TIA Portal: its values every interval (read-only)
  rung live diag [--dir <ws>]          PLC diagnostic buffer via the Web API
  rung assignments [dir] [--json]      the assignment list: used inputs, outputs, bit memory, timers, counters; overlaps
  rung views [dir] [--offline]         read-only YAML views of hardware, HMI, technology objects, the library and tags
  rung agents [dir]                    regenerate the project summary in AGENTS.md
  rung mcp [dir]                       MCP server for AI agents (Claude Code, Codex, Cursor)
  rung lsp [--stdio]                   language server for editors (VS Code, Zed, Neovim)
  rung doctor [dir] --fixture          round-trip probe; imports over objects (fixture projects only)

PLC:
  rung compile [dir] [--file <f>]... [--hw] [--plc <name>]   compile in TIA Portal; errors point at file lines
  rung online [dir] [--off|--state] [--plc <name>]          go online / offline, or show the online state
  rung compare [dir] [--json] [--plc <name>]                 the project against the PLC (read-only); exit 2 if they differ
  rung connect [dir] [--pick] [--json] [--plc <name>]       find the PLC on the network and remember it
  rung connect [dir] --use <PG/PC interface> [--mode <mode>] [--number <n>] [--target <interface>]
                                       save a connection you choose (rung interfaces lists them)
  rung interfaces [dir] [--scan] [--plc <name>]             PG/PC interfaces and targets (+ reachable devices)
  rung upload [dir] --ip <address> [--use <PG/PC interface>]  the PLC as a new station of the project (the PLC is only read)
  rung download [dir] [--hw|--no-hw] [--no-sw] [--all-blocks] [--allow <q>]... [--no-start] [--yes] [--plc <name>]
                                       download to the PLC; asks you to type the PLC name first, and
                                       cancels whenever TIA asks something not allowed (e.g. stop-cpu)
  rung open <file> [--dir <ws>]        open the block's editor in the TIA Portal window
  rung simulate [dir] [--address 127.0.0.2] [--port 8080] [--cycle 10] [--block <FB/FC>]
                                       a virtual S7-1500: runs the SCL program and answers the Web API (for rung live)
  rung setup openness [--grant]        register the bridge in the Openness whitelist (no "Openness access" prompt)

Environment:
  RUNG_BRIDGE           path to rung-bridge-v20.exe (default: bundled/dev build)
  RUNG_WEBAPI_PASSWORD  password of the PLC web server user for rung live
  RUNG_PLC_PASSWORD     password of a protected CPU for rung download and rung upload
`;

async function agentsTemplate(project: string): Promise<string> {
  try {
    const path = agentsTemplatePath();
    if (!path) throw new Error("no template");
    const t = await readFile(path, "utf8");
    return t.replace(/^<!--.*?-->\n/, "").replace("{{PROJECT}}", project);
  } catch {
    return `# rung workspace\n\nText mirror of ${project}. Edit files directly; never download to a PLC; .protected.yaml, F- and GRAPH blocks are read-only.\n`;
  }
}

/** `rung bridge [--tia V21] <bridge arguments>`: runs the bridge that comes with rung on this PC, on stdin/stdout. */
async function runBridge(args: string[], io: Io): Promise<number> {
  // over ssh the arguments come as one word (common.ts encodeArgs): no shell on the way splits or expands them
  const at = args.indexOf("--args");
  if (at >= 0) args = [...args.slice(0, at), ...decodeArgs(args[at + 1] ?? ""), ...args.slice(at + 2)];
  let tia: "V20" | "V21" = "V20";
  while (args[0] === "--tia") {
    tia = args[1] === "V21" ? "V21" : "V20";
    args = args.slice(2);
  }
  const own = defaultBridge(io.env);
  const exe = io.env.RUNG_BRIDGE ? own.command : bridgeExecutable(io.env, tia);
  const child = spawn(exe, [...own.args, ...args], { stdio: "inherit", windowsHide: true, env: io.env as NodeJS.ProcessEnv });
  return await new Promise<number>((done) => {
    child.on("exit", (code) => done(code ?? 1));
    child.on("error", (e) => {
      io.stderr(`rung bridge: ${e.message}\n`);
      done(1);
    });
  });
}

async function cmdInit(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const cfgPath = join(dir, CONFIG_FILE);
  if ((await exists(cfgPath)) && !v.rebind) {
    io.stderr(`rung: ${cfgPath} already exists (use --rebind to bind it to another project)\n`);
    return 1;
  }
  // checked before anything starts: --from-plc changes the project, so a bad argument must stop rung before that
  const wanted = v.tia as string | undefined;
  if (wanted !== undefined && !ENGINEERING_VERSIONS.includes(wanted as EngineeringVersion)) throw new WorkspaceError("BAD_ARGUMENT", `unsupported version ${wanted} (V20, V21 or CODESYS)`);
  // a .project file is CODESYS: rung relays to its bridge script inside CODESYS (codesys.ts)
  const codesys = !!v.project && /\.project$/i.test(String(v.project)) && !io.env.RUNG_BRIDGE;
  const bridge = codesys
    ? codesysBridgeCommand(resolve(io.cwd, String(v.project)))
    : io.env.RUNG_BRIDGE
      ? defaultBridge(io.env)
      : { command: bridgeExecutable(io.env, wanted === "V21" ? "V21" : "V20"), args: [] };
  // with an explicit project the bridge may open it in the background when no TIA Portal has it open
  // --from-plc: a new project, and the running PLC uploaded into it as its station
  const fromPlc = v["from-plc"] === undefined ? undefined : uploadRequest(String(v["from-plc"]), v);
  if (fromPlc && (codesys || !v.project)) throw new WorkspaceError("BAD_ARGUMENT", "rung init --from-plc needs --project <folder>/<name>/<name>.ap20, where the new TIA Portal project goes");
  const create = fromPlc ? ["--create-project", "--allow-import"] : [];
  const args = codesys ? bridge.args : [...bridge.args, ...(v.project ? ["--project", String(v.project), "--open-headless", ...create] : [])];
  // --host: TIA Portal runs on another PC (this one is Linux or macOS); the bridge starts there over ssh
  const host = v.host as string | undefined;
  if (host && (codesys || !v.project)) throw new WorkspaceError("BAD_ARGUMENT", "rung init --host needs --project <path of the project on that PC>");
  const client = host
    ? await remoteBridge(host, "", args.slice(bridge.args.length), v.tia === "V21" ? "V21" : "V20", io)
    : await BridgeClient.spawn({ command: bridge.command, args, env: bridgeEnv(io.env, "env" in bridge ? ((bridge.env ?? {}) as Record<string, string>) : {}), ...(codesys ? { closeTimeoutMs: 30_000 } : {}) });
  try {
    let info = await client.projectInfo();
    const tia = wanted ?? info.tiaVersion;
    if (!ENGINEERING_VERSIONS.includes(tia as EngineeringVersion)) throw new WorkspaceError("BAD_ARGUMENT", `unsupported version ${tia} (V20, V21 or CODESYS)`);
    if (tia !== info.tiaVersion) throw new WorkspaceError("BAD_ARGUMENT", `--tia ${tia} does not match: ${info.path} is open in TIA Portal ${info.tiaVersion}`);
    const devices = (v.device as string[] | undefined) ?? [];
    const checkDevices = () => {
      for (const d of devices) if (!info.devices.includes(d)) throw new WorkspaceError("BAD_ARGUMENT", `device ${d} not in project (${info.devices.join(", ")})`);
    };
    // a device named with --from-plc may be the one the upload brings; otherwise it must be there already
    if (!fromPlc) checkDevices();
    if (fromPlc) {
      io.stderr(`reading the station at ${fromPlc.address} into ${info.path} (the PLC is only read) …\n`);
      const code = reportUpload(io, await client.upload(fromPlc), fromPlc.address);
      if (code !== 0) return code;
      info = await client.projectInfo();
      checkDevices();
    }
    // On --rebind keep the user's sync/bridge settings; only the binding changes, and the bridge runs where the
    // project was just looked at: on --host, or here when no --host was given
    const previous = v.rebind && (await exists(cfgPath)) ? await loadConfig(dir).catch(() => undefined) : undefined;
    const rebound = previous && (({ host: _old, ...rest }) => (host ? { ...rest, host } : rest))(previous.bridge);
    const config = previous
      ? { ...previous, project: { path: info.path, tiaVersion: tia as EngineeringVersion }, devices, bridge: rebound! }
      : // the bridge that comes with rung is found at run time; only an explicit RUNG_BRIDGE is written down
        { ...defaultConfig(info.path, tia as EngineeringVersion, io.env.RUNG_BRIDGE ? bridge.command : "", devices), bridge: host ? { command: "", args: [], host } : io.env.RUNG_BRIDGE ? { command: bridge.command, args: bridge.args } : { command: "", args: [] } };
    // Take the state lock before touching rung.toml so config and state never disagree about the binding.
    // devices = [] means "all PLCs" and is stored as such, so adding a PLC later does not break the binding.
    const state = await StateStore.open(dir, { projectPath: info.path, tiaVersion: tia, devices }, { rebind: !!v.rebind });
    try {
      await saveConfig(dir, config);
    } finally {
      await state.close();
    }
    const gi = join(dir, ".gitignore");
    const current = (await exists(gi)) ? await readFile(gi, "utf8") : "";
    if (!current.split(/\r?\n/).includes(".rung/")) await appendFile(gi, (current && !current.endsWith("\n") ? "\n" : "") + ".rung/\n");
    if (!(await exists(join(dir, "AGENTS.md")))) await writeFile(join(dir, "AGENTS.md"), await agentsTemplate(info.path));
    const bridgeExe = io.env.RUNG_BRIDGE ?? (config.bridge.command || bridge.command);
    const wl = /rung-bridge-v2\d\.exe$/i.test(bridgeExe) ? await whitelistStatus(bridgeExe) : "unknown";
    if (wl === "missing" || wl === "stale") io.stderr(`rung: ${WHITELIST_HINT}\n`);
    io.stdout(`Bound ${dir} to ${info.path} (${tia}, devices: ${(devices.length ? devices : info.devices).join(", ")}).\nNext: rung pull\n`);
    return 0;
  } finally {
    await client.close();
  }
}

async function cmdPull(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const config = await loadConfig(dir);
  // rung watch owns the workspace and brings TIA Portal's changes in by itself
  const owner = await OwnerClient.connect(dir);
  if (owner) {
    owner.close();
    io.stderr("rung: rung watch runs in this workspace and already brings TIA Portal's changes in; rung pull is not needed while it runs (Ctrl+C there stops it)\n");
    return 1;
  }
  // the lock before the bridge: a workspace another rung process holds fails before a TIA Portal starts for nothing
  const state = await openState(dir, config);
  try {
    const client = await bridgeFor(config, io);
    try {
      let last = 0;
      const report = await pull(dir, client, state, {
        config,
        force: !!v.force,
        onProgress: (done, total) => {
          const pct = Math.floor((done / Math.max(total, 1)) * 100);
          if (pct >= last + 10 || done === total) {
            last = pct;
            io.stderr(`\r  ${done}/${total} objects`);
          }
        },
      });
      io.stderr("\n");
      io.stdout(
        `exported   ${report.exported}\nunchanged  ${report.unchanged}\nremoved    ${report.removed}\nread-only  ${report.readOnly}\nwarnings   ${report.warnings.length}\n`,
      );
      printWarnings(io, report.warnings);
      await writeAgentsFile(dir, config.project.path, await agentsTemplate(config.project.path)).catch(() => undefined);
      return report.warnings.some((w) => !isNotice(w.code)) ? 2 : 0;
    } finally {
      await client.close();
    }
  } finally {
    await state.close();
  }
}

async function cmdDoctor(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  if (!v.fixture) {
    io.stderr("rung: doctor imports over objects and is only allowed on generated fixture projects; pass --fixture\n");
    return 1;
  }
  const config = await loadConfig(dir);
  // doctor imports over every object; running next to rung watch makes both fail. Take the state lock.
  const state = await openState(dir, config);
  const client = await bridgeFor(config, io, ["--allow-fixture-import"]);
  try {
    const rows = await doctor(dir, client, {
      devices: config.devices.length ? config.devices : undefined,
      onProgress: (done, total, address) => io.stderr(`\r  ${done}/${total} ${address.length > 60 ? "…" + address.slice(-59) : address.padEnd(60)}`),
    });
    io.stderr("\n");
    await writeFileAtomic(join(dir, ".rung", "doctor-report.json"), JSON.stringify(rows, null, 2) + "\n");
    for (const r of rows) {
      const verdict = r.skipped ? `skipped (${r.skipped})` : r.error ? `ERROR ${r.error}` : r.pass1Equal ? "fixed point" : r.pass2Equal ? "converges on pass 2" : "NEVER converges";
      io.stdout(`${(r.form || "-").padEnd(15)} ${verdict.padEnd(22)} ${r.address}\n`);
    }
    io.stdout("\nform            pass1  pass2  never  errors\n");
    for (const [form, s] of Object.entries(summarize(rows)))
      io.stdout(`${form.padEnd(15)} ${String(s.pass1).padStart(5)}  ${String(s.pass2).padStart(5)}  ${String(s.never).padStart(5)}  ${String(s.errors).padStart(6)}\n`);
    return rows.some((r) => !r.skipped && (r.error || !r.pass2Equal)) ? 2 : 0;
  } finally {
    await client.close();
    await state.close();
  }
}

/**
 * rung lsp and rung mcp typed in a terminal wait silently for an editor or an agent: one line on stderr says so
 * (stdout is the protocol). A program that starts them passes pipes, not a terminal, and sees nothing.
 */
export function serverNote(cmd: string, terminal: boolean): string | undefined {
  if (!terminal) return undefined;
  if (cmd === "lsp") return "rung lsp is the language server your editor starts (rung setup --editors sets that up); it now waits for an editor on stdin, Ctrl+C stops it\n";
  if (cmd === "mcp") return "rung mcp is the MCP server an AI agent starts (rung setup --agents sets that up); it now waits for an agent on stdin, Ctrl+C stops it\n";
  return undefined;
}

/** rung init has no rung.toml yet: what to do next is about the project it was given, or should be given. */
function initHint(code: string, project: boolean): string | undefined {
  if (code === "NO_PROJECT" && project) return "Check the path: --project is the project file (.ap20) with its full path.";
  if (code === "NO_PROJECT" || code === "TIA_NOT_RUNNING") return "Open the project in TIA Portal, or name it: rung init --project <path to the .ap20> (rung then opens it in a TIA Portal without window).";
  return undefined;
}

/** Options and positionals (after the command) each command takes: anything else is a typo worth stopping for. */
export const COMMANDS: Record<string, { options: string[]; positionals: number }> = {
  setup: { options: ["dry-run", "yes", "agents", "skills", "editors", "platforms", "scope", "grant"], positionals: 1 },
  check: { options: ["json"], positionals: 0 },
  init: { options: ["project", "tia", "device", "rebind", "from-plc", "use", "mode", "number", "host"], positionals: 1 },
  pull: { options: ["force"], positionals: 1 },
  sync: { options: [], positionals: 1 },
  watch: { options: [], positionals: 1 },
  status: { options: [], positionals: 1 },
  resolve: { options: ["ours", "theirs", "merged"], positionals: 1 },
  "confirm-delete": { options: ["dir"], positionals: 1 },
  rename: { options: ["dir"], positionals: 2 },
  test: { options: ["junit", "filter", "json"], positionals: 1 },
  live: { options: ["dir", "file", "instance", "json", "interval"], positionals: Infinity },
  views: { options: ["offline"], positionals: 1 },
  agents: { options: [], positionals: 1 },
  mcp: { options: [], positionals: 1 },
  lsp: { options: ["stdio"], positionals: 0 },
  doctor: { options: ["fixture"], positionals: 1 },
  compile: { options: ["file", "hw", "plc"], positionals: 1 },
  online: { options: ["off", "state", "plc"], positionals: 1 },
  compare: { options: ["json", "plc"], positionals: 1 },
  connect: { options: ["pick", "json", "plc", "use", "mode", "number", "target"], positionals: 1 },
  interfaces: { options: ["scan", "plc"], positionals: 1 },
  download: { options: ["hw", "no-hw", "no-sw", "all-blocks", "allow", "no-start", "yes", "plc"], positionals: 1 },
  open: { options: ["dir"], positionals: 1 },
  simulate: { options: ["address", "port", "cycle", "block"], positionals: 1 },
  "codesys-bridge": { options: ["project"], positionals: 0 },
  assignments: { options: ["json"], positionals: 1 },
  upload: { options: ["ip", "use", "mode", "number"], positionals: 1 },
};

/** Why these arguments do not fit the command, or undefined. */
function misuse(cmd: string, v: Record<string, unknown>, positionals: string[]): string | undefined {
  const spec = COMMANDS[cmd];
  if (!spec) return undefined;
  const stray = Object.keys(v).filter((k) => v[k] !== undefined && k !== "help" && !spec.options.includes(k));
  const near = stray.length === 1 ? nearest(stray[0]!, spec.options) : undefined;
  if (stray.length) return `rung ${cmd} has no ${stray.map((s) => "--" + s).join(", ")}${near ? `; did you mean --${near}?` : ""}`;
  const extra = positionals.slice(1 + spec.positionals);
  if (extra.length) return `rung ${cmd} takes ${spec.positionals === 0 ? "no arguments" : spec.positionals === 1 ? "one argument" : `${spec.positionals} arguments`}; unexpected: ${extra.join(" ")}`;
  // compile --hw compiles the hardware only: the files it was given would be left out without a word
  const exclusive = [["ours", "theirs", "merged"], ["hw", "no-hw"], ["off", "state"], ["hw", "file"]].map((g) => g.filter((k) => v[k]));
  const both = exclusive.find((g) => g.length > 1);
  if (both) return `${both.map((s) => "--" + s).join(" and ")} exclude each other`;
  return undefined;
}

export async function main(argv: string[], io: Io): Promise<number> {
  // the Windows end of a workspace on Linux or macOS (rung over ssh): the bridge itself, its arguments untouched
  if (argv[0] === "bridge") return runBridge(argv.slice(1), io);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        project: { type: "string" },
        tia: { type: "string" },
        device: { type: "string", multiple: true },
        rebind: { type: "boolean" },
        force: { type: "boolean" },
        fixture: { type: "boolean" },
        ours: { type: "boolean" },
        theirs: { type: "boolean" },
        merged: { type: "boolean" },
        dir: { type: "string" },
        stdio: { type: "boolean" },
        offline: { type: "boolean" },
        junit: { type: "string" },
        filter: { type: "string" },
        hw: { type: "boolean" },
        "no-hw": { type: "boolean" },
        "no-sw": { type: "boolean" },
        "all-blocks": { type: "boolean" },
        "no-start": { type: "boolean" },
        allow: { type: "string", multiple: true },
        yes: { type: "boolean", short: "y" },
        plc: { type: "string" },
        file: { type: "string", multiple: true },
        off: { type: "boolean" },
        state: { type: "boolean" },
        scan: { type: "boolean" },
        grant: { type: "boolean" },
        agents: { type: "string" },
        skills: { type: "string" },
        editors: { type: "string" },
        platforms: { type: "string" },
        scope: { type: "string" },
        "dry-run": { type: "boolean" },
        pick: { type: "boolean" },
        address: { type: "string" },
        port: { type: "string" },
        cycle: { type: "string" },
        block: { type: "string" },
        json: { type: "boolean" },
        use: { type: "string" },
        mode: { type: "string" },
        number: { type: "string" },
        target: { type: "string" },
        instance: { type: "string" },
        interval: { type: "string" },
        ip: { type: "string" },
        "from-plc": { type: "string" },
        host: { type: "string" },
      },
    });
  } catch (e) {
    // an option no command has (--dryrun): the command's option it most likely meant
    const unknown = (e as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /'(-[^']*)'/.exec((e as Error).message)?.[1] : undefined;
    if (unknown === undefined) {
      io.stderr(`rung: ${(e as Error).message}\n`);
      return 1;
    }
    const cmd = argv.find((a) => !a.startsWith("-"));
    const spec = cmd ? COMMANDS[cmd] : undefined;
    const near = nearest(unknown.replace(/^-+/, "").replace(/=.*$/, ""), new Set([...(spec ? spec.options : Object.values(COMMANDS).flatMap((c) => c.options)), "help", "version"]));
    io.stderr(`rung: ${spec ? `rung ${cmd} has no ${unknown}` : `unknown option ${unknown}`}${near ? `; did you mean --${near}?` : ""} (rung --help)\n`);
    return 1;
  }
  const { values: v, positionals } = parsed;
  if (v.version) {
    io.stdout(`rung ${VERSION}\n`);
    return 0;
  }
  const [cmd, target] = positionals;
  if (v.help || !cmd) {
    io.stdout(HELP);
    return cmd || v.help ? 0 : 1;
  }
  const wrong = misuse(cmd, v, positionals);
  if (wrong) {
    io.stderr(`rung: ${wrong} (rung --help)\n`);
    return 1;
  }
  const note = serverNote(cmd, !!process.stdin.isTTY);
  if (note) io.stderr(note);
  if (cmd === "lsp") {
    startServer();
    await new Promise<void>(() => {}); // runs until the editor closes the connection
  }
  const dir = resolve(io.cwd, cmd === "live" ? ((v.dir as string | undefined) ?? ".") : (target ?? "."));
  try {
    switch (cmd) {
      case "test": {
        // TwinCAT / plain IEC ST folders have no rung.toml: the given folder is the workspace.
        const ws = await findWorkspace(dir).catch(() => dir);
        const index = new WorkspaceIndex();
        await index.load(ws);
        const results = await runTests(ws, index, v.filter as string | undefined);
        if (v.junit) await writeFileAtomic(resolve(io.cwd, v.junit as string), toJUnit(results));
        const count = (f: (typeof results)[number]) => (f.error ? 1 : f.cases.length);
        const failedOf = (f: (typeof results)[number]) => (f.error ? 1 : f.cases.filter((c) => !c.passed).length);
        if (v.json) {
          // for editors (the VS Code test explorer): results with the line of every case and failing step
          io.stdout(JSON.stringify({ files: results }, null, 2) + "\n");
          const n = results.reduce((k, f) => k + count(f), 0);
          return n ? (results.some((f) => failedOf(f)) ? 2 : 0) : 1;
        }
        let failed = 0;
        for (const f of results) {
          if (f.error) {
            failed++;
            io.stdout(`FAIL ${f.file}: ${f.error}\n`);
            continue;
          }
          for (const c of f.cases) {
            io.stdout(`${c.passed ? "ok  " : "FAIL"} ${f.block}: ${c.name}${c.error ? ` — ${c.errorStep ? `step ${c.errorStep}: ` : ""}${c.error}` : ""}\n`);
            for (const x of c.failures) {
              // expect: { Running: "true" } is the text "true", never the BOOL the block has
              const quoted = typeof x.expected === "string" && ((typeof x.actual === "boolean" && /^(true|false)$/i.test(x.expected)) || (typeof x.actual === "number" && x.expected.trim() !== "" && Number.isFinite(Number(x.expected))));
              // <...> is what went wrong reading the name (it does not exist), not a value
              const got = typeof x.actual === "string" && /^<.*>$/.test(x.actual) ? x.actual : JSON.stringify(x.actual);
              io.stdout(`       step ${x.step}: ${x.name} expected ${JSON.stringify(x.expected)} got ${got}${quoted ? ` (in quotes "${x.expected}" is text: write ${x.expected} without them)` : ""}\n`);
            }
            if (!c.passed) failed++;
          }
          // once per file: what the test stood in for, and stubs it named but never reached
          if (f.stubbed?.length) io.stdout(`       stubbed: ${f.stubbed.map((s) => `${s.name}${s.calls > 1 ? ` ×${s.calls}` : ""}${s.runs ? " (replaces code the simulator runs)" : ""}`).join(", ")}\n`);
          for (const w of f.warnings ?? []) io.stdout(`       warning: ${w}\n`);
        }
        // in GitHub Actions a failure also shows in the pull request, on the line of its step
        if (io.env.GITHUB_ACTIONS === "true") for (const a of githubAnnotations(results, ws, io.env.GITHUB_WORKSPACE ?? io.cwd)) io.stdout(`${a}\n`);
        const total = results.reduce((n, f) => n + (f.error ? 1 : f.cases.length), 0);
        if (!total) {
          // a test file named without .test is read by nobody: name it
          const unnamed = v.filter
            ? []
            : ((await readdir(join(ws, "tests"), { recursive: true }).catch(() => [])) as string[]).map((f) => `tests/${f.split(sep).join("/")}`).filter((f) => /\.ya?ml$/i.test(f) && !/\.test\.ya?ml$/.test(f)).sort();
          const hint = unnamed.length ? `; ${unnamed.slice(0, 3).join(", ")}${unnamed.length > 3 ? ` and ${unnamed.length - 3} more` : ""} ${unnamed.length === 1 ? "is" : "are"} not named *.test.yaml` : "";
          io.stdout(`no tests${v.filter ? ` match "${String(v.filter)}"` : ""}: rung test runs tests/**/*.test.yaml (docs/testing.md)${hint}\n`);
          return 1;
        }
        io.stdout(`\n${total - failed}/${total} passed (offline simulation — not a PLCSIM run)\n`);
        return failed ? 2 : total ? 0 : 1;
      }
      case "live":
        return await cmdLive(dir, target, positionals.slice(2), io, {
          ...(v.file ? { file: (v.file as string[])[0]! } : {}),
          ...(v.instance ? { instance: String(v.instance) } : {}),
          json: !!v.json,
          ...(v.interval ? { intervalMs: Number(String(v.interval).replace(/ms$/i, "")), intervalText: String(v.interval) } : {}),
        });
      case "views": {
        const ws = await findWorkspace(dir);
        const tags = await writeTagViews(ws);
        let model: string[] = [];
        if (!v.offline) {
          const config = await loadConfig(ws);
          const client = await bridgeFor(config, io);
          try {
            // CODESYS: its library managers; hardware, HMI and technology objects are TIA Portal's
            const r = await writeModelViews(ws, client, config.project.tiaVersion === "CODESYS" ? ["libraries"] : undefined);
            model = r.written;
            for (const t of r.truncated) io.stderr(`rung views: ${t} view truncated (object limit)\n`);
          } finally {
            await client.close();
          }
        }
        io.stdout(`wrote ${tags.length + model.length} views under ${join(ws, "views")}\n`);
        return 0;
      }
      case "agents": {
        const ws = await findWorkspace(dir);
        const config = await loadConfig(ws);
        await writeAgentsFile(ws, config.project.path, await agentsTemplate(config.project.path));
        io.stdout(`updated ${join(ws, "AGENTS.md")}\n`);
        return 0;
      }
      case "mcp": {
        // agents configured for all projects start rung mcp anywhere: serve without a workspace too
        // (rung_check works; workspace tools answer with how to set one up)
        const ws = await findWorkspace(dir).catch(() => null);
        const config = ws ? await loadConfig(ws) : null;
        await serveStdio({
          root: ws ?? dir,
          ...(config ? { bridgeFactory: () => bridgeFor(config, io, importFlags(config)) } : {}),
          bridgeWhitelisted: () => whitelistStatus(bridgeExecutable(io.env)),
        });
        await new Promise<void>((r) => process.stdin.once("end", () => r())); // until the agent closes stdin
        return 0;
      }
      case "check":
        return await cmdCheck(v, io);
      case "simulate":
        return await cmdSimulate(dir, v, io);
      case "setup":
        // rung setup openness: the whitelist; rung setup [dir]: the interactive setup
        return target === "openness" ? await cmdSetup(target, v, io) : await cmdSetupWizard(dir, v, io);
      case "compile":
        return await cmdCompile(dir, v, io);
      case "online":
        return await cmdOnline(dir, v, io);
      case "compare":
        return await cmdCompare(dir, v, io);
      case "connect":
        return await cmdConnect(dir, v, io);
      case "upload":
        return await cmdUpload(dir, v, io);
      case "interfaces":
        return await cmdInterfaces(dir, v, io);
      case "download":
        return await cmdDownload(dir, v, io);
      case "open":
        if (!target) {
          io.stderr("rung: usage: rung open <file> [--dir <workspace>]\n");
          return 1;
        }
        return await cmdOpen(resolve(io.cwd, (v.dir as string | undefined) ?? "."), target, io);
      case "init":
        return await cmdInit(dir, v, io);
      case "codesys-bridge":
        return await cmdCodesysBridge(v, io);
      case "assignments": {
        const ws = await findWorkspace(dir).catch(() => dir);
        const index = new WorkspaceIndex();
        await index.load(ws);
        const r = assignmentList(index);
        const where = (u: { uri: string; line: number }) => `${relative(ws, fileURLToPath(u.uri)).split(sep).join("/")}:${u.line + 1}`;
        if (v.json) {
          io.stdout(JSON.stringify({ items: r.items.map((a) => ({ ...a, uses: a.uses.map(where) })), overlaps: r.overlaps }, null, 2) + "\n");
          return r.overlaps.some((o) => !o.nested) ? 2 : 0;
        }
        const heading: Record<string, string> = { I: "Inputs", Q: "Outputs", M: "Bit memory", T: "Timers", C: "Counters" };
        // every PLC has its own inputs, outputs and bit memory: with several, each heading names its PLC
        const several = new Set(r.items.map((a) => a.device)).size > 1;
        const of = (device: string | undefined) => (several && device !== undefined ? ` of ${device}` : "");
        let area = "";
        for (const a of r.items) {
          const next = a.area + of(a.device);
          if (next !== area) io.stdout(`${area ? "\n" : ""}${heading[a.area]}${of(a.device)}\n`);
          area = next;
          const tag = a.tags.map((t) => `${t.name} : ${t.dataType} (${t.table})`).join(", ") || "(no tag)";
          const uses = a.uses.length ? `  used in ${a.uses.slice(0, 3).map(where).join(", ")}${a.uses.length > 3 ? ` and ${a.uses.length - 3} more` : ""}` : "";
          io.stdout(`  ${(a.address + (a.peripheral ? ":P" : "")).padEnd(10)} ${tag}${uses}\n`);
        }
        if (!r.items.length) io.stdout("no input, output or bit memory address is used\n");
        const crossing = r.overlaps.filter((o) => !o.nested);
        const nested = r.overlaps.length - crossing.length;
        if (crossing.length) {
          io.stdout(`\nOverlaps that cross (two accesses share only part of their bytes; usually a mistake):\n`);
          for (const o of crossing) io.stdout(`  ${o.a} and ${o.b}${of(o.device)} share byte${o.bytes.length > 1 ? "s" : ""} ${o.bytes.join(", ")}\n`);
        }
        if (nested) io.stdout(`\n${nested} address${nested > 1 ? "es are" : " is"} also used as part of a larger one (a byte and its bits, a word and its bytes); --json lists them.\n`);
        return crossing.length ? 2 : 0;
      }
      case "pull":
        return await cmdPull(await findWorkspace(dir), v, io);
      case "status":
        return await cmdStatus(await findWorkspace(dir), io);
      case "doctor":
        return await cmdDoctor(await findWorkspace(dir), v, io);
      case "sync":
        return await cmdSync(await findWorkspace(dir), io);
      case "watch":
        return await cmdWatch(await findWorkspace(dir), io);
      case "resolve": {
        const mode = v.ours ? "ours" : v.theirs ? "theirs" : v.merged ? "merged" : null;
        if (!target || !mode) {
          io.stderr("rung: usage: rung resolve <file> --ours|--theirs|--merged\n");
          return 1;
        }
        return await cmdResolve(target, mode, io);
      }
      case "rename": {
        const newName = positionals[2];
        if (!target || !newName) {
          io.stderr("rung: usage: rung rename <file|name> <new-name> [--dir <workspace>]\n");
          return 1;
        }
        return await cmdRename(resolve(io.cwd, (v.dir as string | undefined) ?? "."), target, newName, io);
      }
      case "confirm-delete":
        if (!target) {
          io.stderr("rung: usage: rung confirm-delete <file|address> [--dir <workspace>]\n");
          return 1;
        }
        return await cmdConfirmDelete(resolve(io.cwd, (v.dir as string | undefined) ?? "."), target, io);
      default:
        {
          const near = nearest(cmd, [...Object.keys(COMMANDS).filter((c) => c !== "codesys-bridge"), "bridge"]);
          io.stderr(`rung: unknown command ${cmd}${near ? ` (did you mean rung ${near}?)` : ""}; rung --help lists the commands\n`);
        }
        return 1;
    }
  } catch (e) {
    if (e instanceof BridgeError || e instanceof WorkspaceError || e instanceof OwnerError) {
      io.stderr(`rung: ${e.code}: ${e.message}\n`);
      const hint = (cmd === "init" ? initHint(e.code, !!v.project) : undefined) ?? HINTS[e.code];
      if (hint) io.stderr(`hint: ${hint}\n`);
      return 1;
    }
    throw e;
  } finally {
    await closePlcLinks();
  }
}
