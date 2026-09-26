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
import { HINTS, bridgeFor, defaultBridge, exists, findWorkspace, importFlags, openState, printWarnings, type Io } from "./common.js";
import { startServer } from "@rung/lsp";
import { serveStdio } from "@rung/mcp";
import { writeAgentsFile } from "./agents.js";
import { cmdLive } from "./live.js";
import { agentsTemplatePath } from "./paths.js";
import { runTests, toJUnit } from "@rung/sim";
import { WorkspaceIndex } from "@rung/lsp";
import { cmdConfirmDelete, cmdResolve, cmdStatus, cmdSync, cmdWatch } from "./twoway.js";

export type { Io } from "./common.js";

export const VERSION = "0.1.0-dev";

const HELP = `rung ${VERSION} — PLC-as-code for Siemens TIA Portal

Usage:
  rung init [dir] [--project <file.ap20>] [--tia V20] [--device <name>]... [--rebind]
  rung pull [dir] [--force]            TIA → files (never overwrites local edits without --force)
  rung sync [dir]                      one two-way pass (imports need sync.import = "auto")
  rung watch [dir]                     keep syncing; serves CLI, editors and agents (Ctrl+C to stop)
  rung status [dir]
  rung resolve <file> --ours|--theirs|--merged
  rung confirm-delete <address> [--dir <workspace>]
  rung test [dir] [--junit <file>] [--filter <text>]  run tests/**/*.test.yaml on the offline SCL simulator
  rung live read <var>... [--dir <ws>] read live values from the PLC Web API (read-only)
  rung live diag [--dir <ws>]          PLC diagnostic buffer via the Web API
  rung views [dir] [--offline]         read-only YAML views of hardware, HMI, technology objects and tags
  rung agents [dir]                    regenerate the project summary in AGENTS.md
  rung mcp [dir]                       MCP server for AI agents (Claude Code, Codex, Cursor)
  rung lsp [--stdio]                   language server for editors (VS Code, Zed, Neovim)
  rung doctor [dir] --fixture          round-trip probe; imports over objects (fixture projects only)

Environment:
  RUNG_BRIDGE           path to rung-bridge-v20.exe (default: bundled/dev build)
  RUNG_WEBAPI_PASSWORD  password of the PLC web server user for rung live
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
  const args = [...bridge.args, ...(v.project ? ["--project", String(v.project)] : [])];
  const client = await BridgeClient.spawn({ command: bridge.command, args, env: io.env as Record<string, string> });
  try {
    const info = await client.projectInfo();
    const tia = (v.tia as string | undefined) ?? info.tiaVersion;
    if (tia !== "V20" && tia !== "V21") throw new WorkspaceError("CONFIG_INVALID", `unsupported TIA version ${tia}`);
    const devices = (v.device as string[] | undefined) ?? [];
    for (const d of devices) if (!info.devices.includes(d)) throw new WorkspaceError("CONFIG_INVALID", `device ${d} not in project (${info.devices.join(", ")})`);
    // On --rebind keep the user's sync/bridge settings; only the binding changes.
    const previous = v.rebind && (await exists(cfgPath)) ? await loadConfig(dir).catch(() => undefined) : undefined;
    const config = previous
      ? { ...previous, project: { path: info.path, tiaVersion: tia as "V20" | "V21" }, devices }
      : { ...defaultConfig(info.path, tia, bridge.command, devices), bridge: { command: bridge.command, args: bridge.args } };
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
      return report.warnings.length ? 2 : 0;
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
  const client = await bridgeFor(config, io, ["--allow-fixture-import"]);
  try {
    const rows = await doctor(dir, client, { devices: config.devices.length ? config.devices : undefined });
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
  }
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
        io.stdout(`
${total - failed}/${total} passed (offline SCL simulation — not a PLCSIM run)
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
        const ws = await findWorkspace(dir);
        const config = await loadConfig(ws);
        await serveStdio({ root: ws, bridgeFactory: () => bridgeFor(config, io, importFlags(config)) });
        await new Promise<void>((r) => process.stdin.once("end", () => r())); // until the agent closes stdin
        return 0;
      }
      case "init":
        return await cmdInit(dir, v, io);
      case "pull":
        return await cmdPull(dir, v, io);
      case "status":
        return await cmdStatus(dir, io);
      case "doctor":
        return await cmdDoctor(dir, v, io);
      case "sync":
        return await cmdSync(dir, io);
      case "watch":
        return await cmdWatch(dir, io);
      case "resolve": {
        const mode = v.ours ? "ours" : v.theirs ? "theirs" : v.merged ? "merged" : null;
        if (!target || !mode) {
          io.stderr("rung: usage: rung resolve <file> --ours|--theirs|--merged\n");
          return 1;
        }
        return await cmdResolve(target, mode, io);
      }
      case "confirm-delete":
        if (!target) {
          io.stderr("rung: usage: rung confirm-delete <address> [--dir <workspace>]\n");
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
  }
}
