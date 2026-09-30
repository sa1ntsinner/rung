---
name: plc-testing
description: Use when testing PLC logic in a rung workspace: writing tests/**/*.test.yaml for rung test (offline SCL simulator), checking a fix, reproducing a machine fault in simulation, or trying live-value features against rung simulate.
---

# Testing PLC logic with rung

`rung test` runs FBs, FCs and PROGRAMs on an offline SCL simulator with virtual time: IEC timers and counters, edge detection, DB start values. It is fast, repeatable and runs in CI. It is not the PLC: no hardware timing, no communication, no system instructions, no FBD/GRAPH/STL bodies. LAD blocks in `.s7dcl` run too (see `lad-in-text`).

## A test file

```yaml
# tests/conveyor.test.yaml
block: FB_Conveyor        # the FB/FC/PROGRAM under test
cycle: 10ms               # scan time of the virtual CPU
cases:
  - name: starts when the start button is pressed and the guard is closed
    steps:
      - set: { guardClosed: true, startBtn: true }
      - cycle: 1
      - expect: { motorOn: true, fault: false }
  - name: stops within one scan when the guard opens
    steps:
      - set: { guardClosed: true, startBtn: true }
      - cycle: 2
      - set: { guardClosed: false }
      - cycle: 1
      - expect: { motorOn: false }
  - name: reports a fault when the belt does not move within 3 s
    steps:
      - set: { guardClosed: true, startBtn: true, beltMoving: false }
      - advance: 3100ms
      - expect: { fault: true, motorOn: false }
```

Steps: `set` (inputs, statics, `"DB".member`, `arr[2].x`), `cycle: n`, `advance: <time>`, `expect`. Several keys in one step run in the order set, cycle, advance, expect. Run with `rung_test` (or `rung test --filter FB_Conveyor`); JUnit output with `--junit`.

## What to test

For every behaviour you change, one case for the normal path and at least one per unhappy path: timeout, sensor lost or stuck, stop or emergency stop mid-sequence, restart after a fault, first scan. Test the boundaries of every limit (setpoint at min, max, beyond). A test that only proves the happy path is half a test.

## Limits of the simulator

A few system instructions run offline (SWAP, RD_SYS_T/RD_LOC_T on a virtual clock that starts 2024-01-01, RUNTIME, T_DIFF/T_ADD/T_SUB, MOVE_BLK/FILL_BLK, IS_ARRAY/CountOfElements/LOWER_BOUND/UPPER_BOUND, VAL_STRG, and on VARIANT parameters TypeOf/TypeOfElements, VariantGet/VariantPut, MOVE_BLK_VARIANT; docs/testing.md has the details). Other system instructions and technology objects fail with "not simulated"; wrap such calls behind an FB interface so the logic around them can still be tested. Report which parts of the change could not be simulated.

## Live values without a machine

`rung simulate --block FB_Conveyor` starts a virtual S7-1500 on `http://127.0.0.2:8080` that runs the block every cycle and answers the Web API; its instance is `"FB_Conveyor_DB"`. Point `[live.webapi]` in rung.toml at it and use `rung live read` / `rung_live_read`. It cannot be the target of a TIA download; for that the person uses S7-PLCSIM.
