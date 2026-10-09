# Unit tests for SCL, LAD, FBD and STL blocks (`rung test`)

rung runs unit tests for SCL, LAD, FBD and STL function blocks and functions on an **offline simulator** — no PLC, no PLCSIM licence, works on Linux CI.

```
rung test                       # all tests/**/*.test.yaml
rung test --filter motor        # path substring or exact block name (case-insensitive)
rung test --filter Fx_Motor     # only the tests of the block Fx_Motor
rung test --filter stuck        # only the cases whose name contains "stuck"
rung test --case tests/drives/motor.test.yaml#2   # exactly the third case of that file (cases count from 0)
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
      - advance: 2s                       # run whole cycles for at least 2 s
      - expect: { Running: true }
      - set: { '"Fx_Global".Ready': true } # DB members and tags use their TIA names
      - expect: { Debounce.Q: false, Elapsed: "T#0ms" }
```

- Every case needs a nonempty `name:` unique within its file, and at least one step.
- `set` writes inputs, statics, instance members (`Timer.PT`) or globals (`"DB".member`, `"Tag"`). Array elements are addressed as `'pts[2].x'` or `'grid[1,2]'` (quote them inside `{ … }`). The value must fit the variable: `true`/`false` for BOOL, a whole number within range for integer types (40000 is refused for an Int), numbers for reals, strings within their declared length. Set arrays and structs element by element (`'Levels[1]'`, `Data.Cmd.Start`); whole lists and maps are refused.
- With several PLCs that each have a block of that name, say which: `plc: PLC_1` in the file, or keep the test under `tests/PLC_1/`. rung refuses to guess.
- `expect` compares with a small tolerance for reals; TIME values accept the same durations as `advance` (`500ms`, `T#500ms`, `2s`).
- `advance` needs a unit (`200ms`, not `200`). It runs whole cycles, rounded up, at least one: at `cycle: 10ms`, `15ms` runs two cycles and `0ms` runs one.
- `--case <file>#<n>` runs one case and nothing else: the file is still read and checked as a whole, the other cases do not run. A number past the file's cases, or a file that is not there, is an error, never "all cases". `--json` gives every case its `index` in the file.
- `--filter` matches a path substring or the exact `block:` name, case-insensitively on every platform. Paths accept `/` or `\\`. Otherwise it runs the cases whose name contains it (`--filter stuck`).
- One step may combine several keys, e.g. `- { set: { Start: true }, cycle: 1, expect: { Running: true } }`. They always run in the order `set`, `cycle`, `advance`, `expect`, whatever order they are written in. Unknown keys are rejected.
- A step runs at most 10 000 000 cycles: `advance: T#1d` at the default 10 ms is 8 640 000. For longer times, set a longer `cycle:` at the top of the file.
- For an FC, the return value is expected under the block's own name; IN_OUT parameters keep the value the FC wrote, like the caller's variable would.
- A case that stops with an error (a misspelt name in a `set`, an instruction the simulator refuses) says in which step: `step 2: Strat does not exist (did you mean Start?)`. `--json` gives that step and its line as `errorStep` and `errorLine`, so editors and GitHub annotations point at the step, not at the case. File-level YAML errors carry `errorLine` and `errorColumn` when the parser can place them.

## From the machine: a recording as a test

In VS Code's Live Values, pin an FB's inputs and outputs through its instance DB (`"Conveyor_DB".Start`, `"Conveyor_DB".Motor`) and let the machine run. *Export Recording as Test…* writes `tests/<FB>.recorded.test.yaml`: a step at each change of the inputs that sets what changed, runs as long as the machine ran until the next change and expects the outputs as they were just before it (settled, not at a cycle the PLC and the simulator count differently). From the start of the recording (the last ten minutes) or a bookmark. What the machine did yesterday is then a test that says when the code stops doing it.

## Over time: within, always, never

A machine's promises are about time: the motor runs no later than 2 s after start, the alarm holds for 5 s, the valve never opens while stopped. A step with `within`, `always` or `never` checks its `expect:` after every cycle for that long:

```yaml
      - { within: 2s, expect: { Motor: true } }      # true at some cycle within 2 s (then the next step)
      - { always: 5s, expect: { Alarm: true } }      # true after every cycle for 5 s
      - { never: 3s, expect: { Valve: true } }       # not once in 3 s
```

A broken promise says when: `step 4: Fault expected true got false (within 1s: not reached)`, `(always for 3s: broken after 2.01 s)`, `(never for 3s: happened after 2.01 s)`. `within` ends its step as soon as the expectation holds, so the next step starts from that cycle.

## What a change does to behaviour

A text diff shows what changed in the code; `rung test --against <git revision>` shows what changed in what the program does. It runs today's tests on the code as it was at that revision and as it is now, and lists every case where the block's values after a step differ, with the first difference:

