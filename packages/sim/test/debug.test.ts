// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex } from "@rung/lsp";
import { DebugSession, type DebugState } from "../src/index.js";

const fx = (f: string) => readFileSync(fileURLToPath(new URL(`../../../tools/fixtures/scl/${f}`, import.meta.url)), "utf8");
const MOTOR_URI = "file:///w/plc/P/blocks/Fx_Motor.scl";
const CALLS_URI = "file:///w/plc/P/blocks/Calls.scl";
const CALLS = `FUNCTION "Fc_Twice" : Int
VAR_INPUT
  x : Int;
END_VAR
BEGIN
  #Fc_Twice := #x * 2;
END_FUNCTION

FUNCTION_BLOCK "Fb_User"
VAR_INPUT
  a : Int;
END_VAR
VAR
  r : Int;
END_VAR
BEGIN
  #r := "Fc_Twice"(x := #a);
  #r := #r + 1;
END_FUNCTION_BLOCK
`;

function index() {
  const idx = new WorkspaceIndex();
  idx.set(MOTOR_URI, fx("Fx_Motor.scl"), 0);
  idx.set(CALLS_URI, CALLS, 0);
  return idx;
}

// cycle 1 starts the motor, cycle 2 keeps it running, cycle 3 stops it (10 ms each)
const MOTOR = `
block: Fx_Motor
cases:
  - name: starts, latches and stops
    steps:
      - set: { Start: true, SpeedSetpoint: 1500 }
      - cycle: 1
      - expect: { Running: true }
      - set: { Start: false }
      - cycle: 1
      - expect: { Running: true }
      - set: { Stop: true }
      - cycle: 1
      - expect: { Running: false, SpeedOut: 0 }
`;
const USER = `block: Fb_User\ncases:\n  - name: doubles plus one\n    steps:\n      - set: { a: 4 }\n      - cycle: 1\n      - expect: { r: 9 }\n`;

const at = (s: DebugState) => (s.kind === "stopped" ? { line: s.frames[0]!.line, time: s.time, depth: s.frames.length } : { ended: s.result?.passed });

