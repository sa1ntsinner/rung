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
  // the Web API login sends the password; over plain http anyone on the network can read it
  if (/^http:\/\//i.test(w.url) && env.RUNG_WEBAPI_ALLOW_HTTP !== "1")
    throw new WorkspaceError("CONFIG_INVALID", `${w.url} is plain http: the password would travel unencrypted. Use https:// (set insecure = true for the PLC's self-signed certificate), or set RUNG_WEBAPI_ALLOW_HTTP=1 if you really mean it`);
  return new WebApiClient({ url: w.url, user: w.user, password, ...(w.insecure ? { insecure: true } : {}) });
}

export async function cmdLive(dir: string, sub: string | undefined, args: string[], io: Io): Promise<number> {
  if (sub !== "read" && sub !== "diag") {
    io.stderr('rung: usage: rung live read "<DB>".<member> ... | rung live diag\n');
    return 1;
  }
  const client = await webApiFor(dir, io.env);
  try {
    return await liveRun(client, sub, args, io);
  } catch (e) {
    // network and PLC errors are expected here (wrong address, PLC off, wrong password): one clear line, no stack
    const err = e as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
    const code = err.cause?.code ?? err.code;
    const why =
      code === "ENOTFOUND" ? "the PLC address does not resolve" :
      code === "ECONNREFUSED" ? "the PLC refused the connection (web server off?)" :
      code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || err.name === "TimeoutError" || err.name === "AbortError" ? "the PLC did not answer in time" :
      code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ? "the PLC certificate is not trusted (set insecure = true under [live.webapi] for a self-signed certificate)" :
      err.message;
    io.stderr(`rung live: ${why}${code && !why.includes(String(code)) ? ` (${code})` : ""}\n`);
    return 1;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function liveRun(client: WebApiClient, sub: string, args: string[], io: Io): Promise<number> {
  {
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
  }
}
