// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { driveUpper } from "../src/paths.js";

it("starts the bridge as C:\\... even when VS Code hands rung c:\\... (TIA Portal's whitelist compares by case)", () => {
  expect(driveUpper("c:\\Users\\x\\rung-bridge-v20.exe")).toBe("C:\\Users\\x\\rung-bridge-v20.exe");
  expect(driveUpper("D:\\x.exe")).toBe("D:\\x.exe");
  expect(driveUpper("\\\\server\\share\\x.exe")).toBe("\\\\server\\share\\x.exe");
  expect(driveUpper("rung-bridge-v20.exe")).toBe("rung-bridge-v20.exe");
});
