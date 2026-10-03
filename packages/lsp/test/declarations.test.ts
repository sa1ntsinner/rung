// SPDX-License-Identifier: BUSL-1.1
// The declaration model the table shows: sections, nested rows, attribute states and exact ranges.
import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
import { declarationModel, type DeclModel } from "../src/declarations.js";
import { monitorServer } from "./monitorHarness.js";

const FB = [
  'FUNCTION_BLOCK "Fx_Motor"',
  "VERSION : 0.1",
  "   VAR_INPUT",
  "      Start : Bool;   // push button",
  "   END_VAR",
  "   VAR",
  "      Settings { ExternalWritable := 'False'} : Struct",
  "         Speed { S7_SetPoint := 'True'; Foo := 'x'} : Real := 1500.0;",
  "      END_STRUCT;",
  "      Delay {InstructionName := 'TON_TIME'; LibVersion := '1.0'} : TON_TIME;",
  "   END_VAR",
  "BEGIN",
  "END_FUNCTION_BLOCK",
  "",
].join("\n");
const model = (src: string) => declarationModel("file:///w/plc/PLC_1/blocks/Fx_Motor.scl", 3, src, parse(src));

describe("declarationModel", () => {
  it("groups rows into TIA's sections with nested structs", () => {
    const m = model(FB);
    expect(m.block).toMatchObject({ name: "Fx_Motor", kind: "FB" });
    expect(m.sections.map((s) => [s.title, s.rows.map((r) => r.name)])).toEqual([
      ["Input", ["Start"]],
      ["Static", ["Settings", "Delay"]],
    ]);
    const settings = m.sections[1]!.rows[0]!;
    expect(settings.kind).toBe("struct");
    expect(settings.children!.map((r) => [r.id, r.depth, r.start])).toEqual([["Settings/Speed", 1, "1500.0"]]);
    expect(m.sections[1]!.rows[1]!.kind).toBe("instance");
    expect(m.editable).toBe(true);
  });

  it("attribute states tell an explicit value from TIA's default, unknown attributes go to other", () => {
    const m = model(FB);
    const settings = m.sections[1]!.rows[0]!;
    expect(settings.attrs).toEqual({
      accessible: { value: true, explicit: false },
      visible: { value: true, explicit: false },
      writable: { value: false, explicit: true },
      setpoint: { value: false, explicit: false },
    });
    const speed = settings.children![0]!;
    expect(speed.attrs.setpoint).toEqual({ value: true, explicit: true });
    expect(speed.other).toEqual([{ key: "Foo", value: "x" }]);
    expect(m.sections[1]!.rows[1]!.other.map((o) => o.key)).toEqual(["InstructionName", "LibVersion"]);
  });

  it("ranges point at the exact text", () => {
    const m = model(FB);
    const start = m.sections[0]!.rows[0]!;
    expect(FB.slice(start.ranges.comment!.start, start.ranges.comment!.end)).toBe("// push button");
    expect(start.comment).toBe("push button");
  });

  it("model of a broken struct keeps earlier rows and reports an unavailable range", () => {
    const broken = FB.replace("      END_STRUCT;\n", "");
    const m = model(broken);
    expect(m.sections.find((s) => s.title === "Input")!.rows.map((r) => r.name)).toEqual(["Start"]);
    expect(m.unavailable.length).toBeGreaterThan(0);
  });

  it("a file without a block says so instead of failing", () => {
    expect(model("")).toMatchObject({ sections: [], editable: false });
  });

  it("the language server answers rung/declarations for the open buffer, with its version", async () => {
    const s = await monitorServer();
    try {
      const m = await s.client.sendRequest<DeclModel>("rung/declarations", { textDocument: { uri: s.uri } });
      expect(m).toMatchObject({ version: 1, block: { name: "Motor" } });
      expect(m.sections[0]!.rows.map((r) => r.name)).toEqual(["count", "flag"]);
    } finally {
      await s.dispose();
    }
  });
});
