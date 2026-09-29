// SPDX-License-Identifier: BUSL-1.1
import { parseArgs } from "node:util";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CONFIG_FILE,
  StateStore,
  WorkspaceError,
  defaultConfig,
  loadConfig,
  saveConfig,
  writeFileAtomic,
  type RungConfig,
} from "@rung/core";
import { BridgeClient, BridgeError } from "@rung/bridge-client";
import { doctor, pull, summarize, writeModelViews, writeTagViews } from "@rung/sync";
import { HINTS, bridgeFor, defaultBridge, exists, findWorkspace, importFlags, isNotice, openState, printWarnings, type Io } from "./common.js";
import { startServer } from "@rung/lsp";
import { serveStdio } from "@rung/mcp";
import { writeAgentsFile } from "./agents.js";
import { cmdLive } from "./live.js";
import { agentsTemplatePath, bridgeExecutable } from "./paths.js";
import { runTests, toJUnit } from "@rung/sim";
import { WorkspaceIndex } from "@rung/lsp";
import { cmdConfirmDelete, cmdRename, cmdResolve, cmdStatus, cmdSync, cmdWatch } from "./twoway.js";
import { closePlcLinks, cmdCompare, cmdCompile, cmdConnect, cmdDownload, cmdInterfaces, cmdOnline, cmdOpen } from "./plc.js";
import { WHITELIST_HINT, cmdSetup, whitelistStatus } from "./setup.js";
import { cmdSimulate } from "./simulate.js";
import { cmdCheck } from "./check.js";
import { cmdSetupWizard } from "./wizard.js";

export type { Io } from "./common.js";

export const VERSION = "0.1.0-dev";

const HELP = `rung ${VERSION} — PLC-as-code for Siemens TIA Portal

Usage:
  rung setup [dir] [--dry-run] [-y] [--agents claude,codex,...] [--skills all|a,b] [--editors vscode,zed] [--scope project|global]
                                       set up rung for your agents and editors (asks, shows the plan, then writes)
  rung check [--json]                  what is installed (TIA, PLCSIM, TwinCAT, CODESYS, editors, agents) and how to get the rest
  rung init [dir] [--project <file.ap20>] [--tia V20] [--device <name>]... [--rebind]
  rung pull [dir] [--force]            TIA → files (never overwrites local edits without --force)
  rung sync [dir]                      one two-way pass (imports need sync.import = "auto")
  rung watch [dir]                     keep syncing; serves CLI, editors and agents (Ctrl+C to stop)
  rung status [dir]
  rung resolve <file> --ours|--theirs|--merged
  rung confirm-delete <file|address> [--dir <workspace>]
  rung rename <file|name> <new-name> [--dir <workspace>]  rename in TIA Portal; the files that use it follow
  rung test [dir] [--junit <file>] [--filter <text>]  run tests/**/*.test.yaml on the offline simulator (SCL, LAD)
  rung live read <var>... [--dir <ws>] read live values from the PLC Web API (read-only)
  rung live diag [--dir <ws>]          PLC diagnostic buffer via the Web API
  rung views [dir] [--offline]         read-only YAML views of hardware, HMI, technology objects and tags
  rung agents [dir]                    regenerate the project summary in AGENTS.md
  rung mcp [dir]                       MCP server for AI agents (Claude Code, Codex, Cursor)
  rung lsp [--stdio]                   language server for editors (VS Code, Zed, Neovim)
  rung doctor [dir] --fixture          round-trip probe; imports over objects (fixture projects only)

PLC:
  rung compile [dir] [--file <f>]... [--hw] [--plc <name>]   compile in TIA Portal; errors point at file lines
  rung online [dir] [--off|--state] [--plc <name>]          go online / offline, or show the online state
  rung compare [dir] [--json] [--plc <name>]                 the project against the PLC (read-only); exit 2 if they differ
  rung connect [dir] [--pick] [--json] [--plc <name>]       find the PLC on the network and remember it
  rung interfaces [dir] [--scan] [--plc <name>]             PG/PC interfaces and targets (+ reachable devices)
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
  RUNG_PLC_PASSWORD     password of a protected CPU for rung download
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

async function cmdInit(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const cfgPath = join(dir, CONFIG_FILE);
  if ((await exists(cfgPath)) && !v.rebind) {
    io.stderr(`rung: ${cfgPath} already exists (use --rebind to bind it to another project)\n`);
    return 1;
  }
  const bridge = defaultBridge(io.env);
  // with an explicit project the bridge may open it in the background when no TIA Portal has it open
  const args = [...bridge.args, ...(v.project ? ["--project", String(v.project), "--open-headless"] : [])];
  const client = await BridgeClient.spawn({ command: bridge.command, args, env: io.env as Record<string, string> });
  try {
    const info = await client.projectInfo();
    const tia = (v.tia as string | undefined) ?? info.tiaVersion;
    if (tia !== "V20" && tia !== "V21") throw new WorkspaceError("BAD_ARGUMENT", `unsupported TIA version ${tia} (V20 or V21)`);
    if (tia !== info.tiaVersion) throw new WorkspaceError("BAD_ARGUMENT", `--tia ${tia} does not match: ${info.path} is open in TIA Portal ${info.tiaVersion}`);
    const devices = (v.device as string[] | undefined) ?? [];
    for (const d of devices) if (!info.devices.includes(d)) throw new WorkspaceError("BAD_ARGUMENT", `device ${d} not in project (${info.devices.join(", ")})`);
    // On --rebind keep the user's sync/bridge settings; only the binding changes.
    const previous = v.rebind && (await exists(cfgPath)) ? await loadConfig(dir).catch(() => undefined) : undefined;
    const config = previous
      ? { ...previous, project: { path: info.path, tiaVersion: tia as "V20" | "V21" }, devices }
      : // the bridge that comes with rung is found at run time; only an explicit RUNG_BRIDGE is written down
        { ...defaultConfig(info.path, tia, io.env.RUNG_BRIDGE ? bridge.command : "", devices), bridge: io.env.RUNG_BRIDGE ? { command: bridge.command, args: bridge.args } : { command: "", args: [] } };
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
  const client = await bridgeFor(config, io);
  try {
    const state = await openState(dir, config);
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
      await state.close();
    }
  } finally {
    await client.close();
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

/** Options and positionals (after the command) each command takes: anything else is a typo worth stopping for. */
const COMMANDS: Record<string, { options: string[]; positionals: number }> = {
  setup: { options: ["dry-run", "yes", "agents", "skills", "editors", "platforms", "scope", "grant"], positionals: 1 },
  check: { options: ["json"], positionals: 0 },
  init: { options: ["project", "tia", "device", "rebind"], positionals: 1 },
  pull: { options: ["force"], positionals: 1 },
  sync: { options: [], positionals: 1 },
  watch: { options: [], positionals: 1 },
  status: { options: [], positionals: 1 },
  resolve: { options: ["ours", "theirs", "merged"], positionals: 1 },
  "confirm-delete": { options: ["dir"], positionals: 1 },
  rename: { options: ["dir"], positionals: 2 },
  test: { options: ["junit", "filter"], positionals: 1 },
  live: { options: ["dir"], positionals: Infinity },
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
};

/** Why these arguments do not fit the command, or undefined. */
function misuse(cmd: string, v: Record<string, unknown>, positionals: string[]): string | undefined {
  const spec = COMMANDS[cmd];
  if (!spec) return undefined;
  const stray = Object.keys(v).filter((k) => v[k] !== undefined && k !== "help" && !spec.options.includes(k));
  if (stray.length) return `rung ${cmd} has no ${stray.map((s) => "--" + s).join(", ")}`;
  const extra = positionals.slice(1 + spec.positionals);
  if (extra.length) return `rung ${cmd} takes ${spec.positionals === 0 ? "no arguments" : spec.positionals === 1 ? "one argument" : `${spec.positionals} arguments`}; unexpected: ${extra.join(" ")}`;
  const exclusive = [["ours", "theirs", "merged"], ["hw", "no-hw"], ["off", "state"]].map((g) => g.filter((k) => v[k]));
  const both = exclusive.find((g) => g.length > 1);
  if (both) return `${both.map((s) => "--" + s).join(" and ")} exclude each other`;
  return undefined;
}

export async function main(argv: string[], io: Io): Promise<number> {
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
      },
    });
  } catch (e) {
    io.stderr(`rung: ${(e as Error).message}\n`);
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
        let failed = 0;
        for (const f of results) {
          if (f.error) {
            failed++;
            io.stdout(`FAIL ${f.file}: ${f.error}
