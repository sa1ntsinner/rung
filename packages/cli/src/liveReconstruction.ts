// SPDX-License-Identifier: BUSL-1.1
import type { LiveScope, OnlineNativeCapture } from "@rung/bridge-client";
import type { WorkspaceIndex } from "@rung/lsp";
import { SimError, verifyNativeBody, verifyNativeScalars, reconstructionRevision, reconstructCycle, reconstructionWhy } from "@rung/sim";

/** Replays the producer's own boundary state, never the ordinary values frame. */
export function reconstructNativeSample(index: WorkspaceIndex, uri: string, native: OnlineNativeCapture, expected: LiveScope, instance: string) {
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
    coherence: "subscription-sample", before: { mem: sample.state.before, globals: {} }, observed: sample.state.after }, scope);
  return { ...replay, freshness: "native-sample" as const, coherence: "subscription-sample" as const, observedAt: sample.observedAt,
    sequence: sample.sequence, reason: "Reconstructed native subscription sample; PLC execution unverified",
    why: Object.fromEntries(Object.keys(replay.after).map(name => [name, reconstructionWhy(replay, name)])) };
}
