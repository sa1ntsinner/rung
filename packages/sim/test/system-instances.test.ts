// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { WorkspaceIndex } from "@rung/lsp";
import { Simulator } from "../src/runtime.js";
import { readFileSync } from "node:fs";

const metadata = `address: "plc:P/blocks/System blocks/Edge"
kind: block
blockType: InstanceDB
isSystem: true
instanceOf: R_TRIG
readOnly: true
`;

it("uses the public type of a protected system instance for the IEC model", () => {
  const index = new WorkspaceIndex();
  index.set("file:///w/plc/P/blocks/Edge.protected.yaml", metadata, 0);
  expect(index.global("Edge")?.block?.dbOf).toBe("R_TRIG");
  index.set("file:///w/plc/P/blocks/Test.scl", `FUNCTION "Test" : Bool
BEGIN
  "Edge"(CLK := TRUE);
  #Test := "Edge".Q;
END_FUNCTION`, 0);
  const sim = new Simulator(index);
  expect(sim.callBlock("Test").returnValue).toBe(true);
  expect(sim.callBlock("Test").returnValue).toBe(false);
});

it("runs exported bare IEC_TIMER instance data through its TON method", () => {
  const index = new WorkspaceIndex();
  index.set("file:///w/plc/P/blocks/Delay.db", 'DATA_BLOCK "Delay"\nNON_RETAIN\nIEC_TIMER\nBEGIN\nEND_DATA_BLOCK', 0);
  expect(index.global("Delay")?.block?.dbOf).toBe("IEC_TIMER");
  index.set("file:///w/plc/P/blocks/Test.scl", 'FUNCTION "Test" : Bool\nBEGIN\n"Delay".TON(IN := TRUE, PT := T#0ms);\n#Test := "Delay".Q;\nEND_FUNCTION', 0);
  expect(new Simulator(index).callBlock("Test").returnValue).toBe(true);
});

it("keeps the LAD timer instruction when calling IEC_TIMER data", () => {
  const index = new WorkspaceIndex();
  const source = readFileSync(new URL("../../../tools/fixtures/xml/sim/Fx_LadBoxes.xml", import.meta.url), "utf8");
  index.set("file:///w/plc/P/blocks/Fx_LadBoxes.xml", source.replace(/TON_TIME/g, "IEC_TIMER"), 0);
  index.set("file:///w/plc/P/blocks/Fx_LadHelper.scl", readFileSync(new URL("../../../tools/fixtures/xml/sim/Fx_LadHelper.scl", import.meta.url), "utf8"), 0);
  const sim = new Simulator(index);
  expect(() => sim.callBlock(sim.newInstance("Fx_LadBoxes"), { go: true })).not.toThrow();
});

it.each([
  metadata.replace("isSystem: true", "isSystem: false"),
  metadata.replace("readOnly: true", "readOnly: false"),
  metadata.replace("R_TRIG", "SecretUserFB"),
  metadata.replace("R_TRIG", "ABS"),
  metadata + "instanceOf: TON\n",
])("keeps unsupported or ambiguous protected metadata opaque", (text) => {
  const index = new WorkspaceIndex();
  index.set("file:///w/plc/P/blocks/Edge.protected.yaml", text, 0);
  expect(index.global("Edge")?.kind).toBe("OBJECT");
});
