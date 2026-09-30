# Unit tests for SCL, LAD, FBD and STL blocks (`rung test`)

rung runs unit tests for SCL, LAD, FBD and STL function blocks and functions on an **offline simulator** — no PLC, no PLCSIM licence, works on Linux CI.

```
rung test                       # all tests/**/*.test.yaml
rung test --filter motor        # only files whose path contains "motor"
rung test --filter Fx_Motor     # only the tests of the block Fx_Motor
rung test --junit report.xml    # JUnit XML for CI
rung test --json                # every result with the line of its case and failing step (VS Code's Testing view uses it)
```

In GitHub Actions, `rung test` also writes each failure as an annotation on the line of its step, so it shows in the pull request; `uses: sa1ntsinner/rung@v1` runs it in three lines ([CI](ci.md)).

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

- `set` writes inputs, statics, instance members (`Timer.PT`) or globals (`"DB".member`, `"Tag"`). Array elements are addressed as `'pts[2].x'` or `'grid[1,2]'` (quote them inside `{ … }`). The value must fit the variable: `true`/`false` for BOOL, a whole number within range for integer types (40000 is refused for an Int), numbers for reals, strings for strings.
- With several PLCs that each have a block of that name, say which: `plc: PLC_1` in the file, or keep the test under `tests/PLC_1/`. rung refuses to guess.
- `expect` compares with a small tolerance for reals; `T#…` strings are durations.
- One step may combine several keys, e.g. `- { set: { Start: true }, cycle: 1, expect: { Running: true } }`. They always run in the order `set`, `cycle`, `advance`, `expect`, whatever order they are written in. Unknown keys are rejected.
- For an FC, the return value is expected under the block's own name; IN_OUT parameters keep the value the FC wrote, like the caller's variable would.

## What the simulator covers

- SCL statements: assignment (also `a := b := 0;`), IF/ELSIF/ELSE, CASE (lists, ranges), FOR/WHILE/REPEAT with EXIT/CONTINUE, RETURN, REGION, GOTO to a label.
- Expressions with SCL precedence, integer vs. real division, typed literals (`16#FF`, `T#1s`, `DINT#5`); integers wrap around on overflow like on an S7-1500 (32767 + 1 = -32768 in an Int).
- TwinCAT / CODESYS structured text: PROGRAMs, FBs with METHODs and `THIS^`, PROPERTYs (GET and SET, each with its own locals), ACTIONs, enumerations (`E_State.Idle`, `E_State#Idle`, bare `Idle`), `POINTER TO` with `ADR` and `^`, `REFERENCE TO` with `REF=`.
- User FBs (single and multi-instance), FCs, global DBs (including UDT members and start values), PLC tags.
- IEC standard FBs with virtual time: TON/TOF/TP (and `_TIME`/`_LTIME`), CTU/CTD/CTUD, R_TRIG/F_TRIG, SR/RS; standard functions (LIMIT, MIN/MAX, SEL, MUX, math, shifts, `*_TO_*` conversions; strings: CONCAT, LEN, LEFT, RIGHT, MID, FIND, DELETE, INSERT, REPLACE).
- System instructions, as the TIA Portal help describes them:
  - `SWAP` of a WORD, DWORD or LWORD (an integer of that width bit for bit).
  - `RD_SYS_T` and `RD_LOC_T` into a DTL, DT or LDT. The virtual clock starts at 2024-01-01 00:00:00 (a Monday) and runs with the virtual time; it has no time zone, so both read the same. `RUNTIME`: the virtual seconds since the last call with the same MEM (code takes no time, so 0 within one cycle).
  - `T_DIFF` of two DTL, DT, LDT, TOD or LTOD; `T_ADD` and `T_SUB` of a TIME to a TIME, LTIME, TOD, LTOD, DT, LDT or DTL. A DTL nobody set is DTL#1970-01-01-00:00:00.
  - `IS_ARRAY`, `CountOfElements`, `LOWER_BOUND`, `UPPER_BOUND`; `MOVE_BLK`, `UMOVE_BLK`, `FILL_BLK`, `UFILL_BLK` element by element (structures are copied).
  - `VAL_STRG` in decimal notation: right-aligned in SIZE characters (SIZE 0: as many as needed), PREC decimals (an integer gets its decimal point PREC places from the right), FORMAT's separator and sign bits.
  - VARIANT and ARRAY[*] parameters (inputs, outputs and in/outs) are bound to the caller's variable and know its declared type: `TypeOf` and `TypeOfElements` compared with a data type (`TypeOf(#in) = Int`, `TypeOfElements(#a) = "UDT_X"`, `CASE TypeOf(#in) OF Int: …`) or with each other, `VariantGet`, `VariantPut`, `MOVE_BLK_VARIANT` (SRC_INDEX and DEST_INDEX count from 0 whatever the low bound; a variable that is no array is one element; returns 0), `CountOfElements`, and `IS_NULL` / `NOT_NULL` of a REF_TO or VARIANT.
  - Where the PLC's result is not modelled, the test stops and says why instead of guessing: a TIME beyond ±24 days, a TOD past midnight, overlapping or too long block moves, VAL_STRG into the middle of a string or wider than SIZE, an ARRAY of BOOL for CountOfElements, TypeOf of an ARRAY (use TypeOfElements), copies between two data types, multi-dimensional arrays for MOVE_BLK_VARIANT.
