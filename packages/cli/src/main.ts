// SPDX-License-Identifier: BUSL-1.1
import { parseArgs } from "node:util";
import { readFile, writeFile, appendFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { doctor, pull, summarize } from "@rung/sync";

export const VERSION = "0.1.0-dev";

export interface Io {
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
}

const HELP = `rung ${VERSION} — PLC-as-code for Siemens TIA Portal

Usage:
  rung init [dir] [--project <file.ap20>] [--tia V20] [--device <name>]... [--rebind]
  rung pull [dir] [--force]
  rung status [dir]
  rung doctor [dir] --fixture       round-trip probe; imports over objects (fixture projects only)

Environment:
  RUNG_BRIDGE       path to rung-bridge-v20.exe (default: bundled/dev build)
`;

const HINTS: Record<string, string> = {
  ACCESS_DENIED:
    'Your Windows user must be in the local group "Siemens TIA Openness" (run as admin: net localgroup "Siemens TIA Openness" %USERNAME% /add, then sign out and in) and you must accept the Openness access dialog in TIA Portal.',
  TIA_NOT_RUNNING: "Start TIA Portal and open the project first.",
  NO_PROJECT: "Open the bound project in TIA Portal (rung never opens or modifies projects on its own).",
  AMBIGUOUS_PORTAL: "Several TIA Portal instances match. Close the extra ones or pass --project.",
  NOT_A_WORKSPACE: "Run rung init in this folder first.",
  BINDING_MISMATCH: "This folder mirrors a different project. Use another folder or rung init --rebind.",
  STATE_LOCKED: "Another rung process is using this workspace.",
};

function defaultBridge(env: Io["env"]): { command: string; args: string[] } {
  const args = env.RUNG_BRIDGE_ARGS ? (JSON.parse(env.RUNG_BRIDGE_ARGS) as string[]) : [];
  if (env.RUNG_BRIDGE) return { command: env.RUNG_BRIDGE, args };
  const dev = fileURLToPath(new URL("../../../bridge/src/Rung.Bridge.V20/bin/Release/net48/rung-bridge-v20.exe", import.meta.url));
  return { command: dev, args };
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function bridgeFor(config: RungConfig, io: Io, extra: string[] = []) {
  // Environment override wins so tests and dev setups can swap the bridge without editing rung.toml.
  const env = defaultBridge(io.env);
  const command = io.env.RUNG_BRIDGE ? env.command : config.bridge.command;
  const args = [...(io.env.RUNG_BRIDGE ? env.args : config.bridge.args), "--project", config.project.path, ...extra];
  return BridgeClient.spawn({ command, args, env: Object.fromEntries(Object.entries(io.env).filter(([, v]) => v !== undefined)) as Record<string, string> });
}

async function agentsTemplate(project: string): Promise<string> {
  try {
    const t = await readFile(fileURLToPath(new URL("../../../agents/AGENTS.template.md", import.meta.url)), "utf8");
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
    const config = defaultConfig(info.path, tia, bridge.command, devices);
    config.bridge.args = bridge.args;
    await saveConfig(dir, config);
    const gi = join(dir, ".gitignore");
    const current = (await exists(gi)) ? await readFile(gi, "utf8") : "";
    if (!current.split(/\r?\n/).includes(".rung/")) await appendFile(gi, (current && !current.endsWith("\n") ? "\n" : "") + ".rung/\n");
    if (!(await exists(join(dir, "AGENTS.md")))) await writeFile(join(dir, "AGENTS.md"), await agentsTemplate(info.path));
    const state = await StateStore.open(dir, { projectPath: info.path, tiaVersion: tia, devices: devices.length ? devices : info.devices }, { rebind: !!v.rebind });
    await state.close();
    io.stdout(`Bound ${dir} to ${info.path} (${tia}, devices: ${(devices.length ? devices : info.devices).join(", ")}).\nNext: rung pull\n`);
    return 0;
  } finally {
    await client.close();
  }
}

async function openState(dir: string, config: RungConfig, devices: string[]) {
  return StateStore.open(dir, { projectPath: config.project.path, tiaVersion: config.project.tiaVersion, devices: config.devices.length ? config.devices : devices });
}

async function cmdPull(dir: string, v: Record<string, unknown>, io: Io): Promise<number> {
  const config = await loadConfig(dir);
  const client = await bridgeFor(config, io);
  try {
    const info = await client.projectInfo();
    const state = await openState(dir, config, info.devices);
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
      for (const w of report.warnings) io.stdout(`  ${w.code.padEnd(18)} ${w.address}${w.message ? ` — ${w.message}` : ""}\n`);
      return report.warnings.length ? 2 : 0;
    } finally {
      await state.close();
    }
  } finally {
    await client.close();
  }
}

async function cmdStatus(dir: string, io: Io): Promise<number> {
  await loadConfig(dir);
  const state = await StateStore.open(dir, null);
  try {
    const all = state.all();
    const synced = all.filter((o) => o.status === "synced").length;
    io.stdout(`${all.length} objects, ${synced} synced, ${all.filter((o) => o.readOnly).length} read-only\n`);
    for (const o of all.filter((x) => x.status !== "synced")) io.stdout(`  ${o.status.padEnd(16)} ${o.path}\n`);
    return 0;
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
  const dir = resolve(io.cwd, target ?? ".");
  try {
    switch (cmd) {
      case "init":
        return await cmdInit(dir, v, io);
      case "pull":
        return await cmdPull(dir, v, io);
      case "status":
        return await cmdStatus(dir, io);
      case "doctor":
        return await cmdDoctor(dir, v, io);
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
