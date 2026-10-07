// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { resolve } from "node:path";
import { plcPasswordKey } from "../src/core/connect";

it("keeps relative local project credentials separate between workspaces", () => {
  const a = resolve("machines/A");
  const b = resolve("machines/B");
  expect(plcPasswordKey(a, "Line/Line.ap20", undefined, "PLC_1")).not.toBe(plcPasswordKey(b, "Line/Line.ap20", undefined, "PLC_1"));
  expect(plcPasswordKey(a, "Line/Line.ap20", undefined, "PLC_1")).toBe(plcPasswordKey(a, resolve(a, "Line/Line.ap20"), undefined, "PLC_1"));
});

it("preserves remote Windows project paths without resolving them locally", () => {
  expect(plcPasswordKey("/local/mirror", "C:\\Machines\\Line.ap20", "tia-host", "PLC_1")).toBe("rung.plc.password:C:\\Machines\\Line.ap20|tia-host|PLC_1");
});
