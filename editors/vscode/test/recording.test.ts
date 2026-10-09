// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { Recorder, formatted, recordingAsTest } from "../src/core/recording";
import { testModel } from "@rung/lsp";

describe("Live Values formats", () => {
  it("keeps the PLC decimal display for REAL zero and retains explicit integer formats", () => {
    expect(formatted(0, "dec", "0.0")).toBe("0.0");
    expect(formatted(0)).toBe("0");
    expect(formatted(255, "hex", "255")).toBe("16#FF");
  });
  it("shows integers as TIA Portal does in hex and binary, two's complement for negatives", () => {
    expect([formatted(255, "hex"), formatted(5, "bin"), formatted(-1, "hex"), formatted(70000, "hex"), formatted(255)]).toEqual(["16#FF", "2#0000_0101", "16#FF", "16#00011170", "255"]);
    expect([formatted(true, "hex"), formatted(2.5, "hex"), formatted("on", "bin"), formatted(undefined)]).toEqual(["TRUE", "2.5", "'on'", "…"]);
  });
});

describe("a recorded window as a test", () => {
  it("sets the inputs as they changed and expects the outputs as they settled before the next change", () => {
    const S = '"Conv_DB".Start';
    const M = '"Conv_DB".Motor';
    const frames = [
      { at: 1000, values: { [S]: false, [M]: false } },
      { at: 1500, values: { [S]: true, [M]: false } }, // pressed: the motor follows a cycle later
      { at: 2000, values: { [S]: true, [M]: true } },
      { at: 3000, values: { [S]: false, [M]: true } },
      { at: 3500, values: { [S]: false, [M]: true } },
    ];
    const yaml = recordingAsTest(frames, { [S]: { member: "Start", dir: "in" }, [M]: { member: "Motor", dir: "out" } }, "FB_Conveyor", "start latches the motor");
    // each expectation at the time of the output it checks, then the rest of the time to the next change
    expect(yaml).toContain(`block: FB_Conveyor
cases:
  - name: "start latches the motor"
    steps:
      - set: { Start: false }
        cycle: 1
        expect: { Motor: false }
      - advance: 500ms
      - set: { Start: true }
        advance: 500ms
        expect: { Motor: true }
      - advance: 1000ms
      - set: { Start: false }
        advance: 500ms
        expect: { Motor: true }
`);
    // a test file rung reads
    const model = testModel(yaml);
    expect(model.errors).toEqual([]);
    expect(model.cases[0]!.steps.filter((s) => s.set).map((s) => s.set!.entries.map((e) => `${e.key}=${e.value}`).join())).toEqual(["Start=false", "Start=true", "Start=false"]);
  });

  it("names any block safely, with its PLC, and refuses a window in which no output was read", () => {
    const frames = [{ at: 0, values: { i: true, o: false } }];
    const roles = { i: { member: "In", dir: "in" as const }, o: { member: "Out", dir: "out" as const } };
    const yaml = recordingAsTest(frames, roles, "Pump: motor #1", "c", "PLC_2");
    expect(yaml).toMatch(/^block: "Pump: motor #1"\nplc: PLC_2\n/m);
    expect(testModel(yaml).block?.value).toBe("Pump: motor #1");
    expect(() => recordingAsTest([{ at: 0, values: { i: true } }], roles, "FB", "c")).toThrow(/no output of FB was read/);
  });
});

describe("the flight recorder", () => {
  it("keeps the reads of the last minutes with their bookmarks and writes them as CSV", () => {
    const r = new Recorder(1000);
    r.add({ at: 0, values: { a: true, b: 1 } });
    r.add({ at: 400, values: { a: false, b: 2 } });
    r.mark(450, 'start, "pressed"');
    r.add({ at: 500, values: { a: false, b: 255 } });
    r.add({ at: 1300, values: { a: true } }); // the first read is older than a second now
    expect(r.frames.map((f) => f.at)).toEqual([400, 500, 1300]);
    expect(r.csv(["a", "b"], { b: "hex" }).split("\n")).toEqual([
      "time,ms,a,b,bookmark",
      "1970-01-01T00:00:00.400Z,0,FALSE,16#02,",
      '1970-01-01T00:00:00.500Z,100,FALSE,16#FF,"start, ""pressed"""',
      "1970-01-01T00:00:01.300Z,900,TRUE,,",
      "",
    ]);
  });
});
