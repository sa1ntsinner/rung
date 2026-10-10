// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { main } from "../src/main.js";

it.each(["%Q0.0", "%I2.1", "%MW12", "%QX0.0", "%IX0.0"])("explains physical address %s before trying to open TIA", async target => {
  let error = "";
  expect(await main(["xref", target], { cwd: "C:/not-a-rung-workspace", env: { RUNG_BRIDGE: "must-not-start.exe" }, stdout: () => {}, stderr: s => { error += s; } })).toBe(1);
  expect(error).toMatch(/physical PLC address.*tag name/i);
  expect(error).toContain("plc:");
});

it("shows an object address example and distinguishes physical I/O in help", async () => {
  let output = "";
  expect(await main(["xref", "--help"], { cwd: ".", env: {}, stdout: s => { output += s; }, stderr: () => {} })).toBe(0);
  expect(output).toContain("plc:PLC_1/blocks/FB_Motor");
  expect(output).toMatch(/physical.*I\/O/i);
});
