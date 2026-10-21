// SPDX-License-Identifier: BUSL-1.1
import { agentMarker, agentPermission, assertHuman } from "./guard.js";
import { approveAgentAction, type AgentApproval, type DialogRunner } from "./agentMode.js";
import { commandAction } from "./guard.js";
import type { AgentAction } from "@rung/core";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError, type BridgeClient, type OnlineConnectResult, type OnlinePreparedWrite, type OnlineStateResult, type OnlineWriteResult } from "@rung/bridge-client";
import { MutationPolicy, validateLiveAddress, type MutationAction, type MutationBinding } from "@rung/live";
import { onlineHost } from "./liveTrust.js";
import type { Io } from "./common.js";
import type { BackendOptions, liveSelection } from "./liveServer.js";
import type { Readable } from "node:stream";
import { assertPlcWritable, loadConfig } from "@rung/core";

/** Editor replies must echo the exact prepared operation over this process's private stdin. */
export async function frontendConfirmation(input: Readable, operation: OnlinePreparedWrite): Promise<boolean> {
  const timer = setTimeout(() => input.destroy(new Error("PLC confirmation expired")), Math.max(0, operation.expiresAt - Date.now()));
  let frame = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      frame = Buffer.concat([frame, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
      if (frame.length > 16_384) throw new BridgeError("BAD_REQUEST", "Confirmation frame is too large");
      const end = frame.indexOf(10);
      if (end < 0) continue;
      if (frame.subarray(end + 1).toString().trim()) throw new BridgeError("BAD_REQUEST", "Confirm only one operation");
      let reply: Record<string, unknown>;
      try { reply = JSON.parse(frame.subarray(0, end).toString("utf8")); }
      catch { throw new BridgeError("BAD_REQUEST", "Invalid confirmation frame"); }
      return reply?.operationId === operation.operationId && reply.preview === operation.preview && reply.confirmed === true && Date.now() < operation.expiresAt;
    }
    return false;
  } finally { clearTimeout(timer); }
}

