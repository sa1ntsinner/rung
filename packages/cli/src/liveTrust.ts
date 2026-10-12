// SPDX-License-Identifier: BUSL-1.1
import { createInterface } from "node:readline/promises";
import { assertPlcWritable, plcReadOnly, loadConfig, saveConfig, WorkspaceError } from "@rung/core";
import { BridgeClient, type OnlineWriterConfiguration } from "@rung/bridge-client";
import { selectLiveTarget } from "@rung/live";
import { findWorkspace, type Io } from "./common.js";
import { onlineExecutable } from "./paths.js";

interface Certificate { address: string; certificateSha256: string; details: string }

/** Release packaging will supply the bundled path; a separately installed host can be selected now. */
export async function onlineHost(env: Io["env"], policy?: OnlineWriterConfiguration): Promise<BridgeClient> {
  if (policy) assertPlcWritable(undefined, undefined, env);
  const host = onlineExecutable(env);
  const args = ["--stdio", ...(policy ? ["--writer-policy-stdin"] : [])];
  return BridgeClient.spawn({ command: host.endsWith(".dll") ? "dotnet" : host, args: host.endsWith(".dll") ? [host, ...args] : args, ...(plcReadOnly(undefined, undefined, env) ? { env: { RUNG_READ_ONLY: "1" } } : {}), ...(policy ? { bootstrap: { ...policy } } : {}) });
}

async function inspectCertificate(address: string, env: Io["env"]): Promise<Certificate> {
  const host = await onlineHost(env);
  try { return await host.request("online.certificate", { address }) as Certificate; }
  finally { await host.close(); }
}

export async function trustLiveCertificate(dir: string, io: Io, device?: string,
  inspect: (address: string, env: Io["env"]) => Promise<Certificate> = inspectCertificate): Promise<number> {
  if (!io.prompt && !process.stdin.isTTY) throw new WorkspaceError("BAD_ARGUMENT", "Certificate trust requires an interactive terminal");
  const ws = await findWorkspace(dir);
  const config = await loadConfig(ws, { raw: true });
  const selected = selectLiveTarget(config, { ...(device ? { device } : {}) }, io.env);
  if (selected.target.transport !== "s7commplus") throw new WorkspaceError("CONFIG_INVALID", "Certificate pinning requires a s7commplus target");
  const certificate = await inspect(selected.target.address, selected.target.readOnly ? { ...io.env, RUNG_READ_ONLY: "1" } : io.env);
  if (certificate.address !== selected.target.address || !/^[a-fA-F0-9]{64}$/.test(certificate.certificateSha256)) throw new WorkspaceError("CONFIG_INVALID", "Host returned an invalid certificate binding");
  io.stdout(`PLC ${selected.device} at ${selected.target.address}\n${certificate.details}\n`);
  const question = `Compare this certificate with the TIA Portal project. To pin it for ${selected.device} at ${selected.target.address}, type ${selected.device}: `;
  const rl = io.prompt ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try { answer = await (io.prompt ? io.prompt(question) : rl!.question(question)); }
  finally { rl?.close(); }
  if (answer !== selected.device) { io.stderr("Certificate trust cancelled\n"); return 1; }
  const current = await loadConfig(ws, { raw: true });
  const target = selectLiveTarget(current, { device: selected.device }, io.env).target;
  if (JSON.stringify(target) !== JSON.stringify(selected.target)) throw new WorkspaceError("CONFIG_INVALID", "PLC configuration changed during confirmation; inspect the certificate again");
  current.live!.plc![selected.device]!.certificateSha256 = certificate.certificateSha256.toUpperCase();
  await saveConfig(ws, current);
  io.stdout(`Certificate pinned for ${selected.device} in rung.toml\n`);
  return 0;
}