```
rung test --against main
behaviour against main (5 cases):
  tests/conveyor.test.yaml: a contactor that does not answer within 2 s is a fault until reset (passed then, failed now)
     step 8: Motor FALSE → TRUE (first of 2 differences)
1 case behaves differently, 4 the same
```

`--json` gives every difference, for a pull request comment or a review page.

## Stubs

What the simulator does not model (communication, diagnostics, data logging, motion, technology objects, a block the workspace does not have) stops a test with its name. Before running a file, rung lists the missing stubs in its block’s call graph, including calls through other workspace blocks; a stubbed block ends that search. A test can stand in for it with `stubs:`, a map from the name to the values its outputs start with:

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
  - A stub the cases never called gets a warning: a typo, or code they do not reach. This warning is suppressed when a case stopped with an error.
  - Refused like the rest of the file: a name nothing in the workspace calls or declares (with the closest one), a member a known type does not have, a value its declared type cannot hold, and the block under test itself.

## Debugging a case

A case runs in the debugger like a program: breakpoints in the SCL blocks it calls (with conditions such as `#speed > 100`), step over, into and out of calls, the block's variables and the data blocks, and expressions in the Debug Console. A value changed while stopped stays changed when you step on. A case that fails stops before it ends, with the reason: where the failed expectation's values are (after the cycles before its step), or at the statement that raised an error. A breakpoint on a line without a statement (`ELSE`, `END_IF`) moves to the next statement; one on a declaration is marked as not stopping. Values set while stopped are checked like a test's `set:` (a number out of range, text into a number, a whole structure are refused). In VS Code, *Debug Test* in the test explorer (or the gutter of a case) starts it; `rung debug` is the Debug Adapter Protocol server behind it, for nvim-dap and other editors (launch with `test`, `case` from 0, `stopOnEntry`).

**Why?** While stopped, right-click a variable (or select a name in the code) and pick *Why?*: rung shows the statement that last wrote it, with the time of that cycle, the values its operands had just before it ran (each explained in turn, three levels deep), and the IF or CASE branch that made it run, with that condition's value. A value no statement wrote says so: an input the test set, a start value, or something a call wrote inside. The writes are found by where the value lives, so `"Pump_DB".Running` and `#Running` inside the FB are the same value. In Neovim: `:Rung why`. The copy button on the view puts the answer on the clipboard as Markdown, each statement with its file and line, for a report or a ticket.

Stepping goes backwards too: *Step Back* and *Reverse Continue*. A case is deterministic (its inputs come from the steps, its time from its cycles), so rung runs it again from the start to the statement before. *Step Out* in the block the test calls goes on to its next cycle. While stopped, the values of `#names` show next to the code, and the stopped event shows the virtual time of the cycle. LAD/FBD networks run without stopping inside them.
## Recording expectations

Writing `expect:` by hand means knowing the values first. *Record Expectations* (right-click in a test file, on a step with `cycle:` or `advance:`) runs the case, lists the block's outputs and statics after that step, and writes the ones you pick into the step's `expect:`. Nothing is written that you did not pick; a value that differs from the one already expected is shown with both. `rung test --case <file#n> --json --observe` gives the same values to scripts and other editors.
## Coverage

`rung test --coverage lcov.info` also writes which SCL lines the cases ran, as an lcov file for CI tools (Codecov, GitLab, SonarQube), and prints how much of the program ran. Every block the simulator can run counts, tested or not: a block no test calls shows as not run. In VS Code, *Run with Coverage* in the test explorer marks the lines in the editor and fills the Test Coverage view. Lines, not branches: an IF counts as run when its condition was evaluated; the lines inside show whether its branches ran. LAD, FBD and STL blocks and DB start values are not counted.
## What the simulator covers