/** Pending hosts hold read connections only. The host creates a writer only after commit. */
export function liveMutations(root: string, env: Io["env"], select: (options: BackendOptions) => ReturnType<typeof liveSelection>, dialog?: DialogRunner) {
  const pending = new Map<string, { clientId: string; policy: MutationPolicy; host: BridgeClient; device: string; action: AgentAction; approval?: AgentApproval; timer: ReturnType<typeof setTimeout> }>();
  const brokerEnv = env;
  let preparing = 0;
  let closed = false;
  const revision = async () => createHash("sha256").update(await readFile(join(root, "rung.toml"))).digest("hex");
  async function discard(id: string) {
    const operation = pending.get(id); if (!operation) return;
    pending.delete(id); clearTimeout(operation.timer); operation.policy.invalidate();
    try { await operation.host.close(); } finally { await operation.approval?.finish(1); }
  }
  return {
    async prepare(clientId: string, options: BackendOptions, action: MutationAction, credentials: { user?: string; password?: string }, clientAgent?: string, command?: string) {
      const env = clientAgent ? { ...brokerEnv, [agentMarker({ [clientAgent]: "1" }) ?? "RUNG_AGENT"]: "1" } : brokerEnv;
      const io: Io = { cwd: root, env, stdout: () => {}, stderr: () => {} };
      const permissionAction = commandAction(["live", action.action], [])!;
      const approval = await approveAgentAction(root, permissionAction, options.device, io, dialog, command ?? `rung live ${action.action}`);
      const prepare = async () => {
      assertHuman(env);
      assertPlcWritable(await loadConfig(root), options.device, env);
      if (closed || pending.size + preparing >= 128) throw new BridgeError("RESOURCE_LIMIT", "Too many pending confirmations or broker is closed");
      const selected = await select(options);
      validateLiveAddress(selected.target.address);
      if (selected.transport !== "s7commplus") throw new BridgeError("UNSUPPORTED_CAPABILITY", "Confirmed mutations require s7commplus");
      if (selected.target.allowWrites !== true) throw new BridgeError("WRITES_DISABLED", "Enable allow_writes for the selected PLC");
      const pin = selected.target.certificateSha256 ?? "";
      if (!/^[a-fA-F0-9]{64}$/.test(pin)) throw new BridgeError("CERTIFICATE_UNTRUSTED", "Verify the PLC certificate first");
      const configRevision = await revision();
      preparing++;
      let host: BridgeClient | undefined;
      try {
      host = await onlineHost(env, { workspace: root, configRevision, device: selected.device, address: selected.target.address, certificateSha256: pin, allowWrites: true });
      const activeHost = host;
        const session = await host.request("online.connect", { device: selected.device, address: selected.target.address, certificateSha256: pin,
          user: credentials.user ?? selected.target.user, password: credentials.password }) as OnlineConnectResult;
        const prepared = await host.request("online.prepare", { sessionId: session.sessionId, ...action }) as OnlinePreparedWrite & { context: { binding: MutationBinding } };
        const original = prepared.context.binding;
        const policy = new MutationPolicy(async () => {
          assertHuman(env);
      assertPlcWritable(await loadConfig(root), selected.device, env);
          const current = await select(options);
          if (JSON.stringify(current) !== JSON.stringify(selected) || await revision() !== configRevision) throw new BridgeError("STALE_PREPARATION", "PLC configuration changed; prepare again");
          const state = await activeHost.request("online.state", { sessionId: session.sessionId }) as OnlineStateResult;
          return { ...original, workspace: root, configRevision, allowWrites: current.target.allowWrites,
            epoch: state.scope.epoch, cpu: state.identity.cpu, serial: state.identity.serial, plcName: state.identity.plcName, firmware: state.identity.firmware };
        }, async () => activeHost.request("online.commit", { sessionId: session.sessionId, operationId: prepared.operationId, preview: prepared.preview, confirmed: true }) as Promise<OnlineWriteResult>);
        const operation = await policy.prepare(action, prepared.preview);
        operation.expiresAt = Math.min(operation.expiresAt, prepared.expiresAt);
        const timer = setTimeout(() => void discard(operation.operationId).catch(() => {}), Math.max(0, operation.expiresAt - Date.now()));
        timer.unref();
        if (closed) { clearTimeout(timer); throw new BridgeError("BRIDGE_EXITED", "Broker closed during preparation"); }
        pending.set(operation.operationId, { clientId, policy, host, device: selected.device, action: permissionAction, approval, timer });
        return { operationId: operation.operationId, preview: operation.preview, expiresAt: operation.expiresAt };
      } catch (error) { await host?.close().catch(() => {}); throw error; }
      finally { preparing--; }
      };
      try { return await (approval ? agentPermission.run(approval.scope, prepare) : prepare()); }
      catch (error) { await approval?.finish(1); throw error; }
    },
    async commit(clientId: string, id: string, preview: string, confirmed: boolean) {
      const operation = pending.get(id);
      if (!operation) assertHuman(env);
      if (!operation || operation.clientId !== clientId) throw new BridgeError("STALE_PREPARATION", "Preparation belongs to another client or expired");
      const commit = async () => {
      let outcome = 1;
      pending.delete(id); clearTimeout(operation.timer);
      try {
      assertPlcWritable(await loadConfig(root), operation.device, env);
      const result = await operation.policy.commit(id, preview, confirmed); outcome = result.outcome === "acknowledged" ? 0 : 2; return result;
      } catch (error) { if ((error as { code?: string }).code === "PLC_READ_ONLY") outcome = 2; throw error; }
      finally { operation.policy.invalidate(); await operation.host.close().catch(() => {}); await operation.approval?.finish(outcome); }
      };
      return operation.approval ? agentPermission.run(operation.approval.scope, commit) : commit();
    },
    async cancel(clientId: string, id: string) { if (pending.get(id)?.clientId === clientId) await discard(id); return {}; },
    async disconnect(clientId: string) { await Promise.allSettled([...pending].filter(([, p]) => p.clientId === clientId).map(([id]) => discard(id))); },
    async close() { closed = true; await Promise.allSettled([...pending.keys()].map(discard)); },
  };
}