describe("rung debug sessions", () => {
  it("stops on entry and steps statement by statement with locals", async () => {
    const d = new DebugSession(index(), "t.yaml", MOTOR, 0);
    expect(at(await d.start(true))).toEqual({ line: 22, time: 10, depth: 1 });
    expect(d.locals(0).find((v) => v.name === "Latch")?.value).toBe("FALSE");
    expect(at(await d.next())).toEqual({ line: 23, time: 10, depth: 1 });
    expect(d.locals(0).find((v) => v.name === "Latch")).toMatchObject({ value: "TRUE", type: "Bool", evaluateName: "#Latch" });
    expect(at(await d.next())).toMatchObject({ line: 24 });
    expect(at(await d.next())).toMatchObject({ line: 25 });
    expect(at(await d.next())).toEqual({ line: 22, time: 20, depth: 1 }); // the next cycle
  });

  it("stops at the statement a runtime error came from", async () => {
    const idx = new WorkspaceIndex();
    idx.set("file:///w/plc/P/blocks/Arr.scl", 'FUNCTION_BLOCK "Fb_Arr"\nVAR_INPUT\n  i : Int;\nEND_VAR\nVAR\n  a : Array[0..3] of Int;\nEND_VAR\nBEGIN\n  #a[0] := 1;\n  #a[#i] := 2;\nEND_FUNCTION_BLOCK\n', 0);
    const d = new DebugSession(idx, "a.yaml", "block: Fb_Arr\ncases:\n  - name: out of range\n    steps:\n      - set: { i: 9 }\n      - cycle: 1\n", 0);
    const s = await d.start(false);
    expect(s).toMatchObject({ kind: "stopped", reason: "exception", frames: [{ name: "Fb_Arr", line: 10 }] });
    expect(s.kind === "stopped" && s.text).toMatch(/^step 2: .*index 9 out of range/);
    expect(d.evaluate("#i").value).toBe("9");
    expect((await d.continue()).kind).toBe("ended");
  });

  it("steps out of the tested block to its next cycle", async () => {
    const d = new DebugSession(index(), "t.yaml", MOTOR, 0);
    await d.start(true);
    await d.next();
    expect(at(await d.stepOut())).toEqual({ line: 22, time: 20, depth: 1 });
    expect(at(await d.stepOut())).toEqual({ line: 22, time: 30, depth: 1 });
    expect(at(await d.stepOut())).toEqual({ ended: true });
  });

  it("continues to breakpoints and back to earlier hits", async () => {
    const d = new DebugSession(index(), "t.yaml", MOTOR, 0);
    d.breakpoints = [{ uri: MOTOR_URI, line: 27 }];
    expect(at(await d.start(false))).toEqual({ line: 27, time: 30, depth: 1 });
    expect(at(await d.stepBack())).toMatchObject({ line: 24, time: 30 });
    d.breakpoints = [{ uri: MOTOR_URI, line: 25 }];
    expect(at(await d.reverseContinue())).toMatchObject({ line: 25, time: 20 });
    expect(at(await d.reverseContinue())).toMatchObject({ line: 25, time: 10 });
    expect(at(await d.reverseContinue())).toMatchObject({ line: 22, time: 10 }); // none earlier: the start
    d.breakpoints = [];
    expect(at(await d.continue())).toEqual({ ended: true });
  });

  it("stops at a conditional breakpoint only when its condition holds", async () => {
    const d = new DebugSession(index(), "t.yaml", MOTOR, 0);
    d.breakpoints = [{ uri: MOTOR_URI.replace("file:///w", "file:///W"), line: 22, condition: "Stop" }];
    expect(at(await d.start(false))).toMatchObject({ line: 22, time: 30 });
  });

  it("evaluates expressions in the frame", async () => {
    const d = new DebugSession(index(), "t.yaml", MOTOR, 0);
    await d.start(true);
    expect(d.evaluate("#SpeedSetpoint * 2").value).toBe("3000");
    expect(d.evaluate("Start").value).toBe("TRUE");
    expect(() => d.evaluate("#Nope")).toThrow(/Nope/);
  });

  it("keeps a value set while stopped across later runs", async () => {
    const d = new DebugSession(index(), "t.yaml", MOTOR, 0);
    await d.start(true);
    const r = await d.setVariable("#Stop", "TRUE", 0);
    expect(r.value).toBe("TRUE");
    expect(at(await d.next())).toMatchObject({ line: 23 });
    expect(d.evaluate("#Latch").value).toBe("FALSE");
    // the failed expectation stops first, at the last statement before its step, then the case ends
    const failed = await d.continue();
    expect(failed).toMatchObject({ kind: "stopped", reason: "exception", text: "step 3: Running expected true, got false", time: 10 });
    const end = await d.continue();
    expect(end.kind === "ended" && end.result?.failures[0]).toMatchObject({ name: "Running", expected: true, actual: false });
    await expect(d.start(true).then(() => d.setVariable("#Running", "'text'x", 0))).rejects.toThrow();
  });

  it("steps into a called function and out again", async () => {
    const d = new DebugSession(index(), "u.yaml", USER, 0);
    expect(at(await d.start(true))).toEqual({ line: 17, time: 10, depth: 1 });
    expect(at(await d.stepIn())).toEqual({ line: 6, time: 10, depth: 2 });
    const frames = d.frames();
    expect(frames.map((f) => [f.name, f.line])).toEqual([["Fc_Twice", 6], ["Fb_User", 17]]);
    expect(d.locals(0).map((v) => [v.name, v.value])).toEqual([["x", "4"], ["Fc_Twice", "0"]]);
    expect(d.locals(1).find((v) => v.name === "a")?.value).toBe("4");
    expect(at(await d.stepOut())).toEqual({ line: 18, time: 10, depth: 1 });
    expect(d.evaluate("#r").value).toBe("8");
    expect(at(await d.stepBack())).toEqual({ line: 17, time: 10, depth: 1 });
    expect(at(await d.continue())).toEqual({ ended: true });
  });
});