- SCL statements: assignment (also `a := b := 0;`), IF/ELSIF/ELSE, CASE (lists, ranges), FOR/WHILE/REPEAT with EXIT/CONTINUE, RETURN, REGION, GOTO to a label.
- Expressions with SCL precedence, integer vs. real division, typed literals (`16#FF`, `T#1s`, `DINT#5`); integers wrap around on overflow like on an S7-1500 (32767 + 1 = -32768 in an Int).
- REAL literals, arithmetic intermediates, conversions and storage use IEEE single precision in both dialects; LREAL keeps double precision. REAL/LREAL to integer conversions and ROUND use half-to-even in Siemens sources (`.scl`, `.db`, SD/SimaticML), half-away-from-zero in IEC sources (`.st`, TwinCAT POUs). IEC BOOL-to-STRING uses `TRUE`/`FALSE`; numeric string conversions accept `16#`, `8#`, `2#`, type prefixes and `_` separators.
- 64-bit integers (LINT, ULINT, LWORD) bit for bit, or not at all: arithmetic, AND/OR/XOR/NOT and shifts are computed exactly and cut to the width of the type (SHL of an LWORD by 64 is 0). The simulator holds a value exactly up to 2^53, and beyond that only where a double holds it (2^63, 16#FF00_0000_0000_0000). A result or a literal it cannot hold exactly (2^53 + 1, NOT 0 of an LWORD, `LWORD#16#FFFF_FFFF_FFFF_FFFF`) stops the test with the value instead of losing its low bits.
- TwinCAT / CODESYS structured text: PROGRAMs, FBs with METHODs and `THIS^`, PROPERTYs (GET and SET, each with its own locals), ACTIONs, enumerations (`E_State.Idle`, `E_State#Idle`, bare `Idle`), `POINTER TO` with `ADR` and `^`, `REFERENCE TO` with `REF=`, bit reads and writes (`word.3`; SCL uses `word.%X3`). IEC DWORD shifts use the count modulo 32, as on the recorded CODESYS simulation target (over-width shifts are target-dependent); Siemens shifts keep the full count.
- User FBs (single and multi-instance), FCs, global DBs (including UDT members and start values), PLC tags.
- IEC standard FBs with virtual time: TON/TOF/TP (and `_TIME`/`_LTIME`), CTU/CTD/CTUD, R_TRIG/F_TRIG, SR/RS; standard functions (LIMIT, MIN/MAX, SEL, MUX, math, shifts, `*_TO_*` conversions; strings: CONCAT, LEN, LEFT, RIGHT, MID, FIND, DELETE, INSERT, REPLACE).
  - ROL/ROR rotate within the operand's width, with counts modulo that width. EXPT accepts numeric operands and returns floating point (LREAL for IEC sources); zero to a negative power is refused because its result is platform-dependent. Negative bases with fractional exponents give NaN; Siemens also gives NaN for nonpositive bases with REAL/LREAL exponents.
  - IEC counters accept `RESET`/`LOAD` (Siemens uses `R`/`LD`); IEC SR/RS accept `SET1`/`RESET` and `SET`/`RESET1`. CTU counts past PV; IEC CTD stops at zero, and simultaneous CTUD edges cancel. IEC string edges follow the corpus: INSERT at P = 0 prepends, DELETE past the end preserves the input, REPLACE at P = 0 prepends, FIND of an empty search returns 0. Siemens string checks are unchanged.
- System instructions, as the TIA Portal help describes them:
  - `SWAP` of a WORD, DWORD or LWORD (an integer of that width bit for bit; an LWORD result a double cannot hold, see above, stops the test).
  - `RD_SYS_T` and `RD_LOC_T` into a DTL, DT or LDT. The virtual clock starts at 2024-01-01 00:00:00 (a Monday) and runs with the virtual time; it has no time zone, so both read the same. `RUNTIME`: the virtual seconds since the last call with the same MEM (code takes no time, so 0 within one cycle).
  - `T_DIFF` of two DTL, DT, LDT, TOD or LTOD; `T_ADD` and `T_SUB` of a TIME to a TIME, LTIME, TOD, LTOD, DT, LDT or DTL. A DTL nobody set is DTL#1970-01-01-00:00:00.
  - `IS_ARRAY`, `CountOfElements`, `LOWER_BOUND`, `UPPER_BOUND`; `MOVE_BLK`, `UMOVE_BLK`, `FILL_BLK`, `UFILL_BLK` element by element (structures are copied).
  - `VAL_STRG` in decimal notation: right-aligned in SIZE characters (SIZE 0: as many as needed), PREC decimals (an integer gets its decimal point PREC places from the right), FORMAT's separator and sign bits.
  - VARIANT and ARRAY[*] parameters (inputs, outputs and in/outs) are bound to the caller's variable by its place (it stays bound when the structure or array around it is assigned anew during the call) and know its declared type: `TypeOf` and `TypeOfElements` compared with a data type (`TypeOf(#in) = Int`, `TypeOfElements(#a) = "UDT_X"`, `CASE TypeOf(#in) OF Int: …`) or with each other, `VariantGet`, `VariantPut`, `MOVE_BLK_VARIANT` (SRC_INDEX and DEST_INDEX count from 0 whatever the low bound; a variable that is no array is one element; returns 0), `CountOfElements`, and `IS_NULL` / `NOT_NULL` of a REF_TO or VARIANT.
  - Where the PLC's result is not modelled, the test stops and says why instead of guessing: a TIME beyond ±24 days, a TOD past midnight, overlapping or too long block moves, VAL_STRG into the middle of a string or wider than SIZE, an ARRAY of BOOL for CountOfElements, TypeOf of an ARRAY (use TypeOfElements), copies between two data types, multi-dimensional arrays for MOVE_BLK_VARIANT.
- LAD blocks mirrored as SIMATIC SD (`.s7dcl`): each network becomes the same graph of parts and wires TIA Portal keeps in SimaticML and runs through the same translation, so everything listed below for SimaticML runs in SD too (edge contacts and coils, P_TRIG, SR and RS, ENO, branches); the same tests give the same results on TIA Portal's SD and SimaticML exports of one block. A block with anything else is refused with the element as SD writes it.
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
