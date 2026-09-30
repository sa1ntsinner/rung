// SPDX-License-Identifier: BUSL-1.1
// Two-way commands: sync, watch (the workspace owner), status, resolve, confirm-delete, compile.
import { join, relative, resolve, sep } from "node:path";
import { StateStore, WorkspaceError, loadConfig, parseAddress } from "@rung/core";
import { OwnerClient, OwnerServer, Watcher, confirmDelete, placeCompileMessages, renameObject, resolveConflict, syncOnce, type RenameReport, type SyncReport } from "@rung/sync";
import { readFile } from "node:fs/promises";
import { bridgeFor, findWorkspace, importFlags, isNotice, openState, printWarnings, type Io } from "./common.js";

function printReport(io: Io, r: SyncReport) {
  io.stdout(
    `exported ${r.exported}  imported ${r.imported}  created ${r.created}  merged ${r.merged}  conflicts ${r.conflicts}  pending-deletes ${r.pendingDeletes}  removed ${r.removed}  unchanged ${r.unchanged}\n`,
  );
  printWarnings(io, r.warnings);
  for (const d of r.diagnostics) io.stdout(`  ${d.severity.padEnd(8)} ${d.code.padEnd(18)} ${d.path || d.address}${d.line ? `:${d.line}` : ""} — ${d.message}\n`);
}

const exitCode = (r: SyncReport) => (r.conflicts || r.diagnostics.some((d) => d.severity === "error") ? 2 : r.warnings.some((w) => !isNotice(w.code)) ? 2 : 0);

export async function cmdSync(dir: string, io: Io): Promise<number> {
  const owner = await OwnerClient.connect(dir);
  if (owner) {
    try {
      const r = await owner.request<SyncReport | null>("syncNow");
      if (!r) {
        io.stderr("rung: the watcher is backing off after a bridge error; see rung status\n");
        return 1;
      }
      printReport(io, r);
      return exitCode(r);
    } finally {
      owner.close();
    }
  }
  const config = await loadConfig(dir);
  // the lock before the bridge: a workspace another rung process holds fails before a TIA Portal starts for nothing
  const state = await openState(dir, config);
  try {
    const client = await bridgeFor(config, io, importFlags(config));
    try {
      const r = await syncOnce(dir, client, state, { config });
      printReport(io, r);
      return exitCode(r);
    } finally {
      await client.close();
    }
  } finally {
    await state.close();
  }
}

