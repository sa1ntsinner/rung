// SPDX-License-Identifier: BUSL-1.1
import { expect, it, vi } from "vitest";
import { MutationPolicy, type MutationBinding } from "../src/policy.js";
import { BridgeError } from "@rung/bridge-client";

const binding: MutationBinding = { workspace: "fixture", device: "P", address: "192.168.250.1", certificateSha256: "A".repeat(64),
  cpu: "CPU", serial: "serial", plcName: "RungProve", epoch: 1, programRevision: "program", configRevision: "config", allowWrites: true };

it.each([false, undefined])("refuses absent/false opt-in before mutation", async allowWrites => {
  const send = vi.fn(); const policy = new MutationPolicy(async () => ({ ...binding, allowWrites }), send);
  await expect(policy.prepare({ action: "run" })).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  expect(send).not.toHaveBeenCalled();
});
it("refuses the protected address before preparing", async () => {
  const policy = new MutationPolicy(async () => ({ ...binding, address: "192.168.1.1" }), vi.fn());
  await expect(policy.prepare({ action: "run" })).rejects.toMatchObject({ code: "TARGET_REFUSED" });
});
it.each(["device", "address", "certificateSha256", "serial", "plcName", "epoch", "programRevision", "configRevision", "workspace"] as const)("invalidates a changed %s binding before sending", async key => {
  let current = { ...binding }; const send = vi.fn(); const policy = new MutationPolicy(async () => current, send);
  const prepared = await policy.prepare({ action: "modify", name: '"DB".x', literal: "17" });
  current = { ...current, [key]: key === "epoch" ? 2 : "changed" };
  await expect(policy.commit(prepared.operationId, prepared.preview, true)).rejects.toMatchObject({ code: "STALE_PREPARATION" });
  expect(send).not.toHaveBeenCalled();
});
it("requires exact confirmation, expires at 30 seconds and never reuses a preparation", async () => {
  let now = 0; const send = vi.fn(); const policy = new MutationPolicy(async () => binding, send, () => now);
  let op = await policy.prepare({ action: "stop" });
  await expect(policy.commit(op.operationId, op.preview, false)).rejects.toMatchObject({ code: "WRITES_DISABLED" });
  await expect(policy.commit(op.operationId, op.preview, true)).rejects.toMatchObject({ code: "STALE_PREPARATION" });
  op = await policy.prepare({ action: "stop" }); now = 30_000;
  await expect(policy.commit(op.operationId, op.preview, true)).rejects.toMatchObject({ code: "STALE_PREPARATION" });
  op = await policy.prepare({ action: "run" });
  await expect(policy.commit(op.operationId, "another preview", true)).rejects.toMatchObject({ code: "STALE_PREPARATION" });
  expect(send).not.toHaveBeenCalled();
});
it("sends once, reports an uncertain timeout and records no credentials", async () => {
  const send = vi.fn(async () => { throw new Error("timeout after sending"); });
  const policy = new MutationPolicy(async () => binding, send);
  const op = await policy.prepare({ action: "run" });
  expect(op.preview).toContain("RungProve"); expect(op.preview).toContain("192.168.250.1");
  expect(await policy.commit(op.operationId, op.preview, true)).toMatchObject({ outcome: "unknown", target: { device: "P", address: "192.168.250.1" } });
  await expect(policy.commit(op.operationId, op.preview, true)).rejects.toMatchObject({ code: "STALE_PREPARATION" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("preserves the host's pre-send stale-program refusal and consumes the confirmation", async () => {
  const send = vi.fn(async () => { throw new BridgeError("STALE_PREPARATION", "PLC program structure changed"); });
  const policy = new MutationPolicy(async () => binding, send);
  const op = await policy.prepare({ action: "run" });
  expect(await policy.commit(op.operationId, op.preview, true)).toMatchObject({ outcome: "rejected", errorCode: "STALE_PREPARATION" });
  await expect(policy.commit(op.operationId, op.preview, true)).rejects.toMatchObject({ code: "STALE_PREPARATION" });
  expect(send).toHaveBeenCalledTimes(1);
});
