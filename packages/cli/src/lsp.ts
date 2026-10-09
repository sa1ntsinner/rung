// SPDX-License-Identifier: BUSL-1.1
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer, type MonitorProvider, type MessageReader, type MessageWriter, type Renamer } from "@rung/lsp";
import { findWorkspace, type Io } from "./common.js";
import { liveError, liveReader, readMonitorValues } from "./live.js";
import { isIecMonitor, monitorInstances, monitorPlan, monitorPlanIec } from "./monitor.js";
import { addressOf, renameInTia } from "./twoway.js";

export function lspMonitor(io: Io, open = liveReader): MonitorProvider {
  return {
    plan: (index, uri, instance) => (isIecMonitor(uri) ? monitorPlanIec : monitorPlan)(index, uri, instance),
    instances: monitorInstances,
    open: async (uri, plan) => {
      const reader = await open(uri, io);
      if (reader.subscribe) {
        let lease: Promise<{ close(): Promise<void> }> | undefined;
        let stopped = false;
        return {
          read: () => readMonitorValues(reader.read, plan),
          subscribe: (cb) => {
            lease = reader.subscribe!(plan.vars, 250, (frame) => {
              if (!stopped) cb({ values: frame.values,
                errors: frame.state === "stale" || frame.state === "disconnected" ? { ...Object.fromEntries(Object.keys(plan.vars).map(name => [name, `PLC ${frame.state}`])), ...frame.errors } : frame.errors,
                ...(frame.display ? { display: frame.display } : {}) });
            });
            void lease.catch(() => { if (!stopped) cb({ values: {}, errors: Object.fromEntries(Object.keys(plan.vars).map((name) => [name, "subscription failed"])) }); });
            return () => { stopped = true; };
          },
          close: async () => { stopped = true; try { await (await lease)?.close(); } finally { await reader.close(); } },
        };
      }
      return { read: () => readMonitorValues(reader.read, plan), close: () => reader.close() };
    },
    error: liveError,
  };
}

/** F2 on a block's name: rung rename, through rung watch when it runs (stdout is the language server's). */
export function lspRenamer(io: Io, rename = renameInTia): Renamer {
  return {
    rename: async (fileUri, newName) => {
      const file = fileURLToPath(fileUri);
      const ws = await findWorkspace(dirname(file));
      const r = await rename(ws, await addressOf(ws, file, ws), newName, io);
      return { ...(r.newPath ? { newUri: pathToFileURL(join(ws, r.newPath)).href } : {}), users: r.users.length };
    },
  };
}

export function startLsp(io: Io, reader?: MessageReader, writer?: MessageWriter) {
  return startServer(reader, writer, { monitor: lspMonitor(io), renamer: lspRenamer(io) });
}
