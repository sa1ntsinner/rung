// SPDX-License-Identifier: BUSL-1.1
// Two-way commands: sync, watch (the workspace owner), status, resolve, confirm-delete, compile.
import { relative, resolve, sep } from "node:path";
import { StateStore, WorkspaceError, loadConfig } from "@rung/core";
import { OwnerClient, OwnerServer, Watcher, confirmDelete, placeCompileMessages, resolveConflict, syncOnce, type SyncReport } from "@rung/sync";
import { readFile } from "node:fs/promises";
import { bridgeFor, findWorkspace, importFlags, openState, printWarnings, type Io } from "./common.js";

function printReport(io: Io, r: SyncReport) {
  io.stdout(
    `exported ${r.exported}  imported ${r.imported}  created ${r.created}  merged ${r.merged}  conflicts ${r.conflicts}  pending-deletes ${r.pendingDeletes}  removed ${r.removed}  unchanged ${r.unchanged}\n`,
  );
  printWarnings(io, r.warnings);
  for (const d of r.diagnostics) io.stdout(`  ${d.severity.padEnd(8)} ${d.code.padEnd(18)} ${d.path || d.address}${d.line ? `:${d.line}` : ""} — ${d.message}\n`);
}

const exitCode = (r: SyncReport) => (r.conflicts || r.diagnostics.some((d) => d.severity === "error") ? 2 : r.warnings.length ? 2 : 0);

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
  const client = await bridgeFor(config, io, importFlags(config));
  try {
    const state = await openState(dir, config);
    try {
      const r = await syncOnce(dir, client, state, { config });
      printReport(io, r);
      return exitCode(r);
    } finally {
      await state.close();
    }
  } finally {
    await client.close();
  }
}

/** Runs the workspace owner until the stop signal: watcher + IPC for CLI, LSP and MCP clients. */
export async function cmdWatch(dir: string, io: Io): Promise<number> {
  const config = await loadConfig(dir);
  const state = await openState(dir, config); // single writer: fails with STATE_LOCKED if another owner runs
  let server: OwnerServer | undefined;
  const watcher = new Watcher(dir, state, {
    config,
    bridgeFactory: () => bridgeFor(config, io, importFlags(config)),
    onReport: (r) => {
      if (r.exported + r.imported + r.created + r.merged + r.conflicts + r.removed + r.pendingDeletes + r.diagnostics.length) printReport(io, r);
      server?.emit("report", r);
      server?.emit("diagnostics", { items: r.diagnostics });
    },
    onError: (e, wait) => {
      io.stderr(`rung watch: ${(e as { code?: string }).code ?? "ERROR"}: ${e.message} — retrying in ${Math.round(wait / 1000)} s\n`);
      server?.emit("error", { message: e.message, retryInMs: wait });
    },
  });
  server = await OwnerServer.start(dir, {
    status: async () => statusOf(state, watcher),
    syncNow: async () => watcher.syncNow(),
    diagnostics: async () => watcher.lastReport?.diagnostics ?? [],
    resolve: async (p) => {
      await resolveConflict(dir, state, String(p.path), p.mode as "ours" | "theirs" | "merged");
      watcher.poke();
      return { resolved: true };
    },
    confirmDelete: async (p) => {
      const b = watcher.bridgeForTools;
      if (!b) throw new WorkspaceError("CONFIG_INVALID", "bridge not connected yet");
      await confirmDelete(dir, b as never, state, String(p.address));
      return { deleted: true };
    },
    compile: async (p) => {
      const b = watcher.bridgeForTools;
      if (!b) throw new WorkspaceError("CONFIG_INVALID", "bridge not connected yet");
      const msgs = await b.compile(String(p.device ?? config.devices[0] ?? "PLC_1"), (p.addresses as string[] | undefined) ?? []);
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
  io.stdout(`${s.objects} objects, ${s.synced} synced, ${s.readOnly} read-only${s.owner ? `, watching (last pass ${s.owner.scanAgeMs ?? "-"} ms ago${s.owner.lastError ? `, error: ${s.owner.lastError}` : ""})` : ""}\n`);
  for (const [label, list] of [["conflicted", s.conflicted], ["file dirty", s.fileDirty], ["pending delete", s.pendingDelete], ["recovery", s.recoveryRequired]] as const)
    for (const p of list) io.stdout(`  ${label.padEnd(16)} ${p}\n`);
  return s.conflicted.length || s.recoveryRequired.length ? 2 : 0;
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

export async function cmdConfirmDelete(dir: string, address: string, io: Io): Promise<number> {
  const owner = await OwnerClient.connect(dir);
  if (owner) {
    try {
      await owner.request("confirmDelete", { address });
    } finally {
      owner.close();
    }
  } else {
    const config = await loadConfig(dir);
    const client = await bridgeFor(config, io, importFlags(config));
    try {
      const state = await openState(dir, config);
      try {
        await confirmDelete(dir, client, state, address);
      } finally {
        await state.close();
      }
    } finally {
      await client.close();
    }
  }
  io.stdout(`deleted ${address} in TIA Portal\n`);
  return 0;
}
