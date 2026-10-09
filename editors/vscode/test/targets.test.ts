// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { deviceChoices } from "../src/core/targets";

it("offers the remembered PLC first without dropping the other choices", () => {
  const devices = ["PLC_1", "PLC_2", "PLC_3"];
  expect(deviceChoices(devices, "PLC_2")).toEqual(["PLC_2", "PLC_1", "PLC_3"]);
  expect(devices).toEqual(["PLC_1", "PLC_2", "PLC_3"]);
  expect(deviceChoices(devices, "gone")).toEqual(devices);
  expect(deviceChoices(devices)).toEqual(devices);
});