/** Runs the workspace owner until the stop signal: watcher + IPC for CLI, LSP and MCP clients. */
export async function cmdWatch(dir: string, io: Io): Promise<number> {
  const config = await loadConfig(dir);
  const state = await openState(dir, config); // single writer: fails with STATE_LOCKED if another owner runs
  let server: OwnerServer | undefined;
  // an open conflict or pending delete is in every pass: print a pass when it did something or when what
  // stands open changed, not every two seconds
  const standing = (r: SyncReport) =>
    JSON.stringify([r.conflicts, r.pendingDeletes, r.warnings.map((w) => [w.address, w.code, w.message]), r.diagnostics.map((d) => [d.path, d.code, d.line, d.message])]);
  let shown = standing({ exported: 0, imported: 0, created: 0, merged: 0, unchanged: 0, conflicts: 0, removed: 0, pendingDeletes: 0, warnings: [], diagnostics: [] });
  const watcher = new Watcher(dir, state, {
    config,
    // the watch takes downloads only when they are on for the workspace (and checks the confirmed PLC itself)
    bridgeFactory: () => bridgeFor(config, io, [...importFlags(config), ...(config.download.enabled ? ["--allow-download"] : [])]),
    onReport: (r) => {
      const now = standing(r);
      if (r.exported + r.imported + r.created + r.merged + r.removed || now !== shown) printReport(io, r);
      shown = now;
      server?.emit("report", r);
      server?.emit("diagnostics", { items: r.diagnostics });
    },
    onError: (e, wait) => {
      io.stderr(`rung watch: ${(e as { code?: string }).code ?? "ERROR"}: ${e.message} — retrying in ${Math.round(wait / 1000)} s\n`);
      server?.emit("error", { message: e.message, retryInMs: wait });
    },
  });
  const tools = () => {
    const b = watcher.bridgeForTools;
    if (!b) throw new WorkspaceError("NOT_READY", `rung watch is still connecting to ${config.project.tiaVersion === "CODESYS" ? "CODESYS" : "TIA Portal"}; try again in a moment`);
    return b as import("@rung/bridge-client").BridgeClient;
  };
  server = await OwnerServer.start(dir, {
    status: async () => statusOf(state, watcher),
    syncNow: async () => watcher.syncNow(true), // asked for: refused imports are tried again
    diagnostics: async () => watcher.lastReport?.diagnostics ?? [],
    resolve: async (p) => {
      await resolveConflict(dir, state, String(p.path), p.mode as "ours" | "theirs" | "merged");
      watcher.poke();
      return { resolved: true };
    },
    confirmDelete: async (p) => {
      const b = watcher.bridgeForTools;
      if (!b) throw new WorkspaceError("NOT_READY", `rung watch is still connecting to ${config.project.tiaVersion === "CODESYS" ? "CODESYS" : "TIA Portal"}; try again in a moment`);
      await confirmDelete(dir, b as never, state, String(p.address));
      return { deleted: true };
    },
    rename: async (p) => {
      const b = watcher.bridgeForTools;
      if (!b) throw new WorkspaceError("NOT_READY", `rung watch is still connecting to ${config.project.tiaVersion === "CODESYS" ? "CODESYS" : "TIA Portal"}; try again in a moment`);
      return renameObject(dir, b as never, state, config, String(p.address), String(p.newName));
    },
    compileHardware: async (p) => tools().compileHardware(String(p.device)),
    online: async (p) => tools().online(String(p.device), p.action as "state" | "online" | "offline", p.target as never),
    connections: async (p) => tools().connections(String(p.device), !!p.scan),
    compare: async (p) => tools().compare(String(p.device), p.target as never),
    projectInfo: async () => tools().projectInfo(),
    read: async (p) => tools().read(String(p.device), (p.expressions as string[]) ?? []),
    download: async (p) => {
      // rung download's own checks, applied here too: whatever else reaches the owner cannot skip them
      if (!config.download.enabled) throw new WorkspaceError("CONFIG_INVALID", "downloads are turned off for this workspace (download.enabled = false in rung.toml)");
      const request = p.request as { device?: string } | undefined;
      if (!request?.device || p.confirmed !== request.device)
        throw new WorkspaceError("BAD_ARGUMENT", "a download names the PLC a person confirmed it for; run rung download, which asks for it");
      return tools().download(request as never);
    },
    show: async (p) => tools().show(String(p.address)),
    compile: async (p) => {
      const b = watcher.bridgeForTools;
      if (!b) throw new WorkspaceError("NOT_READY", `rung watch is still connecting to ${config.project.tiaVersion === "CODESYS" ? "CODESYS" : "TIA Portal"}; try again in a moment`);
      const devices = config.devices.length ? config.devices : (await (b as import("@rung/bridge-client").BridgeClient).projectInfo()).devices;
      if (!p.device && devices.length !== 1) throw new WorkspaceError("BAD_ARGUMENT", `the project has several PLCs (${devices.join(", ")}); name one`);
      const msgs = await b.compile(String(p.device ?? devices[0]), (p.addresses as string[] | undefined) ?? []);
      return placeCompileMessages(dir, (a) => state.get(a)?.path, msgs, (f) => readFile(f, "utf8"));
    },
  });
  io.stdout(`rung watch: ${dir} ⇄ ${config.project.path} (poll ${config.sync.pollMs} ms, import ${config.sync.import}). Ctrl+C to stop.\n`);
  watcher.start();
  await (io.stopSignal ?? new Promise<void>((r) => process.once("SIGINT", () => r())));
  await watcher.stop();
  await server.close();
  await state.close();
  io.stdout("rung watch: stopped\n");
  return 0;
}

function statusOf(state: StateStore, watcher?: Watcher) {
  const all = state.all();
  const by = (s: string) => all.filter((o) => o.status === s).map((o) => o.path);
  return {
    objects: all.length,
    synced: all.filter((o) => o.status === "synced").length,
    readOnly: all.filter((o) => o.readOnly).length,
    conflicted: by("conflicted"),
    fileDirty: by("fileDirty"),
    pendingDelete: by("pendingDelete"),
    recoveryRequired: by("recoveryRequired"),
    owner: watcher ? { lastPassAt: watcher.lastPassAt, lastError: watcher.lastError, scanAgeMs: watcher.lastPassAt ? Date.now() - watcher.lastPassAt : null } : null,
  };
}

