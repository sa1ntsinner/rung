// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex } from "@rung/lsp";
import { explainStatic, type WhyNode } from "../src/index.js";

const MOTOR = readFileSync(fileURLToPath(new URL("../../../tools/fixtures/scl/Fx_Motor.scl", import.meta.url)), "utf8");
const show = (n: WhyNode, pad = ""): string[] => [`${pad}${n.kind}: ${n.text}${n.value !== undefined ? ` = ${n.value}` : ""}${n.at ? ` @${n.at.line}` : ""}`, ...n.children.flatMap((c) => show(c, pad + "  "))];

describe("Why? from the values a PLC has now", () => {
  const idx = new WorkspaceIndex();
  idx.set("file:///w/plc/P/blocks/Fx_Motor.scl", MOTOR, 0);
  const now: Record<string, unknown> = { "#START": false, "#STOP": true, "#LATCH": false, "#RUNNING": false, "#SPEEDSETPOINT": 1500, "#SPEEDOUT": 0 };
  const value = (label: string) => now[label.toUpperCase()];

  it("follows a value to its writer and that writer's operands", () => {
    expect(show(explainStatic(idx, "file:///w/plc/P/blocks/Fx_Motor.scl", "Running", value, 2))).toEqual([
      "value: #Running = FALSE",
      "  write: #Running := #Latch; @23",
      "    value: #Latch = FALSE",
      "      write: #Latch := (#Start OR #Latch) AND NOT #Stop; @22",
      "        value: #Start = FALSE",
      "        value: #Latch = FALSE",
      "        value: #Stop = TRUE",
    ]);
  });

  it("lists every writer with the branch it stands in, worked out from the values now", () => {
    expect(show(explainStatic(idx, "file:///w/plc/P/blocks/Fx_Motor.scl", "#SpeedOut", value, 1))).toEqual([
      "value: #SpeedOut = 0",
      "  note: 2 statements write it; of those that run in a cycle, the last one decides",
      "  write: #SpeedOut := LIMIT(MN := 0.0, IN := #SpeedSetpoint, MX := 3000.0); @25",
      "    value: #SpeedSetpoint = 1500",
      "    condition: IF #Running THEN = FALSE now @24",
      "      value: #Running = FALSE",
      "  write: #SpeedOut := 0.0; @27",
      "    condition: IF #Running THEN = ELSE: every condition is FALSE now @24",
    ]);
  });

  it("an input stands alone; a value the block does not write says so", () => {
    expect(show(explainStatic(idx, "file:///w/plc/P/blocks/Fx_Motor.scl", "#Start", value))).toEqual(["value: #Start = FALSE"]);
    expect(show(explainStatic(idx, "file:///w/plc/P/blocks/Fx_Motor.scl", '"Plant".Ready', value))[1]).toMatch(/note: not written in Fx_Motor/);
  });
});
