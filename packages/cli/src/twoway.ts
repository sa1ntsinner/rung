// SPDX-License-Identifier: BUSL-1.1
// Two-way commands: sync, watch (the workspace owner), status, resolve, confirm-delete, compile.
import { join, relative, resolve, sep } from "node:path";
import { StateStore, WorkspaceError, grantWrites, loadConfig, parseAddress, readWrites, revokeWrites, writesGranted, type RungConfig } from "@rung/core";
import { OwnerClient, OwnerServer, Watcher, confirmDelete, localStatus, recordBackup, placeCompileMessages, renameObject, resolveConflict, restoreFile, syncOnce, unifiedDiff, type PlanEntry, type RenameReport, type SyncReport } from "@rung/sync";
import { WorkspaceIndex, diagnostics, nearest, uriOf } from "@rung/lsp";
import { readFile } from "node:fs/promises";
import { bridgeFor, findWorkspace, importFlags, isNotice, openState, printWarnings, type Io } from "./common.js";

export function validateTags(path: string, text: string) {
  const index = new WorkspaceIndex();
  const uri = uriOf(resolve(path));
  index.set(uri, text, 0);
  const doc = index.docs.get(uri)!;
  const codes = new Set(["SYNTAX", "TAG_COMMENT", "TAG_LINE", "DUPLICATE_TAG", "NO_VALUE", "START_VALUE", "NO_ADDRESS", "BAD_ADDRESS", "ADDRESS_SIZE"]);
  return diagnostics(index, uri).filter((d) => codes.has(d.code)).map((d) => ({ code: d.code, message: d.message, line: doc.lines.position(d.start).line + 1 }));
}

const diagnosticTarget = (d: { path?: string; address?: string }) => d.path || (d.address?.startsWith("plc:") && !d.address.includes("/") ? `PLC ${d.address.slice(4)}` : d.address ?? "");

export function printReport(io: Io, r: SyncReport) {
  if (r.backup) io.stdout(`archived the project before writing into it: ${r.backup.path} (${Math.max(1, Math.round(r.backup.bytes / 1024))} KB; TIA Portal's Project → Retrieve opens it)\n`);
  io.stdout(
    `exported ${r.exported}  imported ${r.imported}  created ${r.created}  merged ${r.merged}  conflicts ${r.conflicts}  pending-deletes ${r.pendingDeletes}  removed ${r.removed}  unchanged ${r.unchanged}\n`,
  );
  const changes = r.changes ?? [];
  for (const c of changes.slice(0, 8)) {
    const toTia = c.action === "import" || c.action === "create" || c.action === "merge";
    const note = c.action === "create" ? " (created)" : c.action === "merge" ? " (merged)" : c.action === "remove" ? " (removed)" : c.action === "restore" ? " (restored)" : "";
    io.stdout(`${toTia ? "→" : "←"} TIA  ${c.path}${note}\n`);
  }
  if (changes.length > 8) io.stdout(`… ${changes.length - 8} more files (${changes.length} moved; rung sync --json lists all)\n`);
  printWarnings(io, r.warnings.filter((w) => !r.diagnostics.some((d) => d.address === w.address && d.code === w.code && d.message === w.message)));
  for (const d of r.diagnostics) io.stdout(`  ${d.severity.padEnd(8)} ${d.code.padEnd(18)} ${diagnosticTarget(d)}${d.line ? `:${d.line}` : ""} — ${d.message}\n`);
  const compiled = r.diagnostics.filter((d) => d.code === "COMPILE");
  if (compiled.length) io.stdout(`compile: ${compiled.filter((d) => d.severity === "error").length} error(s), ${compiled.filter((d) => d.severity === "warning").length} warning(s)\n`);
}

const exitCode = (r: SyncReport) => (r.conflicts || r.diagnostics.some((d) => d.severity === "error") ? 2 : r.warnings.some((w) => !isNotice(w.code)) ? 2 : 0);

const VERB: Record<PlanEntry["action"], string> = {
  create: "create",
  update: "update",
  merge: "merge",
  export: "from TIA",
  remove: "remove",
  restore: "restore",
  conflict: "conflict",
  "pending-delete": "pending",
};

