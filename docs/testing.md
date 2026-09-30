# Unit tests for SCL, LAD, FBD and STL blocks (`rung test`)

rung runs unit tests for SCL, LAD, FBD and STL function blocks and functions on an **offline simulator** — no PLC, no PLCSIM licence, works on Linux CI.

```
rung test                       # all tests/**/*.test.yaml
rung test --filter motor        # only files whose path contains "motor"
rung test --filter Fx_Motor     # only the tests of the block Fx_Motor
rung test --junit report.xml    # JUnit XML for CI
rung test --json                # every result with the line of its case, of each failing step and of the step an error stopped in (VS Code's Testing view uses it)
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
- A case that stops with an error (a misspelt name in a `set`, an instruction the simulator refuses) says in which step: `step 2: Strat does not exist (did you mean Start?)`. `--json` gives that step and its line as `errorStep` and `errorLine`, so editors and GitHub annotations point at the step, not at the case.

## Stubs

What the simulator does not model (communication, diagnostics, data logging, motion, technology objects, a block the workspace does not have) stops a test with its name. A test can stand in for it with `stubs:`, a map from the name to the values its outputs start with:

```yaml
block: Fx_Reader
stubs:
  RDREC: { VALID: false, BUSY: false, ERROR: false, STATUS: 0, LEN: 4 }
  MB_CLIENT: { DONE: false, BUSY: false, ERROR: false }
  Lib_Filter: { Out: 0.0 }        # an FB the workspace does not have
  Fx_Log: { RET_VAL: 0 }          # an FC: its return value and outputs
  '"Axis_1"': { StatusWord: 0 }   # a technology object, with its quotes
  '"Rack~Gateway"': 257           # a hardware identifier: the number the device configuration gives it
cases:
  - name: reads a valid record
    steps:
      - set: { start: true }
      - cycle: 1
      - expect: { rd.REQ: true, rd.INDEX: 1 }   # what the block passed to the stub
      - set: { rd.VALID: true }                 # what the stub gives back from now on
      - cycle: 1
      - expect: { value: 4 }
