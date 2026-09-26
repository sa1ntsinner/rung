# Unit tests for SCL blocks (`rung test`)

rung runs unit tests for SCL function blocks and functions on an **offline simulator** — no PLC, no PLCSIM licence, works on Linux CI.

```
rung test                       # all tests/**/*.test.yaml
rung test --filter motor        # only files whose path contains "motor"
rung test --junit report.xml    # JUnit XML for CI
```

## Test file

```yaml
# tests/drives/motor.test.yaml
block: Fx_Motor          # FB: one instance lives through all steps of a case; FC: called every cycle
cycle: 10ms              # virtual cycle time (default 10ms)
cases:
  - name: starts, latches and stops
    steps:
      - set: { Start: true, SpeedSetpoint: 1500 }
      - cycle: 1                          # run one cycle (time advances by `cycle`)
      - expect: { Running: true, SpeedOut: 1500 }
      - set: { Start: false }
      - advance: 2s                       # run as many cycles as fit into 2 s
      - expect: { Running: true }
      - set: { '"Fx_Global".Ready': true } # DB members and tags use their TIA names
      - expect: { Debounce.Q: false, Elapsed: "T#0ms" }
```

- `set` writes inputs, statics, instance members (`Timer.PT`) or globals (`"DB".member`, `"Tag"`). Array elements are addressed as `'pts[2].x'` or `'grid[1,2]'` (quote them inside `{ … }`). The value must match the variable's kind: `true`/`false` for BOOL, numbers for numeric types, strings for strings.
- `expect` compares with a small tolerance for reals; `T#…` strings are durations.
- One step may combine several keys, e.g. `- { set: { Start: true }, cycle: 1, expect: { Running: true } }`. They always run in the order `set`, `cycle`, `advance`, `expect`, whatever order they are written in. Unknown keys are rejected.
- For an FC, the return value is expected under the block's own name; IN_OUT parameters keep the value the FC wrote, like the caller's variable would.

## What the simulator covers

- SCL statements: assignment, IF/ELSIF/ELSE, CASE (lists, ranges), FOR/WHILE/REPEAT with EXIT/CONTINUE, RETURN, REGION.
- Expressions with SCL precedence, integer vs. real division, typed literals (`16#FF`, `T#1s`, `DINT#5`).
- User FBs (single and multi-instance), FCs, global DBs (including UDT members and start values), PLC tags.
- IEC standard FBs with virtual time: TON/TOF/TP (and `_TIME`/`_LTIME`), CTU/CTD/CTUD, R_TRIG/F_TRIG, SR/RS; standard functions (LIMIT, MIN/MAX, SEL, MUX, math, strings, shifts, `*_TO_*` conversions).

## What it does not do

It is a logic simulator, not an emulation of the S7-1500 runtime: no integer overflow wrap-around, no system instructions (communication, motion, diagnostics), no LAD/FBD/GRAPH blocks, no OB scheduling or interrupts, and timing is exactly the virtual cycle you configure. Use it for logic regression tests; validate timing and hardware behaviour in PLCSIM or on the machine.