/** rung sync --preview, for a person: each object, where it goes, and the lines that change there. */
function printPlan(io: Io, r: SyncReport, writesOff: boolean) {
  const plan = r.plan!;
  io.stdout("What rung sync would do now (nothing is sent, written or recorded):\n");
  // "agree" only when nothing below says otherwise (a read-only file edited here is not sent, but they differ)
  if (!plan.entries.length) io.stdout(r.diagnostics.some((d) => d.severity === "error") || r.warnings.length ? "  nothing to send or bring in\n" : "  nothing: files and TIA Portal agree\n");
  for (const e of plan.entries) {
    const sent = e.action === "create" || e.action === "update" || e.action === "merge";
    const where = e.action === "export" || e.action === "restore" ? `TIA Portal → ${e.path}` : sent ? `${e.path} → TIA Portal${e.action === "create" ? " (new)" : e.action === "merge" ? " (merged with TIA Portal's change)" : ""}` : e.path;
    io.stdout(`  ${VERB[e.action].padEnd(9)} ${where}${e.detail ? ` — ${e.detail}` : ""}\n`);
    if (e.before === undefined || e.after === undefined || e.action === "create") continue;
    const lines = unifiedDiff(e.before, e.after, "", "").split("\n").slice(2);
    for (const l of lines.slice(0, 30)) io.stdout(`            ${l}\n`);
    if (lines.length > 30) io.stdout(`            … ${lines.length - 30} more lines (rung sync --preview --json has them all)\n`);
  }
  printWarnings(io, r.warnings);
  for (const d of r.diagnostics) io.stdout(`  ${d.severity.padEnd(8)} ${d.code.padEnd(18)} ${diagnosticTarget(d)}${d.line ? `:${d.line}` : ""} — ${d.message}\n`);
  if (plan.compile.length) io.stdout(`compiled afterwards: ${plan.compile.map((a) => (a.startsWith("plc:") ? parseAddress(a).name : a)).join(", ")}\n`);
  if (writesOff && plan.entries.some((e) => e.action === "create" || e.action === "update" || e.action === "merge"))
    io.stdout("writes to TIA Portal are off in this workspace: what goes to TIA Portal waits until rung writes on\n");
}