- LAD blocks mirrored as SIMATIC SD (`.s7dcl`): contacts, negated contacts, coils, set/reset coils, parallel branches, IEC timer/counter/trigger boxes, comparisons, MOVE, ADD/SUB/MUL/DIV/MOD and calls of FBs and FCs. A block with anything else (edge contacts, for example) is refused with the list of what is missing.
- LAD and FBD blocks kept as SimaticML (`.xml`: every LAD block with network titles or comments, and every FBD block), read network by network from TIA Portal's export: contacts (negated, P and N edge contacts), coils (negated, set, reset, P and N coils), P_TRIG/N_TRIG, NOT, parallel branches and branches that split, FBD AND/OR/XOR with negated inputs, SR and RS, comparisons, IN_RANGE/OUT_RANGE, MOVE, ADD/SUB/MUL/DIV/MOD/NEG, ABS/SQRT/SQR/LN/EXP and the trigonometric functions, MIN/MAX/LIMIT/SEL, SHL/SHR, CONVERT/ROUND/TRUNC/CEIL/FLOOR, INC/DEC, IEC timers, counters and triggers, and calls of FBs and FCs with EN and ENO. Where a branch splits, the power flow is taken once, as the PLC does. A network with anything else, and an SCL or STL network inside such a block, is refused with the network and what it holds.
- STL blocks (`.awl`), interpreted with the status word (RLO, /FC, OR, the nesting stack) and the two accumulators as the S7-300/400 STL reference manual describes them. This is checked by unit tests (truth tables, accumulator widths, timer timing), not against a PLC.
  - Bit logic: `A`, `AN`, `O`, `ON`, `O` without an operand, `A(`, `AN(`, `O(`, `ON(`, `)` (at most 7 levels), `=`, `S`, `R`, `SET`, `CLR`, `FP`, `FN`.
  - Load and transfer: `L`, `T` of Byte, Word, Int, UInt, DWord, DInt, UDInt, Real, Time, TOD and S5Time variables and constants (`5`, `L#70000`, `16#FF`, `W#16#1234`, `1.5`, `T#2s`, `S5T#2s`). L clears ACCU1 first, so an Int of -1 is 16#0000FFFF until `ITD`.
  - Accumulator: `+I`, `-I`, `*I`, `/I`, `+D`, `-D`, `*D`, `/D`, `+R`, `-R`, `*R`, `/R`, `ITD`, `DTR`, `RND` (half way to the even number), `TRUNC`, `CAW`, `CAD`; compares `==I`, `<>I`, `>I`, `<I`, `>=I`, `<=I` and the same for D and R.
  - Jumps and ends: `JU`, `JC`, `JCN` to labels (RLO = 1 afterwards, jump or not), `NOP`, `BE`, `BEU`.
  - Timers: `SD`, the S5 on-delay timer, on a PLC tag of type Timer (%T), with its S5TIME from a constant, a Word (time base and BCD) or an S5Time variable, on virtual time; `A`, `AN`, `O`, `ON` read its status.
  - Operands: locals, DB members, PLC tags, and absolute addresses (`%I0.0`) that have a PLC tag; an FC's `#RET_VAL` is its return value.
  - Refused before the block runs, with the list: everything else (CALL, TAK/PUSH/POP, OPN and absolute DB addresses, AR1/AR2, indirect addressing, pointers, and any instruction that reads CC0, CC1, OV, OS or BR). Refused when reached, where the manual leaves the result open: a compare inside a running logic string (start the string with it or put it in `A( … )`), a jump inside `A( … )`, and a network that starts while the logic string of the one before is still open.

## What it does not do

It is a logic simulator, not an emulation of the S7-1500 runtime: no other system instructions (communication such as TSEND, TRCV, MB_CLIENT; motion and technology objects; diagnostics such as RDREC, WRREC; data logging; `S_CONV`, `STRG_VAL`, `T_CONV`, `T_COMBINE` and VAL_STRG in exponential notation), which stop the test with their name; no GRAPH blocks, no STL beyond the instructions above (nor STL blocks TIA Portal keeps as SimaticML), no OB scheduling or interrupts, no pointer arithmetic, no FB inheritance (EXTENDS), and timing is exactly the virtual cycle you configure. Use it for logic regression tests; validate timing and hardware behaviour in PLCSIM or on the machine.
