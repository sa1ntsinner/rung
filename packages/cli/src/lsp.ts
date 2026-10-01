// SPDX-License-Identifier: BUSL-1.1
import { startServer, type MonitorProvider, type MessageReader, type MessageWriter } from "@rung/lsp";
import type { Io } from "./common.js";
import { liveError, liveReader, readMonitorValues } from "./live.js";
import { isIecMonitor, monitorInstances, monitorPlan, monitorPlanIec } from "./monitor.js";

export function lspMonitor(io: Io, open = liveReader): MonitorProvider {
  return {
    plan: (index, uri, instance) => (isIecMonitor(uri) ? monitorPlanIec : monitorPlan)(index, uri, instance),
    instances: monitorInstances,
    open: async (uri, plan) => {
      const reader = await open(uri, io);
      return { read: () => readMonitorValues(reader.read, plan), close: () => reader.close() };
    },
    error: liveError,
  };
}

export function startLsp(io: Io, reader?: MessageReader, writer?: MessageWriter) {
  return startServer(reader, writer, { monitor: lspMonitor(io) });
}
