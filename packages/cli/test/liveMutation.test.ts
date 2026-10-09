// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { Readable } from "node:stream";
import { frontendConfirmation } from "../src/liveMutation.js";

it("accepts only an exact unexpired frontend reply and bounds the private frame", async () => {
  const operation = { operationId: "one", preview: "PLC · INT := 17", expiresAt: Date.now() + 30_000 };
  const reply = { ...operation, confirmed: true };
  expect(await frontendConfirmation(Readable.from([JSON.stringify(reply) + "\n"]), operation)).toBe(true);
  for (const altered of [{ ...reply, confirmed: false }, { ...reply, operationId: "other" }, { ...reply, preview: "changed" }])
    expect(await frontendConfirmation(Readable.from([JSON.stringify(altered) + "\n"]), operation)).toBe(false);
  expect(await frontendConfirmation(Readable.from([]), operation)).toBe(false);
  await expect(frontendConfirmation(Readable.from(["x".repeat(16_385)]), operation)).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