export async function cmdStatus(dir: string, io: Io): Promise<number> {
  const owner = await OwnerClient.connect(dir);
  let s: ReturnType<typeof statusOf>;
  if (owner) {
    try {
      s = await owner.request("status");
    } finally {
      owner.close();
    }
  } else {
    await loadConfig(dir);
    const state = await StateStore.open(dir, null);
    try {
      s = statusOf(state);
    } finally {
      await state.close();
    }
  }
  io.stdout(`${s.objects} object${s.objects === 1 ? "" : "s"}, ${s.synced} synced, ${s.readOnly} read-only${s.owner ? `, watching (last pass ${s.owner.scanAgeMs ?? "-"} ms ago${s.owner.lastError ? `, error: ${s.owner.lastError}` : ""})` : ""}\n`);
  for (const [label, list] of [["conflicted", s.conflicted], ["file dirty", s.fileDirty], ["pending delete", s.pendingDelete], ["recovery", s.recoveryRequired]] as const)
    for (const p of list) io.stdout(`  ${label.padEnd(16)} ${p}\n`);
  // compile errors TIA reported and that still apply
  let compileErrors: { path?: string; line?: number; message: string; severity: string; code: string }[] = [];
  try {
    compileErrors = ((JSON.parse(await readFile(join(dir, ".rung", "diagnostics.json"), "utf8")) as { items?: typeof compileErrors }).items ?? []).filter((d) => d.code === "COMPILE" && d.severity === "error" && !/^Compiling finished/.test(d.message));
  } catch {
    /* no pass yet */
  }
  for (const d of compileErrors) io.stdout(`  ${"compile error".padEnd(16)} ${d.path ?? ""}${d.line ? `:${d.line}` : ""} — ${d.message}\n`);
  return s.conflicted.length || s.recoveryRequired.length || compileErrors.length ? 2 : 0;
}

export async function cmdResolve(file: string, mode: "ours" | "theirs" | "merged", io: Io): Promise<number> {
  const dir = await findWorkspace(resolve(io.cwd, file, ".."));
  const rel = relative(dir, resolve(io.cwd, file)).split(sep).join("/").replace(/\.(conflict|tia)$/, "");
  const owner = await OwnerClient.connect(dir);
  if (owner) {
    try {
      await owner.request("resolve", { path: rel, mode });
    } finally {
      owner.close();
    }
  } else {
    const config = await loadConfig(dir);
    const state = await openState(dir, config);
    try {
      await resolveConflict(dir, state, rel, mode);
    } finally {
      await state.close();
    }
  }
  io.stdout(`resolved ${rel} (${mode})${mode === "theirs" ? "" : " — it is sent to TIA on the next sync"}\n`);
  return 0;
}

export async function cmdConfirmDelete(workspaceDir: string, what: string, io: Io): Promise<number> {
  const dir = await findWorkspace(workspaceDir);
  const address = await addressOf(dir, what, io.cwd);
  const owner = await OwnerClient.connect(dir);
  if (owner) {
    try {
      await owner.request("confirmDelete", { address });
    } finally {
      owner.close();
    }
  } else {
    const config = await loadConfig(dir);
    const state = await openState(dir, config);
    try {
      const client = await bridgeFor(config, io, importFlags(config));
      try {
        await confirmDelete(dir, client, state, address);
      } finally {
        await client.close();
      }
    } finally {
      await state.close();
    }
  }
  io.stdout(`deleted ${address} in TIA Portal\n`);
  return 0;
}

/** Address of a mirrored object named by its workspace file or by its name (read without the state lock). */
async function addressOf(ws: string, what: string, cwd: string): Promise<string> {
  let objects: { address: string; path: string }[] = [];
  try {
    objects = Object.values((JSON.parse(await readFile(join(ws, ".rung", "state.json"), "utf8")) as { objects?: Record<string, { address: string; path: string }> }).objects ?? {});
  } catch {
    /* no state yet */
  }
  const rel = relative(ws, resolve(cwd, what)).split(sep).join("/");
  const byPath = objects.find((o) => o.path === rel || o.address === what);
  if (byPath) return byPath.address;
  const named = objects.filter((o) => parseAddress(o.address).name.toLowerCase() === what.replace(/^"|"$/g, "").toLowerCase());
  if (named.length === 1) return named[0]!.address;
  if (named.length > 1) throw new WorkspaceError("BAD_ARGUMENT", `several objects are named ${what}: ${named.map((o) => o.path).join(", ")}; give the file instead`);
  throw new WorkspaceError("NOT_MIRRORED", `no mirrored object or file ${what}; run rung pull`);
}

/** rung rename <file|name> <new-name>: TIA Portal renames it and keeps every use; the files that use it follow. */
export async function cmdRename(dir: string, what: string, newName: string, io: Io): Promise<number> {
  const ws = await findWorkspace(dir);
  const address = await addressOf(ws, what, io.cwd);
  let r: RenameReport;
  const owner = await OwnerClient.connect(ws);
  if (owner) {
    try {
      r = await owner.request<RenameReport>("rename", { address, newName });
    } finally {
      owner.close();
    }
  } else {
    const config = await loadConfig(ws);
    const client = await bridgeFor(config, io, importFlags(config));
    try {
      const state = await openState(ws, config);
      try {
        r = await renameObject(ws, client, state, config, address, newName);
      } finally {
        await state.close();
      }
    } finally {
      await client.close();
    }
  }
  io.stdout(`renamed ${parseAddress(r.from).name} to ${newName}: ${r.oldPath} → ${r.newPath ?? "(not mirrored)"}\n`);
  if (r.users.length) io.stdout(`updated where it is used: ${r.users.join(", ")}\n`);
  printWarnings(io, r.pull.warnings);
  return 0;
}
