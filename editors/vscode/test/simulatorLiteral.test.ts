// SPDX-License-Identifier: MIT
import { expect, it, vi } from "vitest";
vi.mock("vscode", () => ({}));
import { simulatorLiteral } from "../src/liveMutation";

it("turns what a person types into the value the simulator takes", () => {
  expect(simulatorLiteral("TRUE")).toBe(true);
  expect(simulatorLiteral(" false ")).toBe(false);
  expect(simulatorLiteral("37")).toBe(37);
  expect(simulatorLiteral("-1.5e2")).toBe(-150);
  expect(simulatorLiteral("T#2s")).toBe("T#2s");
});
