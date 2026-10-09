// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError, type BridgeClient, type OnlineConnectResult, type OnlinePreparedWrite, type OnlineStateResult, type OnlineWriteResult } from "@rung/bridge-client";
import { MutationPolicy, validateLiveAddress, type MutationAction, type MutationBinding } from "@rung/live";
import { onlineHost } from "./liveTrust.js";
import type { Io } from "./common.js";
import type { BackendOptions, liveSelection } from "./liveServer.js";
import type { Readable } from "node:stream";

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
export function liveMutations(root: string, env: Io["env"], select: (options: BackendOptions) => ReturnType<typeof liveSelection>) {
  const pending = new Map<string, { clientId: string; policy: MutationPolicy; host: BridgeClient; timer: ReturnType<typeof setTimeout> }>();
  let preparing = 0;
  let closed = false;
  const revision = async () => createHash("sha256").update(await readFile(join(root, "rung.toml"))).digest("hex");
  async function discard(id: string) {
    const operation = pending.get(id); if (!operation) return;
    pending.delete(id); clearTimeout(operation.timer); operation.policy.invalidate(); await operation.host.close();
  }
  return {
    async prepare(clientId: string, options: BackendOptions, action: MutationAction, credentials: { user?: string; password?: string }) {
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
        pending.set(operation.operationId, { clientId, policy, host, timer });
        return { operationId: operation.operationId, preview: operation.preview, expiresAt: operation.expiresAt };
      } catch (error) { await host?.close().catch(() => {}); throw error; }
      finally { preparing--; }
    },
    async commit(clientId: string, id: string, preview: string, confirmed: boolean) {
      const operation = pending.get(id);
      if (!operation || operation.clientId !== clientId) throw new BridgeError("STALE_PREPARATION", "Preparation belongs to another client or expired");
      pending.delete(id); clearTimeout(operation.timer);
      try { return await operation.policy.commit(id, preview, confirmed); }
      finally { operation.policy.invalidate(); await operation.host.close().catch(() => {}); }
    },
    async cancel(clientId: string, id: string) { if (pending.get(id)?.clientId === clientId) await discard(id); return {}; },
    async disconnect(clientId: string) { await Promise.allSettled([...pending].filter(([, p]) => p.clientId === clientId).map(([id]) => discard(id))); },
    async close() { closed = true; await Promise.allSettled([...pending.keys()].map(discard)); },
  };
}
