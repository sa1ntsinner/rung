// SPDX-License-Identifier: BUSL-1.1
import type { WatchTableDefinition } from "@rung/bridge-client";
import type { OnlineRpc } from "./s7commplus.js";
export type { WatchTableDefinition, WatchTableRow } from "@rung/bridge-client";

/** Parsing is local and does not establish a PLC session or apply modify values. */
export async function loadWatchTable(rpc: OnlineRpc, xml: string): Promise<WatchTableDefinition> {
  return await rpc.request("online.watchTable", { xml }) as WatchTableDefinition;
}

export function watchTableVariables(table: WatchTableDefinition, absoluteRows: Readonly<Record<string, string>> = {}): { vars: Record<string, string>; errors: Record<string, string> } {
  const vars: Record<string, string> = {}, errors: Record<string, string> = {};
  for (const row of table.rows) {
    const expression = row.name?.trim() || row.address?.trim();
    if (!expression) errors[row.key] = "Empty watch table row";
    else if (absoluteRows[row.key]) vars[row.key] = absoluteRows[row.key]!;
    else if (/^%|^(?:[IQM](?:[BWD]?\d)|DB\d+\.DB)/i.test(expression)) errors[row.key] = `Absolute address requires a verified mapping: ${expression}`;
    else vars[row.key] = expression;
  }
  return { vars, errors };
}
