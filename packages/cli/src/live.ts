// SPDX-License-Identifier: BUSL-1.1
// rung live: read-only access to a running S7-1500 through its Web API.
import { WorkspaceError, loadConfig } from "@rung/core";
import { WebApiClient } from "@rung/live";
import { findWorkspace, type Io } from "./common.js";

export async function webApiFor(dir: string, env: Io["env"]): Promise<WebApiClient> {
  const ws = await findWorkspace(dir);
  const config = await loadConfig(ws);
  const w = config.live?.webapi;
  if (!w) throw new WorkspaceError("CONFIG_INVALID", 'no [live.webapi] in rung.toml (url = "https://<plc-ip>", user = "<web server user>")');
  const password = env.RUNG_WEBAPI_PASSWORD;
  if (!password) throw new WorkspaceError("CONFIG_INVALID", "set RUNG_WEBAPI_PASSWORD for the PLC web server user (it is never stored in rung.toml)");
  return new WebApiClient({ url: w.url, user: w.user, password, ...(w.insecure ? { insecure: true } : {}) });
}

export async function cmdLive(dir: string, sub: string | undefined, args: string[], io: Io): Promise<number> {
  if (sub !== "read" && sub !== "diag") {
    io.stderr('rung: usage: rung live read "<DB>".<member> ... | rung live diag\n');
    return 1;
  }
  const client = await webApiFor(dir, io.env);
  try {
    if (sub === "read") {
      if (!args.length) {
        io.stderr("rung: name at least one variable, e.g. rung live read '\"Fx_Global\".Counter'\n");
        return 1;
      }
      const rows = await client.read(args);
      for (const r of rows) io.stdout(r.error ? `${r.name}  ERROR ${r.error}\n` : `${r.name}  ${JSON.stringify(r.value)}\n`);
      return rows.some((r) => r.error) ? 2 : 0;
    }
    io.stdout(JSON.stringify(await client.diagnosticBuffer(), null, 2) + "\n");
    return 0;
  } finally {
    await client.logout().catch(() => undefined);
  }
}