```

- **An FB** named there (a system FB, a user FB, one the workspace does not have) runs no code. A call puts its arguments into the instance (`rd.REQ`), and its outputs keep what they hold: the stub's values first, then what a step `set`s (`rd.VALID`). Its instances in the block under test, in the blocks it calls and in instance DBs are all stubs.
  - For a type nothing describes, a member is created the first time a call argument or a test names it. A member the code only reads must be given a value in the stub; the error says so.
  - Arguments with `:=` are inputs.
- **An FC or instruction** named there returns `RET_VAL` from the stub, or else 0 (for a workspace FC: its type's default). It writes the outputs the stub names; an output it does not name keeps the caller's value.
- **A technology object**, named with its quotes, has the members the stub names. They are readable and settable (`'"Axis_1".StatusWord'`), and the object can be called like an instance.
- **A hardware identifier** (`"Rack~Gateway"`, a system constant) has no value offline. The test gives it one, a number, where the code passes it on (to a stubbed RDREC, for example).
- **Only what is named is stubbed.**
  - `rung test` prints once per file what the stubs stood in for (`stubbed: RDREC ×2, MB_CLIENT`), and marks a stub of code the simulator could run itself ("replaces code the simulator runs"). This is allowed, to test one unit alone.
  - A stub the cases never called gets a warning: a typo, or code they do not reach.
  - Refused like the rest of the file: a name nothing in the workspace calls or declares (with the closest one), a member a known type does not have, a value its declared type cannot hold, and the block under test itself.

## What the simulator covers

- SCL statements: assignment (also `a := b := 0;`), IF/ELSIF/ELSE, CASE (lists, ranges), FOR/WHILE/REPEAT with EXIT/CONTINUE, RETURN, REGION, GOTO to a label.
- Expressions with SCL precedence, integer vs. real division, typed literals (`16#FF`, `T#1s`, `DINT#5`); integers wrap around on overflow like on an S7-1500 (32767 + 1 = -32768 in an Int).
- 64-bit integers (LINT, ULINT, LWORD) bit for bit, or not at all: arithmetic, AND/OR/XOR/NOT and shifts are computed exactly and cut to the width of the type (SHL of an LWORD by 64 is 0). The simulator holds a value exactly up to 2^53, and beyond that only where a double holds it (2^63, 16#FF00_0000_0000_0000). A result or a literal it cannot hold exactly (2^53 + 1, NOT 0 of an LWORD, `LWORD#16#FFFF_FFFF_FFFF_FFFF`) stops the test with the value instead of losing its low bits.
- TwinCAT / CODESYS structured text: PROGRAMs, FBs with METHODs and `THIS^`, PROPERTYs (GET and SET, each with its own locals), ACTIONs, enumerations (`E_State.Idle`, `E_State#Idle`, bare `Idle`), `POINTER TO` with `ADR` and `^`, `REFERENCE TO` with `REF=`.
- User FBs (single and multi-instance), FCs, global DBs (including UDT members and start values), PLC tags.
- IEC standard FBs with virtual time: TON/TOF/TP (and `_TIME`/`_LTIME`), CTU/CTD/CTUD, R_TRIG/F_TRIG, SR/RS; standard functions (LIMIT, MIN/MAX, SEL, MUX, math, shifts, `*_TO_*` conversions; strings: CONCAT, LEN, LEFT, RIGHT, MID, FIND, DELETE, INSERT, REPLACE).
- System instructions, as the TIA Portal help describes them:
  - `SWAP` of a WORD, DWORD or LWORD (an integer of that width bit for bit; an LWORD result a double cannot hold, see above, stops the test).
  - `RD_SYS_T` and `RD_LOC_T` into a DTL, DT or LDT. The virtual clock starts at 2024-01-01 00:00:00 (a Monday) and runs with the virtual time; it has no time zone, so both read the same. `RUNTIME`: the virtual seconds since the last call with the same MEM (code takes no time, so 0 within one cycle).
  - `T_DIFF` of two DTL, DT, LDT, TOD or LTOD; `T_ADD` and `T_SUB` of a TIME to a TIME, LTIME, TOD, LTOD, DT, LDT or DTL. A DTL nobody set is DTL#1970-01-01-00:00:00.
  - `IS_ARRAY`, `CountOfElements`, `LOWER_BOUND`, `UPPER_BOUND`; `MOVE_BLK`, `UMOVE_BLK`, `FILL_BLK`, `UFILL_BLK` element by element (structures are copied).
  - `VAL_STRG` in decimal notation: right-aligned in SIZE characters (SIZE 0: as many as needed), PREC decimals (an integer gets its decimal point PREC places from the right), FORMAT's separator and sign bits.
  - VARIANT and ARRAY[*] parameters (inputs, outputs and in/outs) are bound to the caller's variable by its place (it stays bound when the structure or array around it is assigned anew during the call) and know its declared type: `TypeOf` and `TypeOfElements` compared with a data type (`TypeOf(#in) = Int`, `TypeOfElements(#a) = "UDT_X"`, `CASE TypeOf(#in) OF Int: …`) or with each other, `VariantGet`, `VariantPut`, `MOVE_BLK_VARIANT` (SRC_INDEX and DEST_INDEX count from 0 whatever the low bound; a variable that is no array is one element; returns 0), `CountOfElements`, and `IS_NULL` / `NOT_NULL` of a REF_TO or VARIANT.
  - Where the PLC's result is not modelled, the test stops and says why instead of guessing: a TIME beyond ±24 days, a TOD past midnight, overlapping or too long block moves, VAL_STRG into the middle of a string or wider than SIZE, an ARRAY of BOOL for CountOfElements, TypeOf of an ARRAY (use TypeOfElements), copies between two data types, multi-dimensional arrays for MOVE_BLK_VARIANT.
- LAD blocks mirrored as SIMATIC SD (`.s7dcl`): contacts, negated contacts, coils, set/reset coils, parallel branches, IEC timer/counter/trigger boxes, comparisons, MOVE, ADD/SUB/MUL/DIV/MOD and calls of FBs and FCs. A block with anything else (edge contacts, for example) is refused with the list of what is missing.
- LAD and FBD blocks kept as SimaticML (`.xml`: every LAD block with network titles or comments, and every FBD block), read network by network from TIA Portal's export: contacts (negated, P and N edge contacts), coils (negated, set, reset, P and N coils), P_TRIG/N_TRIG, NOT, parallel branches and branches that split, FBD AND/OR/XOR with negated inputs, SR and RS, comparisons, IN_RANGE/OUT_RANGE, MOVE, ADD/SUB/MUL/DIV/MOD/NEG, ABS/SQRT/SQR/LN/EXP and the trigonometric functions, MIN/MAX/LIMIT/SEL, SHL/SHR, CONVERT/ROUND/TRUNC/CEIL/FLOOR, INC/DEC, IEC timers, counters and triggers, and calls of FBs and FCs with EN and ENO. Where a branch splits, the power flow is taken once, as the PLC does. A network with anything else is refused with the network and what it holds.
  - SCL and STL networks inside such a block run too, in network order and in the block's own variables. An SCL network's text is rebuilt from TIA Portal's tokens and joins the block's SCL. An STL network runs through the STL interpreter below. STL blocks TIA Portal keeps as SimaticML run the same way, network by network.
  - STL in SimaticML: TIA Portal names some instructions differently there (`=` is `Assign`, `+` is `ADD`); an instruction the interpreter does not run is refused by its name before the block runs. A logic string still open at the end of an STL network other than the last is refused: on the PLC it goes on in the next network, which may be LAD or SCL.
  - The operands of SCL and STL networks are references for the editor and the call graph, like those of LAD and FBD networks.
- STL blocks (`.awl`), interpreted with the status word (RLO, /FC, OR, the nesting stack) and the two accumulators as the S7-300/400 STL reference manual describes them. This is checked by unit tests (truth tables, accumulator widths, timer timing, calls), not against a PLC.
  - Bit logic: `A`, `AN`, `O`, `ON`, `X`, `XN`, `O` without an operand, `A(`, `AN(`, `O(`, `ON(`, `X(`, `XN(`, `)` (at most 7 levels), `NOT`, `=`, `S`, `R`, `SET`, `CLR`, `FP`, `FN`.
  - As in the manual, `O` with an operand ORs it with the result so far: `A a; O b; A c; = q` is (a OR b) AND c. Only `O` without an operand puts AND before OR: `A a; A b; O; A c; = q` is (a AND b) OR c.
  - A network does not end a logic string: it goes on in the next network, as on the PLC.
  - Load and transfer: `L`, `T` of Byte, Word, Int, UInt, DWord, DInt, UDInt, Real, Time, TOD and S5Time variables and constants (`5`, `L#70000`, `16#FF`, `W#16#1234`, `1.5`, `T#2s`, `S5T#2s`). L clears ACCU1 first, so an Int of -1 is 16#0000FFFF until `ITD`.
  - Accumulator: `+I`, `-I`, `*I`, `/I`, `+D`, `-D`, `*D`, `/D`, `+R`, `-R`, `*R`, `/R`, `+` of a constant (`+ 5` to the low word, `+ L#70000` to the double word), `ITD`, `DTR`, `RND` (half way to the even number), `TRUNC`, `CAW`, `CAD`; compares `==I`, `<>I`, `>I`, `<I`, `>=I`, `<=I` and the same for D and R.
  - Jumps and ends: `JU`, `JC`, `JCN` to labels (RLO = 1 afterwards, jump or not), `NOP`, `BE`, `BEU`.
  - Timers: `SD`, the S5 on-delay timer, on a PLC tag of type Timer (%T), with its S5TIME from a constant, a Word (time base and BCD) or an S5Time variable, on virtual time; `A`, `AN`, `O`, `ON` read its status.
  - Calls: `CALL "FB", "Inst_DB"`, `CALL #multiInstance` and `CALL "FC"`, each with a parameter list (`IN := …`, `OUT := …`, and `RET_VAL := …` for an FC). They take the simulator's normal call path, so a stub stands in for the called block as in SCL. A call ends the logic string (/FC and OR are 0 afterwards, the RLO is kept).
  - Operands: locals, DB members, PLC tags, and absolute addresses (`%I0.0`) that have a PLC tag; an FC's `#RET_VAL` is its return value.
  - Refused before the block runs, with the list: everything else (TAK/PUSH/POP, OPN and absolute DB addresses, AR1/AR2, indirect addressing, pointers, a call of a block by number such as `CALL FB 10, DB 10`, UC/CC, and any instruction that reads CC0, CC1, OV, OS or BR). Refused when reached, where the manual leaves the result open: a compare inside a running logic string (start the string with it or put it in `A( … )`), a jump or a CALL inside `A( … )`, `X` right after `O` without an operand, and `NOT` while an AND before OR is pending.

## What it does not do

It is a logic simulator, not an emulation of the S7-1500 runtime: no other system instructions (communication such as TSEND, TRCV, MB_CLIENT; motion and technology objects; diagnostics such as RDREC, WRREC; data logging; `S_CONV`, `STRG_VAL`, `T_CONV`, `T_COMBINE` and VAL_STRG in exponential notation), which stop the test with their name; no GRAPH blocks, no STL beyond the instructions above, no OB scheduling or interrupts, no pointer arithmetic, no FB inheritance (EXTENDS), and timing is exactly the virtual cycle you configure. Use it for logic regression tests; validate timing and hardware behaviour in PLCSIM or on the machine.