export async function cmdSync(dir: string, io: Io, opts: { preview?: boolean; json?: boolean } = {}): Promise<number> {
  const owner = await OwnerClient.connect(dir);
  if (owner && opts.preview) {
    try {
      const r = await owner.request<SyncReport & { writesOff: boolean }>("preview");
      if (opts.json) io.stdout(JSON.stringify(r, null, 2) + "\n");
      else printPlan(io, r, r.writesOff);
      return 0;
    } finally {
      owner.close();
    }
  }
  if (owner) {
    try {
      const r = await owner.request<SyncReport | null>("syncNow");
      if (!r) {
        io.stderr("rung: the watcher is backing off after a bridge error; see rung status\n");
        return 1;
      }
      if (opts.json) io.stdout(JSON.stringify(r, null, 2) + "\n");
      else printReport(io, r);
      return exitCode(r);
    } finally {
      owner.close();
    }
  }
  const config = await loadConfig(dir);
  // the lock before the bridge: a workspace another rung process holds fails before a TIA Portal starts for nothing
  const state = await openState(dir, config);
  try {
    // a preview's bridge may not import at all
    const client = await bridgeFor(config, io, opts.preview ? [] : importFlags(config));
    try {
      const r = await syncOnce(dir, client, state, { config, validateTags, preview: !!opts.preview });
      if (opts.preview) {
        const writesOff = !!config.writesOff || config.sync.import !== "auto";
        if (opts.json) io.stdout(JSON.stringify({ ...r, writesOff }, null, 2) + "\n");
        else printPlan(io, r, writesOff);
        return 0;
      }
      if (opts.json) io.stdout(JSON.stringify(r, null, 2) + "\n");
      else printReport(io, r);
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
  // rung writes on/off and rung.toml as they are now: the watch reads them before every pass
  let live = config;
  // an open conflict or pending delete is in every pass: print a pass when it did something or when what
  // stands open changed, not every two seconds
  const standing = (r: SyncReport) =>
    JSON.stringify([r.conflicts, r.pendingDeletes, r.warnings.map((w) => [w.address, w.code, w.message]), r.diagnostics.map((d) => [d.path, d.code, d.line, d.message])]);
  let shown = standing({ exported: 0, imported: 0, created: 0, merged: 0, unchanged: 0, conflicts: 0, removed: 0, pendingDeletes: 0, warnings: [], diagnostics: [] });
  const watcher = new Watcher(dir, state, {
    config,
    reloadConfig: async () => (live = await loadConfig(dir)),
    validateTags,
    // the watch takes downloads only when they are on for the workspace (and checks the confirmed PLC itself)
    bridgeFactory: () => bridgeFor(live, io, [...importFlags(live), ...(config.download.enabled ? ["--allow-download"] : [])]),
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
    // editors show it while it happens (the language server turns it into progress)
    onPhase: (phase, detail) => server?.emit("phase", { phase, detail }),
  });
  const tools = () => {
    const b = watcher.bridgeForTools;
    if (!b) throw new WorkspaceError("NOT_READY", `rung watch is still connecting to ${config.project.tiaVersion === "CODESYS" ? "CODESYS" : "TIA Portal"}; try again in a moment`);
    return b as import("@rung/bridge-client").BridgeClient;
  };
  server = await OwnerServer.start(dir, {
    status: async () => statusOf(state, watcher),
    syncNow: async () => watcher.syncNow(true), // asked for: refused imports are tried again
    preview: async () => {
      const r = await watcher.preview();
      if (!r) throw new WorkspaceError("NOT_READY", `rung watch is still connecting to ${config.project.tiaVersion === "CODESYS" ? "CODESYS" : "TIA Portal"}; try again in a moment`);
      return { ...r, writesOff: !!live.writesOff || live.sync.import !== "auto" };
    },
    diagnostics: async () => watcher.lastReport?.diagnostics ?? [],
    resolve: async (p) => {
      await resolveConflict(dir, state, String(p.path), p.mode as "ours" | "theirs" | "merged");
      watcher.poke();
      return { resolved: true };
    },
    restore: async (p) => restoreFile(dir, state, String(p.path)),
    confirmDelete: async (p) => {
      mayWrite(live, "deleted");
      const b = watcher.bridgeForTools;
      if (!b) throw new WorkspaceError("NOT_READY", `rung watch is still connecting to ${config.project.tiaVersion === "CODESYS" ? "CODESYS" : "TIA Portal"}; try again in a moment`);
      const { users } = await confirmDelete(dir, b as never, state, String(p.address), { force: !!p.force });
      return { deleted: true, users: users.map((a) => state.get(a)?.path ?? a) };
    },
    rename: async (p) => {
      mayWrite(live, "renamed");
      const b = watcher.bridgeForTools;
      if (!b) throw new WorkspaceError("NOT_READY", `rung watch is still connecting to ${config.project.tiaVersion === "CODESYS" ? "CODESYS" : "TIA Portal"}; try again in a moment`);
      return renameObject(dir, b as never, state, config, String(p.address), String(p.newName));
    },
    compileHardware: async (p) => tools().compileHardware(String(p.device)),
    archive: async () => {
      const b = await tools().archive(config.sync.backupDir);
      if (b) await recordBackup(dir, config, b.path, Date.now());
      return b;
    },
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
  io.stdout(`rung watch: ${dir} ⇄ ${config.project.path} (poll ${config.sync.pollMs} ms, writes ${writesLabel(config)}). Ctrl+C to stop.\n`);
  watcher.start();
  await (io.stopSignal ?? new Promise<void>((r) => process.once("SIGINT", () => r())));
  await watcher.stop();
  await server.close();
  await state.close();
  io.stdout("rung watch: stopped\n");
  return 0;
}

async function statusOf(state: StateStore, watcher?: Watcher) {
  const all = await Promise.all(state.all().map(async (o) => {
    if (o.status === "conflicted" || o.status === "recoveryRequired" || o.status === "importing") return o;
    const disk = await localStatus(state.root, o.files);
    return { ...o, status: disk === "clean" ? (o.status === "fileDirty" || o.status === "pendingDelete" ? "synced" : o.status) : disk === "missing" ? "pendingDelete" : "fileDirty" };
  }));
  const by = (s: string) => all.filter((o) => o.status === s).map((o) => o.path);
  return {
    objects: all.length,
    synced: all.filter((o) => o.status === "synced").length,
    readOnly: all.filter((o) => o.readOnly).length,
    conflicted: by("conflicted"),
    fileDirty: by("fileDirty"),
    unsent: all.filter((o) => o.status === "fileDirty" || o.status === "conflicted").map((o) => ({ path: o.path, reason: o.status === "conflicted" ? "conflict" : o.notSent ? `${o.notSent.code}: ${o.notSent.message}` : o.readOnly ? "read-only" : undefined })),
    pendingDelete: by("pendingDelete"),
    recoveryRequired: by("recoveryRequired"),
    owner: watcher ? { lastPassAt: watcher.lastPassAt, lastError: watcher.lastError, scanAgeMs: watcher.lastPassAt ? Date.now() - watcher.lastPassAt : null } : null,
  };
}

export async function cmdStatus(dir: string, io: Io): Promise<number> {
  const config = await loadConfig(dir);
  const owner = await OwnerClient.connect(dir);
  let s: Awaited<ReturnType<typeof statusOf>>;
  if (owner) {
    try {
      s = await owner.request("status");
    } finally {
      owner.close();
    }
  } else {
    const state = await StateStore.open(dir, null);
    try {
      s = await statusOf(state);
    } finally {
      await state.close();
    }
  }
  io.stdout(`writes to TIA Portal: ${writesLabel(config)}\n`);
  io.stdout(`${s.objects} object${s.objects === 1 ? "" : "s"}, ${s.synced} synced, ${s.readOnly} read-only${s.owner ? `, watching (last pass ${s.owner.scanAgeMs ?? "-"} ms ago${s.owner.lastError ? `, error: ${s.owner.lastError}` : ""})` : ""}\n`);
  for (const [label, list] of [["pending delete", s.pendingDelete], ["recovery", s.recoveryRequired]] as const)
    for (const p of list) io.stdout(`  ${label.padEnd(16)} ${p}\n`);
  for (const u of s.unsent) io.stdout(`  edited, not sent ${u.path} — ${u.reason ?? (config.writesOff ? "writes off (rung writes on)" : config.sync.import === "manual" ? "sync.import = manual" : "rung sync")}\n`);
  // compile errors TIA reported and that still apply
  let compileErrors: { address?: string; path?: string; line?: number; message: string; severity: string; code: string }[] = [];
  try {
    compileErrors = ((JSON.parse(await readFile(join(dir, ".rung", "diagnostics.json"), "utf8")) as { items?: typeof compileErrors }).items ?? []).filter((d) => d.code === "COMPILE" && d.severity === "error" && !/^Compiling finished/.test(d.message));
  } catch {
    /* no pass yet */
  }
  for (const d of compileErrors) io.stdout(`  ${"compile error".padEnd(16)} ${diagnosticTarget(d)}${d.line ? `:${d.line}` : ""} — ${d.message}\n`);
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

/** rung rename and rung confirm-delete change the project: refused before any bridge starts when this copy may not write. */
function mayWrite(config: RungConfig, action: string): void {
  if (config.writesOff) throw new WorkspaceError("WRITES_OFF", `not ${action}: writes to TIA Portal are off in this workspace (rung writes on)`);
  if (config.sync.import !== "auto") throw new WorkspaceError("WRITES_OFF", `not ${action}: sync.import = "manual" in rung.toml`);
}

/** `rung restore <file>`: TIA Portal's version of one file as rung last had it; yours is kept in .rung/recovery. */
export async function cmdRestore(file: string, io: Io): Promise<number> {
  const dir = await findWorkspace(resolve(io.cwd, file, ".."));
  const rel = relative(dir, resolve(io.cwd, file)).split(sep).join("/");
  const owner = await OwnerClient.connect(dir);
  let r: { copy?: string };
  if (owner) {
    try {
      r = await owner.request<{ copy?: string }>("restore", { path: rel });
    } finally {
      owner.close();
    }
  } else {
    const config = await loadConfig(dir);
    const state = await openState(dir, config);
    try {
      r = await restoreFile(dir, state, rel);
    } finally {
      await state.close();
    }
  }
  io.stdout(`${rel}: TIA Portal's version is back${r.copy ? `; yours is kept in ${r.copy}` : " (it was not changed)"}\n`);
  return 0;
}

export async function cmdConfirmDelete(workspaceDir: string, what: string, io: Io, force = false): Promise<number> {
  const dir = await findWorkspace(workspaceDir);
  const address = await addressOf(dir, what, io.cwd);
  const owner = await OwnerClient.connect(dir);
  let users: string[] = [];
  if (owner) {
    try {
      users = (await owner.request<{ users?: string[] }>("confirmDelete", { address, force })).users ?? [];
    } finally {
      owner.close();
    }
  } else {
    const config = await loadConfig(dir);
    mayWrite(config, "deleted");
    const state = await openState(dir, config);
    try {
      const client = await bridgeFor(config, io, importFlags(config));
      try {
        users = (await confirmDelete(dir, client, state, address, { force })).users.map((a) => state.get(a)?.path ?? a);
      } finally {
        await client.close();
      }
    } finally {
      await state.close();
    }
  }
  io.stdout(`deleted ${what} in TIA Portal\n`);
  if (users.length) io.stdout(`what used it does not compile now: ${users.join(", ")} (rung compile shows where)\n`);
  return 0;
}

/**
 * TIA Portal renames the object and keeps every use, the files that use it follow: through rung watch when it runs,
 * else with a bridge of its own. Prints nothing (the language server calls it too).
 */
export async function renameInTia(ws: string, address: string, newName: string, io: Io): Promise<RenameReport> {
  const owner = await OwnerClient.connect(ws);
  if (owner) {
    try {
      return await owner.request<RenameReport>("rename", { address, newName });
    } finally {
      owner.close();
    }
  }
  const config = await loadConfig(ws);
  mayWrite(config, "renamed");
  const client = await bridgeFor(config, io, importFlags(config));
  try {
    const state = await openState(ws, config);
    try {
      return await renameObject(ws, client, state, config, address, newName);
    } finally {
      await state.close();
    }
  } finally {
    await client.close();
  }
}

/** Address of a mirrored object named by its workspace file or by its name (read without the state lock). */
export async function addressOf(ws: string, what: string, cwd: string): Promise<string> {
  let objects: { address: string; path: string; status?: string }[] = [];
  try {
    objects = Object.values((JSON.parse(await readFile(join(ws, ".rung", "state.json"), "utf8")) as { objects?: Record<string, { address: string; path: string; status?: string }> }).objects ?? {});
  } catch {
    /* no state yet */
  }
  const rel = relative(ws, resolve(cwd, what)).split(sep).join("/");
  const byPath = objects.find((o) => o.path === rel || o.address === what);
  if (byPath) return byPath.address;
  const named = objects.filter((o) => parseAddress(o.address).name.toLowerCase() === what.replace(/^"|"$/g, "").toLowerCase());
  if (named.length === 1) return named[0]!.address;
  if (named.length > 1) throw new WorkspaceError("BAD_ARGUMENT", `several objects are named ${what}: ${named.map((o) => o.path).join(", ")}; give the file instead`);
  const pending = objects.filter((o) => o.status === "pendingDelete").map((o) => o.path);
  const nearName = nearest(what, objects.map((o) => parseAddress(o.address).name));
  const near = nearest(rel, objects.map((o) => o.path)) ?? objects.find((o) => parseAddress(o.address).name === nearName)?.path;
  const hint = pending.length ? `pending deletes: ${pending.slice(0, 5).join(", ")}${pending.length > 5 ? ", … (rung status lists all)" : ""}` : near ? `did you mean ${near}?` : `mirrored paths: ${objects.slice(0, 5).map((o) => o.path).join(", ") || "none"}; check the file path`;
  throw new WorkspaceError("NOT_MIRRORED", `no mirrored object or file ${what}; ${hint}`);
}

/** rung rename <file|name> <new-name>: TIA Portal renames it and keeps every use; the files that use it follow. */
export async function cmdRename(dir: string, what: string, newName: string, io: Io): Promise<number> {
  const ws = await findWorkspace(dir);
  const address = await addressOf(ws, what, io.cwd).catch(async (e) => {
    // a tag or a variable is not an object of its own: say where it is renamed instead
    const index = new WorkspaceIndex();
    await index.load(ws);
    const tag = index.global(what.replace(/^"|"$/g, ""))?.tag;
    if (tag) throw new WorkspaceError("BAD_ARGUMENT", `${what} is a PLC tag in the table ${tag.table}: rename it in TIA Portal's tag table, which renames its uses too, and rung brings the change into the files (a new name on its line here would be a new tag, its uses left on the old one); rung rename renames blocks, data types, DBs and tag tables`);
    throw e;
  });
  const r = await renameInTia(ws, address, newName, io);
  io.stdout(`renamed ${parseAddress(r.from).name} to ${newName}: ${r.oldPath} → ${r.newPath ?? "(not mirrored)"}\n`);
  if (r.users.length) io.stdout(`updated where it is used: ${r.users.join(", ")}\n`);
  printWarnings(io, r.pull.warnings);
  return 0;
}

const writesLabel = (c: RungConfig) => (c.writesOff ? "off (rung writes on)" : c.sync.import === "auto" ? "on" : "off (sync.import = manual)");

/** `rung backup`: TIA Portal archives the project now (the same archive rung makes before the first write of a day). */
export async function cmdBackup(dir: string, io: Io): Promise<number> {
  const config = await loadConfig(dir);
  const owner = await OwnerClient.connect(dir);
  let b: { path: string; bytes: number; savedFirst?: boolean } | undefined;
  if (owner) {
    try {
      b = await owner.request("archive");
    } finally {
      owner.close();
    }
  } else {
    const client = await bridgeFor(config, io);
    try {
      b = await client.archive(config.sync.backupDir);
    } finally {
      await client.close();
    }
  }
  if (!b) {
    io.stderr(`rung: ${config.project.tiaVersion === "CODESYS" ? "CODESYS projects are not archived by rung; copy the .project file" : "this bridge cannot archive projects"}\n`);
    return 1;
  }
  await recordBackup(dir, config, b.path, Date.now());
  io.stdout(`${b.path} (${Math.max(1, Math.round(b.bytes / 1024))} KB)${b.savedFirst ? "; the project had changes and was saved first" : ""}\nTIA Portal's Project → Retrieve opens it.\n`);
  return 0;
}

/** `rung writes [on|off]`: whether this copy of the workspace may write into its project (core writes.ts). */
export async function cmdWrites(dir: string, what: string | undefined, io: Io): Promise<number> {
  if (what !== undefined && what !== "on" && what !== "off") {
    io.stderr("rung: usage: rung writes [on|off] [--dir <workspace>]\n");
    return 1;
  }
  const config = await loadConfig(dir, { raw: true });
  if (what === "on") await grantWrites(dir, config);
  if (what === "off") await revokeWrites(dir);
  const on = writesGranted(await readWrites(dir), config);
  const where = `${config.project.path}${config.bridge.host ? ` on ${config.bridge.host}` : ""}`;
  if (config.sync.import === "manual") io.stdout(`writes to TIA Portal: off for every copy of this workspace (sync.import = "manual" in rung.toml)${on ? `; this copy may write once it is "auto"` : ""}\n`);
  else if (on)
    io.stdout(`writes to TIA Portal: on for ${where}. rung sync and rung watch send your edits there, compile them and write TIA Portal's version back; rung rename and rung confirm-delete change it too. rung writes off stops that.\n`);
  else io.stdout(`writes to TIA Portal: off. rung pull, rung sync and rung watch bring TIA Portal's changes into the files; your edits stay in the files. rung writes on lets rung send them to ${where}.\n`);
  if (what) {
    // a running owner started its bridge with the rights it had then
    const owner = await OwnerClient.connect(dir);
    if (owner) {
      owner.close();
      io.stdout(`rung watch runs in this workspace and ${on ? "sends your edits from its next pass on" : "sends nothing more from its next pass on (a file it is sending right now still arrives)"}\n`);
    }
  }
  return 0;
}
