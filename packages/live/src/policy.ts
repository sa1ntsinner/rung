// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { BridgeError, type OnlineWriteResult } from "@rung/bridge-client";
import { validateLiveAddress } from "./s7commplus.js";

export interface MutationBinding {
  workspace: string; device: string; address: string; certificateSha256: string;
  cpu: string; serial: string; plcName: string; epoch: number; programRevision: string; configRevision: string;
  firmware?: string;
  allowWrites?: boolean;
}
export interface MutationAction { action: "modify" | "run" | "stop"; name?: string; literal?: string }
export interface PreparedMutation extends MutationAction { operationId: string; preview: string; expiresAt: number; binding: MutationBinding }
export interface MutationEvidence {
  operationId: string; target: { device: string; address: string; cpu: string; serial: string; plcName: string };
  action: MutationAction; startedAt: number; finishedAt: number; outcome: "acknowledged" | "rejected" | "unknown";
  errorCode?: string | null; observation?: OnlineWriteResult["observation"];
}
function bindingOf(b: MutationBinding): MutationBinding {
  return { workspace: b.workspace, device: b.device, address: b.address, certificateSha256: b.certificateSha256,
    cpu: b.cpu, serial: b.serial, plcName: b.plcName, firmware: b.firmware, epoch: b.epoch, programRevision: b.programRevision, configRevision: b.configRevision, allowWrites: b.allowWrites };
}
function check(binding: MutationBinding) {
  validateLiveAddress(binding.address);
  if (binding.allowWrites !== true) throw new BridgeError("WRITES_DISABLED", "Enable allow_writes for this PLC before preparing a mutation");
  if (!/^[a-fA-F0-9]{64}$/.test(binding.certificateSha256)) throw new BridgeError("CERTIFICATE_UNTRUSTED", "Verify the PLC certificate before modifying it");
  if (!Number.isSafeInteger(binding.epoch) || binding.epoch < 1 || [binding.workspace, binding.device, binding.cpu, binding.serial, binding.plcName, binding.programRevision, binding.configRevision].some(s => typeof s !== "string" || !s || s.length > 4096))
    throw new BridgeError("STALE_PREPARATION", "Incomplete PLC identity or revision binding");
}

/** The trusted broker supplies current binding and the guarded host operation, never caller-supplied policy. */
export class MutationPolicy {
  private readonly operations = new Map<string, PreparedMutation>();
  constructor(private readonly current: () => Promise<MutationBinding>,
    private readonly send: (operation: PreparedMutation) => Promise<OnlineWriteResult>,
    private readonly now = Date.now) {}

  async prepare(request: MutationAction, preview?: string): Promise<PreparedMutation> {
    const binding = bindingOf(await this.current()); check(binding);
    if (!["modify", "run", "stop"].includes(request.action) || request.action === "modify" && (!request.name?.trim() || !request.literal?.trim() || request.name.length > 1024 || request.literal.length > 4096) || request.action !== "modify" && (request.name !== undefined || request.literal !== undefined))
      throw new BridgeError("BAD_REQUEST", "Prepare one scalar modification or CPU action");
    for (const [id, operation] of this.operations) if (operation.expiresAt <= this.now()) this.operations.delete(id);
    if (this.operations.size >= 128) throw new BridgeError("RESOURCE_LIMIT", "Too many pending confirmations");
    const action = { action: request.action, ...(request.name !== undefined ? { name: request.name } : {}), ...(request.literal !== undefined ? { literal: request.literal } : {}) };
    const operation: PreparedMutation = { ...action, operationId: randomUUID(), expiresAt: this.now() + 30_000, binding,
      preview: preview ?? `${binding.device} · ${binding.plcName} · ${binding.address}\n${binding.cpu} · ${binding.serial}\n${request.action}${request.name ? ` ${request.name} := ${request.literal}` : ""}` };
    this.operations.set(operation.operationId, structuredClone(operation));
    return operation;
  }

  async commit(id: string, preview: string, confirmed: boolean): Promise<MutationEvidence> {
    const operation = this.operations.get(id); this.operations.delete(id);
    if (!operation || preview !== operation.preview) throw new BridgeError("STALE_PREPARATION", "Preparation was changed, cancelled or already consumed");
    if (confirmed !== true) throw new BridgeError("WRITES_DISABLED", "Explicit confirmation is required");
    const current = bindingOf(await this.current());
    if (operation.expiresAt <= this.now() || JSON.stringify(current) !== JSON.stringify(operation.binding)) throw new BridgeError("STALE_PREPARATION", "PLC, configuration, program or session changed; prepare again");
    check(current);
    const startedAt = this.now();
    let result: OnlineWriteResult;
    try { result = await this.send(operation); }
    catch (error) {
      // The host emits this refusal before sending; transport failures remain uncertain.
      result = error instanceof BridgeError && error.code === "STALE_PREPARATION"
        ? { outcome: "rejected", errorCode: error.code }
        : { outcome: "unknown", errorCode: "OUTCOME_UNKNOWN" };
    } // A possibly sent mutation is never replayed.
    return { operationId: operation.operationId,
      target: { device: current.device, address: current.address, cpu: current.cpu, serial: current.serial, plcName: current.plcName },
      action: { action: operation.action, ...(operation.name !== undefined ? { name: operation.name } : {}), ...(operation.literal !== undefined ? { literal: operation.literal } : {}) },
      startedAt, finishedAt: this.now(), outcome: result.outcome,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}), ...(result.observation ? { observation: result.observation } : {}) };
  }
  invalidate(): void { this.operations.clear(); }
}
