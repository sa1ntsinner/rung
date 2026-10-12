// SPDX-License-Identifier: BUSL-1.1
import type { RungConfig } from "./config.js";
import { WorkspaceError } from "./errors.js";

export function plcReadOnly(config?: RungConfig, device?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.env.RUNG_READ_ONLY === "1" || env.RUNG_READ_ONLY === "1") return "RUNG_READ_ONLY=1";
  const devices = device ? [device] : [...new Set([...Object.keys(config?.plc ?? {}), ...Object.keys(config?.live?.plc ?? {})])];
  for (const name of devices) {
    if (config?.plc[name]?.readOnly) return `[plc.${name}] read_only = true`;
    if (config?.live?.plc?.[name]?.readOnly) return `[live.plc.${name}] read_only = true`;
  }
  return undefined;
}

export function assertPlcWritable(config?: RungConfig, device?: string, env: NodeJS.ProcessEnv = process.env): void {
  const lock = plcReadOnly(config, device, env);
  if (lock) throw new WorkspaceError("PLC_READ_ONLY", `PLC changes refused by the read-only lock (${lock})`);
}
