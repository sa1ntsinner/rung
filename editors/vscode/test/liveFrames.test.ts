// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { takeLiveFrame } from "../src/core/liveFrames";

it("retains measurement age across errors and heartbeats and records only new good observations", () => {
  const seen = new Map();
  const first = { at: 10, values: { x: 1 }, observedAt: { x: 8 }, state: "live" as const };
  expect(takeLiveFrame(seen, ["x"], first)).toEqual({ at: 10, values: { x: 1 } });
  expect(takeLiveFrame(seen, ["x"], { ...first, at: 20 })).toBeUndefined();
  expect(seen.get("x").at).toBe(8);
  expect(takeLiveFrame(seen, ["x"], { ...first, at: 30, state: "stale", errors: { x: "offline" } })).toBeUndefined();
  expect(seen.get("x")).toMatchObject({ at: 8, value: 1, error: "offline", state: "stale", history: [1] });
  expect(takeLiveFrame(seen, ["x"], { at: 35, values: {} })).toBeUndefined();
  expect(seen.get("x")).toMatchObject({ at: 8, error: "offline", state: "stale" });
  expect(takeLiveFrame(seen, ["x"], { at: 40, values: { x: 2 }, observedAt: { x: 39 }, state: "live" })).toEqual({ at: 40, values: { x: 2 } });
  expect(seen.get("x")).toMatchObject({ at: 39, value: 2, history: [1, 2], state: "live" });
});
