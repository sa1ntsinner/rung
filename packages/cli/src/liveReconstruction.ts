// SPDX-License-Identifier: BUSL-1.1
import { isDeepStrictEqual } from "node:util";
import type { LiveScope, OnlineNativeCapture } from "@rung/bridge-client";
import type { WorkspaceIndex } from "@rung/lsp";
import { SimError, verifyNativeBody, verifyNativeScalars, reconstructionRevision, reconstructCycle, reconstructionWhy } from "@rung/sim";

/** Replays the producer's own boundary state, never the ordinary values frame. */
export function reconstructNativeSample(index: WorkspaceIndex, uri: string, native: OnlineNativeCapture, expected: LiveScope, instance: string, reads: Record<string, unknown> = {}) {
  if (!native || native.coherence !== "subscription-sample" || native.scope.device !== expected.device || native.scope.address !== expected.address
    || native.scope.transport !== expected.transport || native.scope.epoch !== expected.epoch || native.capture.route.instance !== instance
    || native.capture.samples.length < 3 || native.capture.samples.length > 8 || native.capture.bodies.length > 256)
    throw new SimError("Native capture scope or collection changed");
  verifyNativeBody(index, uri, native.capture.bodies.map(body => body.text).join("\n"));
  verifyNativeScalars(index, uri, native.capture.scalars);
  const sample = native.capture.samples.at(-1)!;
  if (!Number.isSafeInteger(sample.observedAt) || sample.observedAt < 1) throw new SimError("Invalid native measurement time");
  const scope = { plc: expected.device, instance: `"${instance}"`, epoch: expected.epoch };
  // Native scalar gates refuse CPU clocks, external memory, user dependencies and opaque state.
  const replay = reconstructCycle(index, uri, { scope, sourceRevision: reconstructionRevision(index, uri), time: 0, clockStart: 0,
    coherence: "subscription-sample", before: { mem: sample.state.before, globals: {}, reads: reads as never }, observed: sample.state.after }, scope);
  return { ...replay, freshness: "native-sample" as const, coherence: "subscription-sample" as const, observedAt: sample.observedAt,
    sequence: sample.sequence, reason: "Reconstructed native subscription sample; PLC execution unverified",
    why: Object.fromEntries(Object.keys(replay.after).map(name => [name, reconstructionWhy(replay, name)])) };
}

/**
 * The globals a body reads, read right before the native capture and right after it: a value that changed in between
 * may have changed during the sampled cycle, so that sample is not replayed.
 */
export function steadyReads(paths: string[], before: { value?: unknown; error?: string }[], after: { value?: unknown; error?: string }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  paths.forEach((path, i) => {
    const b = before[i], a = after[i];
    if (!b || !a) throw new SimError(`${path}: not read next to the sample`);
    if (b.error || a.error) throw new SimError(`${path}: ${b.error ?? a.error}`);
    if (!isDeepStrictEqual(b.value, a.value)) throw new SimError(`${path} changed while the sample was taken; program status waits for a steadier moment`);
    out[path] = b.value;
  });
  return out;
}