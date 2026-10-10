// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSd, translateLad } from "../src/simaticsd.js";

// FB_Pump.s7dcl is the canonical form TIA Portal V20 wrote back after importing a hand-written LAD block.
const pump = readFileSync(fileURLToPath(new URL("./sd/FB_Pump.s7dcl", import.meta.url)), "utf8");

describe("LAD in SIMATIC SD text", () => {
  it("indexes the interface of a .s7dcl block", () => {
    const [b] = parseSd(pump).blocks;
    expect(b).toMatchObject({ kind: "FB", name: "FB_Pump" });
    expect(b!.vars.map((v) => `${v.section}:${v.name}:${v.type}`)).toEqual([
      "Input:Start:Bool",
      "Input:Stop:Bool",
      "Input:Fault:Bool",
      "Input:Pressure:Real",
      "Output:Run:Bool",
      "Output:Ready:Bool",
      "Output:HighPressure:Bool",
      "Output:Alarm:Bool",
      "Static:StartDelay:TON_TIME",
    ]);
    expect(parseSd(pump).diagnostics).toEqual([]);
  });

  it("records operands of the networks as references, coils as writes and boxes as calls", () => {
    const refs = parseSd(pump).blocks[0]!.refs;
    const at = (name: string) => refs.filter((r) => r.name === name).map((r) => r.access);
    expect(at("Run")).toEqual(["write", "read", "read"]);
    expect(at("StartDelay")).toEqual(["call"]);
    expect(at("Alarm")).toEqual(["write", "write"]);
    const start = refs.find((r) => r.name === "Start")!;
    expect(pump.slice(start.start, start.end)).toBe("Start");
  });

  it("does not take wire names or the language pragma for operands", () => {
    const names = parseSd(pump).blocks[0]!.refs.map((r) => r.name);
    expect(names).not.toContain("powerrail");
    expect(names.filter((n) => /^w\d+$/.test(n))).toEqual([]);
    expect(names).not.toContain("LAD");
  });

  it("translates rungs, branches, timers, comparisons and set/reset coils to SCL", () => {
    const body = pump.slice(pump.indexOf("    {\n      S7_Language"), pump.lastIndexOf("END_FUNCTION_BLOCK"));
    expect(translateLad(body)).toEqual({
      unsupported: [],
      temps: [],
      scl: [
        "// network 1",
        "#Run := (#Start OR #Run) AND (NOT #Stop) AND (NOT #Fault);",
        "// network 2",
        "#StartDelay.TON(IN := #Run, PT := T#3S);",
        "#Ready := #StartDelay.Q;",
        "// network 3",
        "#HighPressure := #Pressure > 6.5;",
        "// network 4",
        "IF #Fault THEN #Alarm := TRUE; END_IF;",
        "IF #Start AND (NOT #Fault) THEN #Alarm := FALSE; END_IF;",
        "",
      ].join("\n"),
    });
  });

  it("negates a whole AND chain, moves only when powered, and lists what it cannot run", () => {
    const net = (rung: string) => `NETWORK\n RUNG wire#powerrail\n${rung}\n END_RUNG\nEND_NETWORK\n`;
    expect(translateLad(net("Contact( #a )\nContact( #b )\nNot()\nCoil( #q )")).scl).toContain("#q := NOT (#a AND #b);");
    expect(translateLad(net('Contact( #a )\nMove{ Card := 1; DisableENO := TRUE }( IN := 5, OUT1 => "DB".x )')).scl).toContain('IF #a THEN "DB".x := 5; END_IF;');
    // an edge contact: the operand's rising edge, whatever the power flow; the edge memory keeps the operand
    expect(translateLad(net("Contact( #a )\nP_Contact( #b, #m )\nCoil( #q )")).scl).toContain("#__rung1 := #b AND NOT #m;\n#m := #b;\n#q := #a AND #__rung1;");
    expect(translateLad(net("Contact( #a )\nCalculate{ SrcType := Int }( IN1 := #x, OUT => #y )")).unsupported).toEqual(["Calculate{ SrcType := Int }( IN1 := #x, OUT => #y )"]);
    expect(translateLad("NETWORK\n RUNG wire#w1\n Contact( #a )\n END_RUNG\nEND_NETWORK\n").unsupported[0]).toMatch(/never join/);
  });
});