`);
            continue;
          }
          for (const c of f.cases) {
            io.stdout(`${c.passed ? "ok  " : "FAIL"} ${f.block}: ${c.name}${c.error ? ` — ${c.error}` : ""}
`);
            for (const x of c.failures) io.stdout(`       step ${x.step}: ${x.name} expected ${JSON.stringify(x.expected)} got ${JSON.stringify(x.actual)}
`);
            if (!c.passed) failed++;
          }
        }
        if (v.junit) await writeFileAtomic(resolve(io.cwd, v.junit as string), toJUnit(results));
        const total = results.reduce((n, f) => n + (f.error ? 1 : f.cases.length), 0);
        if (!total) {
          io.stdout(`no tests${v.filter ? ` match "${String(v.filter)}"` : ""}: rung test runs tests/**/*.test.yaml (docs/testing.md)\n`);
          return 1;
        }
        io.stdout(`
${total - failed}/${total} passed (offline simulation — not a PLCSIM run)
`);
        return failed ? 2 : total ? 0 : 1;
      }
      case "live":
        return await cmdLive(dir, target, positionals.slice(2), io);
      case "views": {
        const ws = await findWorkspace(dir);
        const tags = await writeTagViews(ws);
        let model: string[] = [];
        if (!v.offline) {
          const config = await loadConfig(ws);
          const client = await bridgeFor(config, io);
          try {
            const r = await writeModelViews(ws, client);
            model = r.written;
            for (const t of r.truncated) io.stderr(`rung views: ${t} view truncated (object limit)
`);
          } finally {
            await client.close();
          }
        }
        io.stdout(`wrote ${tags.length + model.length} views under ${join(ws, "views")}
`);
        return 0;
      }
      case "agents": {
        const ws = await findWorkspace(dir);
        const config = await loadConfig(ws);
        await writeAgentsFile(ws, config.project.path, await agentsTemplate(config.project.path));
        io.stdout(`updated ${join(ws, "AGENTS.md")}
`);
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
        io.stderr(`rung: unknown command ${cmd}\n${HELP}`);
        return 1;
    }
  } catch (e) {
    if (e instanceof BridgeError || e instanceof WorkspaceError) {
      io.stderr(`rung: ${e.code}: ${e.message}\n`);
      const hint = HINTS[e.code];
      if (hint) io.stderr(`hint: ${hint}\n`);
      return 1;
    }
    throw e;
  } finally {
    await closePlcLinks();
  }
}
